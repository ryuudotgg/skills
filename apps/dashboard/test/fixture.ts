import {
  compareEvents,
  secondStamp,
  trailEntry,
  type FeedEvent,
  type IndexRow,
  type RowType,
  type StorePayloads,
} from "skills-core";

type Host = "claude" | "codex" | "opencode";

export type Payloads = Pick<
  StorePayloads,
  | "session"
  | "session-stats"
  | "pr"
  | "round"
  | "revision"
  | "eval"
  | "hook-block"
  | "issue"
  | "issue-link"
> & {
  machine: { label: string };
  heartbeat: { branch: string; session: string | null };
  "lease-conflict": { holder: string; claimant: string };
  transcript: { host: Host; session: string; digest: string };
  policy: { policy: "full" | "redacted" | "stats" | "off" };
  digest: { week: string; sections: { title: string; lines: string[] }[] };
};

export type StoredType = keyof Payloads;

export type TrailVerb = "start" | "review" | "handback" | "done" | "thread" | "wave";

export const now = Date.parse("2026-11-06T12:00:00Z");

export const cut = "2026-11-03T12:00:00Z";

export const machines = {
  studio: "5d1e0c3a-7b42-4f19-9a6e-2c8d4b7f1a03",
  laptop: "a7c4e912-3f58-4d0b-8e21-6b9f0d3c5e47",
} as const;

type From = { from?: string };

type Plan = Omit<IndexRow, "updated">;

function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function wallOf(at: string): number {
  return Date.parse(`2026-${at}:00Z`);
}

function idOf(wall: number, counter: number, machine: string): string {
  const time = wall.toString(16).padStart(12, "0");
  const position = counter.toString(16).padStart(3, "0");
  const node = machine.replaceAll("-", "").slice(0, 12);
  return `${time.slice(0, 8)}-${time.slice(8)}-7${position}-8000-${node}`;
}

function feedEvent(
  at: string,
  from: string,
  place: { project: string; plan: string; type: string; payload: unknown },
): FeedEvent {
  const wall = wallOf(at);
  return {
    id: idOf(wall, 0, from),
    machine: from,
    wall,
    counter: 0,
    ts: secondStamp(wall),
    legacy: false,
    ...place,
  };
}

export function row(
  at: string,
  project: string,
  plan: Plan,
  { type = "row", from = machines.studio }: From & { type?: RowType } = {},
): FeedEvent {
  const updated = secondStamp(wallOf(at)).slice(0, 10);
  return feedEvent(at, from, {
    project,
    plan: plan.id,
    type,
    payload: { row: { ...plan, updated } },
  });
}

export function trail(
  at: string,
  project: string,
  id: string,
  event: TrailVerb,
  detail: string,
  { from = machines.studio }: From = {},
): FeedEvent {
  const entry = trailEntry({ ts: secondStamp(wallOf(at)), project, id, event, detail });
  return feedEvent(at, from, {
    project,
    plan: id,
    type: event,
    payload: { detail: entry.detail, line: entry.line },
  });
}

export function stored<T extends StoredType>(
  at: string,
  project: string,
  plan: string,
  type: T,
  payload: Payloads[T],
  { from = machines.studio }: From = {},
): FeedEvent {
  return feedEvent(at, from, { project, plan, type, payload });
}

function transition(
  at: string,
  project: string,
  plan: Plan,
  event: TrailVerb,
  options: From = {},
): FeedEvent[] {
  return [
    row(at, project, plan, options),
    trail(at, project, plan.id, event, plan.branch, options),
  ];
}

function todo(id: string, slug: string, pri: string, effort: string, blocked_by = "-"): Plan {
  return { id, slug, status: "TODO", pri, effort, blocked_by, ctx: "-", branch: "-", note: "-" };
}

function stamped(declared: readonly FeedEvent[]): FeedEvent[] {
  const tally = new Map<string, number>();

  const counted = declared.map((event) => {
    const key = `${event.wall} ${event.machine}`;
    const counter = tally.get(key) ?? 0;

    tally.set(key, counter + 1);
    return { ...event, counter, id: idOf(event.wall, counter, event.machine) };
  });

  return counted.sort(compareEvents);
}

const r1 = `---
id: 002
slug: feed
project: Alpha
pri: P1
effort: M
blocked_by: -
---

# 002 feed

## Outcome

The dashboard serves the plans feed on 127.0.0.1.
`;

const r2 = `${r1}
## Landed

Branch feat/feed, not merged yet.
The feed answers NDJSON past a cursor.
`;

