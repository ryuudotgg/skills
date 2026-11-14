import { expect, test } from "bun:test";
import type { AuthoredEvent } from "skills-core";
import {
  authored,
  count,
  currentKey,
  enroll,
  hubPool,
  push,
  revoke,
  rotate,
  send,
} from "./harness.ts";
import { recordStatements } from "./statements.ts";

const { vault } = hubPool();

function flipped(event: AuthoredEvent): AuthoredEvent {
  const signature = new Uint8Array(event.signature);
  signature[0] = (signature[0] ?? 0) ^ 1;
  return { ...event, signature };
}

test("refuses an envelope below the current epoch", async () => {
  const v = await vault();
  const old = currentKey(v);
  await rotate(v);

  const stale = await push(v, v.founder, [await authored(v.founder, old, { type: "start" })]);

  expect([stale.status, stale.json.reason, stale.json.epoch]).toEqual([
    409,
    "epoch-below-current",
    2,
  ]);

  expect(count(v.hub, "events")).toBe(0);
});

test("refuses a bad author signature", async () => {
  const v = await vault();
  const event = await authored(v.founder, currentKey(v), { type: "start" });

  const refused = await push(v, v.founder, [flipped(event)]);

  expect([refused.status, refused.json.reason, refused.json.event]).toEqual([
    409,
    "event-signature",
    event.id,
  ]);
});

test("a duplicate author sequence answers 409", async () => {
  const v = await vault();
  const first = await authored(v.founder, currentKey(v), { type: "start" });
  v.founder.tail = undefined;
  const second = await authored(v.founder, currentKey(v), { type: "close" });

  expect((await push(v, v.founder, [first])).status).toBe(200);
  const duplicate = await push(v, v.founder, [second]);

  expect([duplicate.status, duplicate.json.reason, duplicate.json.existing]).toEqual([
    409,
    "sequence-taken",
    first.id,
  ]);
});

test("a resent batch returns the same hub_seq", async () => {
  const v = await vault();
  const batch = [
    await authored(v.founder, currentKey(v), { type: "start" }),
    await authored(v.founder, currentKey(v), { type: "note" }),
  ];

  const first = await push(v, v.founder, batch);
  const again = await push(v, v.founder, batch);
  await v.hub.restart();
  const restarted = await push(v, v.founder, batch);

  expect(first.status).toBe(200);
  expect(again.json.accepted).toEqual(first.json.accepted);
  expect(restarted.json.accepted).toEqual(first.json.accepted);
  expect(count(v.hub, "events")).toBe(2);
});

test("a refused batch stores none of its events", async () => {
  const v = await vault();
  const good = await authored(v.founder, currentKey(v), { type: "start" });
  const bad = flipped(await authored(v.founder, currentKey(v), { type: "note" }));

  expect((await push(v, v.founder, [good, bad])).status).toBe(409);
  expect(count(v.hub, "events")).toBe(0);
});

test("a normal push carries only the signer's own events", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");
  const event = await authored(laptop, currentKey(v), { type: "start" });

  const relayed = await push(v, v.founder, [event]);

  expect([relayed.status, relayed.json.reason]).toEqual([409, "event-not-own"]);
});

test("history accepts an older epoch with a valid author entry", async () => {
  const v = await vault();
  const old = currentKey(v);
  const event = await authored(v.founder, old, { type: "start" });
  await rotate(v);

  const normal = await push(v, v.founder, [event]);
  const history = await push(v, v.founder, [event], true);

  expect(normal.json.reason).toBe("epoch-below-current");
  expect(history.status).toBe(200);
  expect((await push(v, v.founder, [], true)).json.authors).toEqual({ [v.founder.id]: 1 });
});

test("history refuses a revoked author past its cutoff", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");
  const key = currentKey(v);
  const first = await authored(laptop, key, { type: "start" });
  const second = await authored(laptop, key, { type: "note" });

  const committed = laptop.tail;
  const third = await authored(laptop, key, { type: "close" });

  expect((await push(v, laptop, [first])).status).toBe(200);
  laptop.tail = committed;
  expect((await revoke(v, laptop)).status).toBe(200);

  const within = await push(v, v.founder, [second], true);
  const past = await push(v, v.founder, [third], true);

  expect(within.status).toBe(200);
  expect([past.status, past.json.reason]).toEqual([409, "event-cutoff"]);
});

