import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { compareEvents, eventFrom, foldRows, parseTime, type FeedEvent } from "skills-core";
import { blobs, cut, events, machines, now, type Payloads, type StoredType } from "./fixture.ts";

function label(event: FeedEvent): string {
  return `${event.project} ${event.plan} ${event.type}`;
}

function cutWall(): number {
  const wall = parseTime(cut);
  if (wall === undefined) throw new Error(`cut ${cut} does not parse`);
  return wall;
}

function blob(sha256: unknown): string {
  const text = typeof sha256 === "string" ? blobs.get(sha256) : undefined;
  if (text === undefined) throw new Error(`no blob ${String(sha256)}`);
  return text;
}

function payload(event: FeedEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function typed<T extends StoredType>(event: FeedEvent, type: T): Payloads[T] {
  if (event.type !== type) throw new Error(`event ${event.id} is ${event.type}, not ${type}`);
  return event.payload as Payloads[T];
}

describe("fixture shape", () => {
  test("every event decodes and ids are unique", () => {
    const ids = new Set(events.map((event) => event.id));

    expect(ids.size).toBe(events.length);

    for (const event of events) {
      expect(event.id).toMatch(/^[0-9a-f-]{1,64}$/);
      expect(() => eventFrom(event)).not.toThrow();
    }
  });

  test("events sit in compareEvents order with no ties", () => {
    for (const [index, event] of events.entries()) {
      const next = events[index + 1];
      if (next) expect(compareEvents(event, next)).toBe(-1);
    }
  });

  test("store only types decode as stored events", () => {
    const kinds = new Map(events.map((event) => [event.type, eventFrom(event).kind]));
    for (const type of ["machine", "session", "revision", "issue", "issue-link", "policy", "eval"])
      expect(kinds.get(type)).toBe("stored");

    expect(kinds.get("added")).toBe("row");
    expect(kinds.get("wave")).toBe("trail");
  });

  test("now sits after every event", () => {
    expect(events.every((event) => event.wall <= now)).toBe(true);
  });
});

describe("at the cut", () => {
  const kept = events.filter((event) => event.wall <= cutWall());

  test("keeps exactly the spec's list", () => {
    expect(kept.map(label)).toEqual([
      "- - machine",
      "Alpha 001 added",
      "Alpha 002 added",
      "Alpha 002 revision",
      "Alpha 003 added",
      "Alpha 004 added",
      "Alpha 001 row",
      "Alpha 001 start",
      "Alpha 001 row",
      "Alpha 001 handback",
      "- - machine",
      "Beta 001 added",
      "Alpha 001 row",
      "Alpha 001 done",
      "Alpha - policy",
      "Alpha 002 row",
      "Alpha 002 start",
    ]);
  });

  test("the machine events label studio then laptop", () => {
    const labels = kept
      .filter((event) => event.type === "machine")
      .map((event) => [event.machine, payload(event).label]);

    expect(labels).toEqual([
      [machines.studio, "studio"],
      [machines.laptop, "laptop"],
    ]);
  });

  test("rows fold to the spec's board", () => {
    const projects = foldRows(kept.map(eventFrom));
    const rows = [...projects].flatMap(([project, rows]) =>
      [...rows.values()].map((row) => `${project} ${row.id} ${row.status} ${row.branch}`),
    );

    expect(rows).toEqual([
      "Alpha 001 DONE feat/shell",
      "Alpha 002 DOING feat/feed",
      "Alpha 003 TODO -",
      "Alpha 004 TODO -",
      "Beta 001 TODO -",
    ]);
  });

  test("Alpha 002 starts from studio", () => {
    const start = kept.find((event) => label(event) === "Alpha 002 start");
    expect(start?.machine).toBe(machines.studio);
  });
});

describe("without a time", () => {
  test("session stats total 120000 in and 8000 out", () => {
    const tokens = events
      .filter((event) => event.type === "session-stats")
      .flatMap((event) => Object.values(typed(event, "session-stats").models));

    expect(tokens.reduce((sum, model) => sum + (model.in ?? 0), 0)).toBe(120000);
    expect(tokens.reduce((sum, model) => sum + (model.out ?? 0), 0)).toBe(8000);
  });

  test("Alpha 004 has three reviews after its first handback", () => {
    const trail = events.filter((event) => event.project === "Alpha" && event.plan === "004");
    const firstHandback = trail.findIndex((event) => event.type === "handback");
    const reviews = trail.slice(firstHandback).filter((event) => event.type === "review");

    expect(firstHandback).toBeGreaterThan(-1);
    expect(reviews).toHaveLength(3);
  });

  test("every blob key is the sha256 of its text", () => {
    expect(blobs.size).toBe(3);

    for (const [key, text] of blobs)
      expect(createHash("sha256").update(text).digest("hex")).toBe(key);
  });

  test("r2 lands feat/feed unmerged", () => {
    const revisions = events.filter((event) => event.type === "revision");
    const [r1, r2] = revisions.map((event) => blob(payload(event).sha256));
    const landed = r2?.split("\n## Landed\n")[1]?.trim().split("\n")[0];

    expect(revisions).toHaveLength(2);
    expect(r2?.startsWith(r1 ?? "\u0000")).toBe(true);
    expect(r1).not.toContain("## Landed");
    expect(landed).toBe("Branch feat/feed, not merged yet.");
  });

  test("the s-1 transcript names its redacted digest", () => {
    const transcripts = events.filter((event) => event.type === "transcript");
    const [transcript] = transcripts;
    if (!transcript) throw new Error("the fixture holds no transcript event");

    const digest = blob(typed(transcript, "transcript").digest);

    expect(transcripts.map((event) => [event.machine, payload(event).session])).toEqual([
      [machines.laptop, "s-1"],
    ]);

    expect(digest).toContain("Implement the feed");
    expect(digest.split("[redacted:env]")).toHaveLength(2);
    expect(digest).toContain("Feed served on 127.0.0.1");
    expect(digest).toContain("Bash 20, Edit 10");
    expect(digest).toContain("80000 in 5000 out");
  });
});
