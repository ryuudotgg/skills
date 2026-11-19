import { mergeFeed, parseFeed, parseSync, type FeedEvent, type SyncState } from "skills-core";

export type FeedStatus =
  | { kind: "loading" }
  | { kind: "live" }
  | { kind: "unauthorized" }
  | { kind: "unreachable"; reason: string };

export type FeedSnapshot = { events: readonly FeedEvent[]; status: FeedStatus; checked: number };

export type Fetch = (path: string, init: RequestInit) => Promise<Response>;

export type FeedOptions = {
  token: string | undefined;
  fetch: Fetch;
  clock: () => number;
  every: number;
  onChange: (snapshot: FeedSnapshot) => void;
};

export function initialSnapshot(clock: () => number): FeedSnapshot {
  return { events: [], status: { kind: "loading" }, checked: clock() };
}

export function authorized(fetch: Fetch, token: string | undefined): Fetch {
  return (path, init) =>
    fetch(path, { ...init, headers: { ...init.headers, Authorization: `Bearer ${token ?? ""}` } });
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function feedPath(cursor: string | undefined, generation: string | undefined): string {
  if (cursor === undefined) return "/feed";

  const query = new URLSearchParams({ after: cursor });
  if (generation !== undefined) query.set("gen", generation);
  return `/feed?${query}`;
}

export function startFeed(options: FeedOptions): () => void {
  const fetch = authorized(options.fetch, options.token);
  let snapshot = initialSnapshot(options.clock);

  let cursor: string | undefined;
  let generation: string | undefined;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (next: Partial<FeedSnapshot>) => {
    snapshot = { ...snapshot, ...next, checked: options.clock() };
    options.onChange(snapshot);
  };

  const poll = async (): Promise<void> => {
    const response = await fetch(feedPath(cursor, generation), {});
    if (response.status === 401) {
      stopped = true;
      return publish({ status: { kind: "unauthorized" } });
    }

    if (response.status === 410 && cursor !== undefined) {
      cursor = undefined;
      generation = undefined;
      snapshot = { ...snapshot, events: [] };
      return poll();
    }

    if (!response.ok) {
      const reason = (await response.text()).trim() || `HTTP ${response.status}`;
      return publish({ status: { kind: "unreachable", reason } });
    }

    const fresh = parseFeed(await response.text());
    cursor = fresh.at(-1)?.id ?? cursor;
    generation = response.headers.get("X-Feed-Generation") ?? undefined;
    publish({ events: mergeFeed(snapshot.events, fresh), status: { kind: "live" } });
  };

  const loop = async () => {
    if (stopped) return;

    try {
      await poll();
    } catch (error) {
      publish({ status: { kind: "unreachable", reason: reasonOf(error) } });
    }

    if (!stopped) timer = setTimeout(loop, options.every);
  };

  void loop();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

type PollOptions<T> = Pick<FeedOptions, "token" | "fetch" | "every"> & {
  onChange: (value: T) => void;
};

function startPoll<T>(
  path: string,
  parse: (text: string) => T,
  options: PollOptions<T>,
): () => void {
  const fetch = authorized(options.fetch, options.token);
  let held: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const poll = async () => {
    const response = await fetch(path, {});
    if (!response.ok) return;

    const text = await response.text();
    if (text === held) return;

    const value = parse(text);
    held = text;
    options.onChange(value);
  };

  const loop = async () => {
    if (stopped) return;
    await poll().catch(() => undefined);
    if (!stopped) timer = setTimeout(loop, options.every);
  };

  void loop();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

export type WithheldOptions = PollOptions<readonly string[]>;

export function startWithheld(options: WithheldOptions): () => void {
  return startPoll("/withheld", (text) => text.split("\n").filter((line) => line !== ""), options);
}

export type SyncOptions = PollOptions<SyncState>;

export function startSync(options: SyncOptions): () => void {
  return startPoll("/sync", parseSync, options);
}
