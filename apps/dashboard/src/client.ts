import { mergeFeed, parseFeed, type FeedEvent } from "skills-core";

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

export function startFeed(options: FeedOptions): () => void {
  const fetch = authorized(options.fetch, options.token);
  let snapshot = initialSnapshot(options.clock);
  let cursor: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const publish = (next: Partial<FeedSnapshot>) => {
    snapshot = { ...snapshot, ...next, checked: options.clock() };
    options.onChange(snapshot);
  };

  const poll = async (): Promise<void> => {
    const query = cursor === undefined ? "" : `?after=${encodeURIComponent(cursor)}`;
    const response = await fetch(`/feed${query}`, {});
    if (response.status === 401) {
      stopped = true;
      return publish({ status: { kind: "unauthorized" } });
    }

    if (response.status === 410 && cursor !== undefined) {
      cursor = undefined;
      snapshot = { ...snapshot, events: [] };
      return poll();
    }

    if (!response.ok) {
      const reason = (await response.text()).trim() || `HTTP ${response.status}`;
      return publish({ status: { kind: "unreachable", reason } });
    }

    const fresh = parseFeed(await response.text());
    cursor = fresh.at(-1)?.id ?? cursor;
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

export type WithheldOptions = Pick<FeedOptions, "token" | "fetch" | "every"> & {
  onChange: (keys: readonly string[]) => void;
};

export function startWithheld(options: WithheldOptions): () => void {
  const fetch = authorized(options.fetch, options.token);
  let held: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const poll = async () => {
    const response = await fetch("/withheld", {});
    if (!response.ok) return;

    const text = await response.text();
    if (text === held) return;

    held = text;
    options.onChange(text.split("\n").filter((line) => line !== ""));
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