test("a page holds committed events in hub_seq order with the head", async () => {
  const v = await vault();
  const events = [
    await authored(v.founder, currentKey(v), { type: "start" }),
    await authored(v.founder, currentKey(v), { type: "note" }),
    await authored(v.founder, currentKey(v), { type: "close" }),
  ];

  await push(v, v.founder, events);
  const page = await send(v.hub, v.founder, "GET", "/v1/events?after=1&limit=1");

  expect(page.status).toBe(200);
  expect(page.json.head).toBe(3);
  expect(page.json.incarnation).toBe(v.hub.incarnation);
  expect(
    (page.json.events as { id: string; hub_seq: number }[]).map((event) => [
      event.hub_seq,
      event.id,
    ]),
  ).toEqual([[2, events[1]?.id ?? ""]]);
});

test("history reports each author's contiguous run, not its highest sequence", async () => {
  const v = await vault();
  const key = currentKey(v);
  const first = await authored(v.founder, key, { type: "start" });
  await authored(v.founder, key, { type: "note" });
  const third = await authored(v.founder, key, { type: "close" });

  expect((await push(v, v.founder, [first, third], true)).status).toBe(200);
  const heads = await push(v, v.founder, [], true);

  expect(heads.json.authors).toEqual({ [v.founder.id]: 1 });
});

test("history push with events answers no authors", async () => {
  const v = await vault();
  const key = currentKey(v);
  const events = [
    await authored(v.founder, key, { type: "start" }),
    await authored(v.founder, key, { type: "note" }),
  ];

  const scans = (sql: readonly string[]) => sql.filter((text) => text.includes("GROUP BY author"));
  const carryingRecording = recordStatements();
  const carrying = await push(v, v.founder, events, true).finally(carryingRecording.stop);
  const emptyRecording = recordStatements();
  const empty = await push(v, v.founder, [], true).finally(emptyRecording.stop);

  expect(carrying.status).toBe(200);
  expect(carrying.json).toEqual({
    accepted: [
      { id: events[0]?.id, hub_seq: 1 },
      { id: events[1]?.id, hub_seq: 2 },
    ],
  });

  expect(empty.json).toEqual({ accepted: [], authors: { [v.founder.id]: 2 } });
  expect(scans(carryingRecording.sql)).toEqual([]);
  expect(scans(emptyRecording.sql)).toHaveLength(1);
});

test("page stops at the byte budget", async () => {
  const v = await vault();
  const key = currentKey(v);
  const pad = "x".repeat(63 * 1024);
  const events: AuthoredEvent[] = [];
  for (let i = 0; i < 140; i++) events.push(await authored(v.founder, key, { type: "note", pad }));

  const pushed = events.reduce((sum, event) => sum + event.envelope.byteLength, 0);
  expect(pushed).toBeGreaterThan(8 * 1024 * 1024);
  expect((await push(v, v.founder, events)).status).toBe(200);

  const recording = recordStatements();
  const page = await send(v.hub, v.founder, "GET", "/v1/events?limit=1000").finally(recording.stop);
  const held = page.json.events as { hub_seq: number; id: string; envelope: string }[];
  const read = recording.rows.filter(
    (row) => typeof row === "object" && row !== null && "envelope" in row,
  );

  const bytes = held.reduce(
    (sum, event) => sum + Buffer.from(event.envelope, "base64").byteLength,
    0,
  );

  expect(held.length).toBeGreaterThan(0);
  expect(held.length).toBeLessThan(events.length);
  expect(bytes).toBeLessThanOrEqual(8 * 1024 * 1024);
  expect(read.length).toBeLessThanOrEqual(held.length + 1);

  const last = held.at(-1)?.hub_seq ?? 0;
  const next = await send(v.hub, v.founder, "GET", `/v1/events?after=${last}&limit=1`);
  const first = (next.json.events as { hub_seq: number; id: string }[])[0];

  expect([first?.hub_seq, first?.id]).toEqual([last + 1, events[held.length]?.id]);
});