const s1Digest = `## Prompts

Implement the feed
Read the hub token from [redacted:env] when the test needs it.

## Final replies

Feed served on 127.0.0.1

## Tools

Bash 20, Edit 10

## Tokens

80000 in 5000 out
`;

export const blobs: ReadonlyMap<string, string> = new Map(
  [r1, r2, s1Digest].map((text) => [sha256(text), text]),
);

const shell = todo("001", "shell", "P1", "S");
const feed = todo("002", "feed", "P1", "M");
const board = todo("003", "board", "P2", "M", "002");
const lint = todo("004", "lint", "P2", "S");
const sync = todo("001", "sync", "P1", "L");

const laptop = { from: machines.laptop };

function revision(at: string, path: string, text: string): FeedEvent {
  const digest = sha256(text);
  return stored(at, "Alpha", "002", "revision", {
    path,
    sha256: digest,
    captured: secondStamp(wallOf(at)),
    size: new TextEncoder().encode(text).length,
    blob: digest.slice(0, 32),
  });
}

function session(at: string, id: string, options: From = {}): FeedEvent {
  return stored(
    at,
    "Alpha",
    "002",
    "session",
    {
      host: "claude",
      session: id,
      branch: "feat/feed",
      plans: ["002"],
      source: "scan",
      started: secondStamp(wallOf(at)),
    },
    options,
  );
}

function sessionStats(
  at: string,
  id: string,
  spend: { model: string; in: number; out: number; tools: Record<string, number> },
  options: From = {},
): FeedEvent {
  const stamp = secondStamp(wallOf(at));
  return stored(
    at,
    "Alpha",
    "002",
    "session-stats",
    {
      host: "claude",
      session: id,
      models: { [spend.model]: { effort: "-", in: spend.in, out: spend.out } },
      tools: spend.tools,
      records: Object.values(spend.tools).reduce((sum, count) => sum + count, 0),
      start: stamp,
      end: stamp,
      subagents: 0,
    },
    options,
  );
}

function round(at: string, reviewer: string, outcome: "fixed" | "dismissed", verdict: string) {
  return stored(at, "Alpha", "002", "round", {
    pr: 12,
    branch: "feat/feed",
    head: "abc1234",
    outcomes: { [reviewer]: outcome },
    verdict,
  });
}

function evalRun(at: string, run: Omit<Payloads["eval"], "case">, options: From): FeedEvent {
  return stored(at, "-", "-", "eval", { case: "plans-new-preflight", ...run }, options);
}

const digestSections: Payloads["digest"]["sections"] = [
  { title: "Closes", lines: ["Alpha 001 shell"] },
  { title: "Phase times", lines: ["queue 1 h, build 6 h, review 18 h", "prior week: no closes"] },
  { title: "Came back from review", lines: ["-"] },
  { title: "Recurring hook blocks", lines: ["-"] },
  { title: "Slowest phase", lines: ["review 18 h, Alpha 001 shell"] },
  { title: "Token spend", lines: ["opus 80000 in 5000 out", "sonnet 40000 in 3000 out"] },
  { title: "Eval regressions", lines: ["plans-new-preflight FAIL 2/3, passed before"] },
  { title: "Lessons for /plans new", lines: ["Alpha 004 lint: -"] },
];

export const events: readonly FeedEvent[] = stamped([
  stored("11-01T08:00", "-", "-", "machine", { label: "studio" }),
  stored("11-02T08:00", "-", "-", "machine", { label: "laptop" }, laptop),

  row("11-01T09:00", "Alpha", shell, { type: "added" }),
  ...transition(
    "11-01T10:00",
    "Alpha",
    { ...shell, status: "DOING", branch: "feat/shell" },
    "start",
  ),
  ...transition(
    "11-01T16:00",
    "Alpha",
    { ...shell, status: "REVIEW", branch: "feat/shell" },
    "handback",
  ),
  ...transition("11-02T10:00", "Alpha", { ...shell, status: "DONE", branch: "feat/shell" }, "done"),

  row("11-01T09:00", "Alpha", feed, { type: "added" }),
  revision("11-01T09:00", "Alpha/002-feed.md", r1),
  ...transition("11-03T09:00", "Alpha", { ...feed, status: "DOING", branch: "feat/feed" }, "start"),
  trail("11-03T13:00", "Alpha", "002", "thread", "t-feed"),
  session("11-03T13:05", "s-1", laptop),
  sessionStats(
    "11-03T13:05",
    "s-1",
    { model: "opus", in: 80000, out: 5000, tools: { Bash: 20, Edit: 10 } },
    laptop,
  ),
  stored(
    "11-03T13:05",
    "Alpha",
    "002",
    "transcript",
    { host: "claude", session: "s-1", digest: sha256(s1Digest) },
    laptop,
  ),
  stored("11-04T10:00", "Alpha", "002", "pr", {
    pr: 12,
    branch: "feat/feed",
    state: "open",
    head: "abc1234",
    verdict: "green",
    failing: [],
  }),
  session("11-04T09:00", "s-2"),
  sessionStats("11-04T09:00", "s-2", {
    model: "sonnet",
    in: 40000,
    out: 3000,
    tools: { Bash: 8, Read: 4 },
  }),
  round("11-04T11:00", "coderabbit", "fixed", "rereview"),
  round("11-04T11:05", "greptile", "dismissed", "done"),
  revision("11-04T12:00", "Alpha/002-feed.md", r2),
  stored("11-06T11:55", "Alpha", "002", "heartbeat", { branch: "feat/feed", session: "s-2" }),

  row("11-01T09:00", "Alpha", board, { type: "added" }),

  row("11-01T09:00", "Alpha", lint, { type: "added" }),
  trail("11-04T09:00", "Alpha", "004", "wave", "claude/opus high"),
  ...transition("11-04T09:00", "Alpha", { ...lint, status: "DOING", branch: "feat/lint" }, "start"),
  ...transition(
    "11-04T15:00",
    "Alpha",
    { ...lint, status: "REVIEW", branch: "feat/lint" },
    "handback",
  ),
  trail("11-05T09:00", "Alpha", "004", "review", "feat/lint"),
  trail("11-05T12:00", "Alpha", "004", "handback", "feat/lint"),
  trail("11-05T14:00", "Alpha", "004", "review", "feat/lint"),
  trail("11-05T16:00", "Alpha", "004", "handback", "feat/lint"),
  trail("11-06T09:00", "Alpha", "004", "review", "feat/lint"),
  stored("11-06T10:00", "Alpha", "004", "pr", {
    pr: 9,
    branch: "feat/lint",
    state: "merged",
    head: "def5678",
    verdict: null,
    failing: [],
  }),

  row("11-02T09:00", "Beta", sync, { type: "added" }),
  ...transition(
    "11-05T09:00",
    "Beta",
    { ...sync, status: "DOING", branch: "feat/sync" },
    "start",
    laptop,
  ),
  stored(
    "11-06T10:00",
    "Beta",
    "001",
    "lease-conflict",
    { holder: machines.studio, claimant: machines.laptop },
    laptop,
  ),
  stored("11-06T10:30", "Beta", "001", "heartbeat", { branch: "feat/sync", session: null }, laptop),

  stored("11-05T09:00", "Beta", "#1", "issue", {
    n: 1,
    title: "needs sync API",
    body: "Alpha 003 reads the sync state through an API Beta does not expose yet.",
    from: null,
  }),
  row("11-05T09:01", "Alpha", { ...board, blocked_by: "002,Beta#1" }),
  stored("11-05T09:01", "Beta", "#1", "issue-link", { ref: "Alpha/003", kind: "blocks" }),

  stored("11-03T08:00", "Alpha", "-", "policy", { policy: "redacted" }),

  stored("11-04T10:30", "Alpha", "002", "hook-block", {
    rules: ["reply-guard/dash"],
    host: "claude",
  }),
  stored("11-05T10:30", "Alpha", "004", "hook-block", {
    rules: ["reply-guard/dash"],
    host: "claude",
  }),
  stored("11-05T11:00", "Alpha", "004", "hook-block", {
    rules: ["commit-guard/commit-shape"],
    host: "codex",
  }),

  evalRun(
    "11-03T14:00",
    {
      models: ["opus"],
      roster: "claude codex",
      exit: 0,
      verdict: "pass",
      grade: "PASS 3/3",
      duration: 600000,
    },
    { from: machines.studio },
  ),
  evalRun(
    "11-05T12:00",
    {
      models: ["sonnet", "opus"],
      roster: "claude",
      exit: 0,
      verdict: "fail",
      grade: "FAIL 2/3",
      duration: 720000,
    },
    laptop,
  ),

  stored("11-06T08:00", "-", "-", "digest", { week: "2026-W45", sections: digestSections }),
]);
