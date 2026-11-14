import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  epochKey,
  LAYOUT,
  MAX_EPOCH,
  randomId,
  signEntry,
  type Bytes,
  type Id,
  type Membership,
} from "skills-core";
import { startHub } from "../src/main.ts";
import { toBase64 } from "../src/wire.ts";
import {
  card,
  count,
  currentKey,
  deviceEntry,
  extend,
  hubPool,
  joinBody,
  newDevice,
  pendingDevices,
  send,
  setClock,
  writable,
  type Device,
  type Vault,
} from "./harness.ts";

const { vault } = hubPool();

const SECOND = 1000;

const HOUR = 60 * 60 * SECOND;

const LINGERED = Date.now() - 48 * HOUR;

function seed(v: Vault, rows: number, expires: number): void {
  writable(
    v.hub,
    `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${rows})
     INSERT INTO pending (invite, device, signing, wrapping, nonce, mac, signature, expires)
     SELECT lower(hex(randomblob(16))), lower(hex(randomblob(16))), randomblob(32), randomblob(32),
       lower(hex(randomblob(16))), randomblob(32), randomblob(64), ${expires} + i FROM n`,
  );
}

type Joiner = { readonly device: Device; readonly invite: Id };

async function joinBatch(
  v: Vault,
  size: number,
  expires: (index: number) => number,
  invite: (index: number) => Id = () => randomId(),
) {
  const joiners: Joiner[] = await Promise.all(
    Array.from({ length: size }, async (_, index) => ({
      device: await newDevice("joiner"),
      invite: invite(index),
    })),
  );

  const statuses: number[] = [];
  for (const [index, { device, invite }] of joiners.entries()) {
    const body = await joinBody(device, invite, expires(index));
    statuses.push((await send(v.hub, undefined, "POST", "/v1/pair", body)).status);
  }

  expect(statuses).toEqual(joiners.map(() => 202));
  return joiners;
}

async function liveJoin(v: Vault, device: Device) {
  return send(
    v.hub,
    undefined,
    "POST",
    "/v1/pair",
    await joinBody(device, randomId(), Date.now() + HOUR),
  );
}

async function postJoin(v: Vault, invite: Id, expires: number) {
  const before = count(v.hub, "pending");
  const body = await joinBody(await newDevice("refused"), invite, expires);
  const reply = await send(v.hub, undefined, "POST", "/v1/pair", body);
  return { reply, before, after: count(v.hub, "pending") };
}

test("refuses an entry that does not extend the head", async () => {
  const v = await vault();
  const first = await deviceEntry(v, await newDevice("laptop"));
  const rival = await deviceEntry(v, await newDevice("desktop"));
  const base = v.entries.length;

  expect((await extend(v, first)).status).toBe(200);

  const stale = await send(v.hub, v.founder, "POST", "/v1/membership", {
    from: v.entries.length,
    entries: [toBase64(rival)],
  });

  const forked = await send(v.hub, v.founder, "POST", "/v1/membership", {
    from: base,
    entries: [toBase64(rival)],
  });

  expect([stale.status, stale.json.reason, stale.json.entry]).toEqual([409, "chain-link", 2]);
  expect([forked.status, forked.json.reason, forked.json.entry]).toEqual([409, "chain-fork", 1]);
  expect(count(v.hub, "membership")).toBe(2);
});

test("two extensions racing on one head append exactly one", async () => {
  const v = await vault();
  const entries = [
    await deviceEntry(v, await newDevice("laptop")),
    await deviceEntry(v, await newDevice("desktop")),
  ];

  const replies = await Promise.all(
    entries.map((entry) =>
      send(v.hub, v.founder, "POST", "/v1/membership", { from: 1, entries: [toBase64(entry)] }),
    ),
  );

  const loser = replies.find((reply) => reply.status === 409);

  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
  expect(loser?.json.reason).toBe("chain-fork");
  expect(count(v.hub, "membership")).toBe(2);
});

test("a resent extension appends nothing more", async () => {
  const v = await vault();
  const entry = await deviceEntry(v, await newDevice("laptop"));
  const body = { from: 1, entries: [toBase64(entry)] };

  const first = await send(v.hub, v.founder, "POST", "/v1/membership", body);
  const again = await send(v.hub, v.founder, "POST", "/v1/membership", body);

  expect(again.json).toEqual(first.json);
  expect(count(v.hub, "membership")).toBe(2);
});

test("refuses a device card whose label is not sealed", async () => {
  const v = await vault();
  const device = await newDevice("laptop");
  const plain = {
    ...(await card(currentKey(v), device)),
    label: new TextEncoder().encode("laptop"),
  };

  const entry = await signEntry(
    { kind: "device", id: v.founder.id, keys: v.founder.sign },
    { kind: "device", device: plain, invite: randomId(), keys: v.keys },
    v.membership,
  );

  const refused = await extend(v, entry);

  expect([refused.status, refused.json.reason]).toEqual([409, "label-not-sealed"]);
});

test("a joiner polls pending, then enrolled with its entry index", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const invite = randomId();

  expect(
    (await send(v.hub, undefined, "POST", "/v1/pair", await joinBody(joiner, invite))).status,
  ).toBe(202);

  const listed = await send(v.hub, v.founder, "GET", "/v1/pending");
  expect(
    (listed.json.requests as { request: { device: string } }[]).map((row) => row.request.device),
  ).toEqual([joiner.id]);

  expect((await extend(v, await deviceEntry(v, joiner, invite))).status).toBe(200);

  const enrolled = await send(v.hub, joiner, "GET", `/v1/pair/${invite}`);
  const after = await send(v.hub, v.founder, "GET", "/v1/pending");
  const reused = await send(
    v.hub,
    undefined,
    "POST",
    "/v1/pair",
    await joinBody(await newDevice("late"), invite),
  );

  expect([enrolled.status, enrolled.json.state, enrolled.json.entry]).toEqual([200, "enrolled", 1]);
  expect(after.json.requests).toEqual([]);
  expect([reused.status, reused.json.reason]).toEqual([409, "invite-consumed"]);
});

test("a join request whose own signature fails is refused", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const body = await joinBody(joiner, randomId());
  const forged = { ...body, request: { ...body.request, nonce: randomId() } };

  const refused = await send(v.hub, undefined, "POST", "/v1/pair", forged);

  expect([refused.status, refused.json.reason]).toEqual([401, "join-signature"]);
  expect(count(v.hub, "pending")).toBe(0);
});

test("the recovery identity reads the chain and enrolls one device, nothing else", async () => {
  const v = await vault();

  const chain = await send(v.hub, v.recovery, "GET", "/v1/recover");
  const events = await send(v.hub, v.recovery, "GET", "/v1/events");
  const asMember = await send(v.hub, v.founder, "GET", "/v1/recover");

  expect(chain.status).toBe(200);
  expect(chain.json.entries).toEqual([toBase64(v.entries[0]!)]);
  expect(Object.keys(chain.json).sort()).toEqual(["entries", "head", "length"]);
  expect([events.status, events.json.reason]).toEqual([403, "recovery-route"]);
  expect([asMember.status, asMember.json.reason]).toEqual([403, "member-route"]);

  const rescued = await newDevice("rescued");
  const entry = await signEntry(
    { kind: "recovery", keys: v.recovery.sign },
    { kind: "device", device: await card(currentKey(v), rescued), invite: null, keys: v.keys },
    v.membership,
  );

  const recovered = await send(v.hub, v.recovery, "POST", "/v1/recover", {
    entry: toBase64(entry),
  });

  const retried = await send(v.hub, v.recovery, "POST", "/v1/recover", {
    entry: toBase64(entry),
  });

  expect([recovered.status, recovered.json.length]).toEqual([201, 2]);
  expect([retried.status, retried.json.length]).toEqual([201, 2]);
  expect((await send(v.hub, rescued, "GET", "/v1/leases")).status).toBe(200);
});

const BODY_CAP = 32 * 1024 * 1024;

async function entryHash(wire: Bytes): Promise<Bytes> {
  const unsigned = wire.slice(0, -LAYOUT.signature);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", unsigned));
}

async function rotateUpTo(v: Vault, last: number): Promise<Membership> {
  const founder = { kind: "device", id: v.founder.id, keys: v.founder.sign } as const;

  let membership = v.membership;
  const wires: Bytes[] = [];
  for (let epoch = currentKey(v).epoch + 1; epoch <= last; epoch++) {
    const key = epochKey(epoch);
    const wire = await signEntry(founder, { kind: "epoch", key }, membership);

    // Reverifying the chain after each entry is quadratic, and an epoch entry moves nothing signEntry checks but the checkpoint.
    const { checkpoint } = membership;
    membership = {
      ...membership,
      checkpoint: {
        ...checkpoint,
        head: await entryHash(wire),
        length: checkpoint.length + 1,
        epoch,
      },
    };

    wires.push(wire);
    v.keys.push(key);
  }

  let from = v.entries.length;
  let batch: string[] = [];
  let size = 0;
  const flush = async () => {
    const reply = await send(v.hub, v.founder, "POST", "/v1/membership", { from, entries: batch });
    if (reply.status !== 200) throw new Error(`rotation failed: ${reply.text}`);

    from += batch.length;
    batch = [];
    size = 0;
  };

  for (const wire of wires) {
    const encoded = toBase64(wire);
    if (size + encoded.length + 3 > BODY_CAP - 1024) await flush();

    batch.push(encoded);
    size += encoded.length + 3;
  }

  await flush();

  return membership;
}

test("a recovery at the last epoch fits the recover route", async () => {
  const v = await vault();
  const membership = await rotateUpTo(v, MAX_EPOCH);
  const before = count(v.hub, "membership");

  const rescued = await newDevice("rescued");
  const entry = await signEntry(
    { kind: "recovery", keys: v.recovery.sign },
    { kind: "device", device: await card(currentKey(v), rescued), invite: null, keys: v.keys },
    membership,
  );

  const encoded = toBase64(entry);
  const recovered = await send(v.hub, v.recovery, "POST", "/v1/recover", { entry: encoded });

  expect(before).toBe(MAX_EPOCH);
  expect(encoded.length).toBeGreaterThan(2 * 1024 * 1024);
  expect([recovered.status, recovered.json.length]).toEqual([201, before + 1]);
  expect(count(v.hub, "membership")).toBe(before + 1);
}, 300_000);

test("a restore marker mints a new incarnation", async () => {
  const v = await vault();
  const original = v.hub.incarnation;

  await v.hub.restart();
  const kept = v.hub.incarnation;

  await v.hub.restart({ restored: true });
  const version = await (await fetch(`${v.hub.url}/v1/version`)).json();

  expect(kept).toBe(original);
  expect(v.hub.incarnation).not.toBe(original);
  expect(version.incarnation).toBe(v.hub.incarnation);
  expect(existsSync(join(v.hub.dir, ".restored"))).toBe(false);
  expect(count(v.hub, "signatures")).toBe(0);
});

test("a hub that cannot bind its port refuses to start", async () => {
  const v = await vault();
  const port = Number(new URL(v.hub.url).port);
  const dir = mkdtempSync(join(tmpdir(), "skills-hub-bind-"));
  try {
    await expect(
      startHub({ data: dir, listen: `127.0.0.1:${port}`, log: () => {} }),
    ).rejects.toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the pending table stays bounded past its cap", async () => {
  const v = await vault();

  let clock = Date.now();
  for (let batch = 0; batch < 7; batch++) {
    setClock(clock);
    await joinBatch(v, 200, () => clock + SECOND);
    clock += 2 * SECOND;

    expect(count(v.hub, "pending")).toBeLessThanOrEqual(1024);
  }

  setClock(clock);
  const last = await liveJoin(v, await newDevice("last"));

  expect([last.status, last.json]).toEqual([202, { state: "pending" }]);
}, 60_000);

test("a full table evicts the oldest expired row for a live join", async () => {
  const v = await vault();
  let clock = Date.now();

  const batches: Joiner[][] = [];
  for (const size of [200, 200, 200, 200, 200, 24]) {
    setClock(clock);
    const start = clock;
    batches.push(await joinBatch(v, size, (index) => start + SECOND + index));
    clock += 2 * SECOND;
  }

  setClock(clock);
  expect(count(v.hub, "pending")).toBe(1024);

  const live = await newDevice("live");
  const admitted = await liveJoin(v, live);

  const kept = pendingDevices(v.hub);
  const oldest = batches[0]?.[0];
  const newest = batches.at(-1) ?? [];
  const loser = newest[0];
  if (oldest === undefined || loser === undefined) throw new Error("the fill posts every batch");

  const polled = await send(v.hub, loser.device, "GET", `/v1/pair/${loser.invite}`);

  expect([admitted.status, admitted.json]).toEqual([202, { state: "pending" }]);
  expect(count(v.hub, "pending")).toBe(1024);

  expect(kept.has(oldest.device.id)).toBe(false);
  expect(newest.every(({ device }) => kept.has(device.id))).toBe(true);
  expect(kept.has(live.id)).toBe(true);

  expect([polled.status, polled.json]).toEqual([200, { state: "expired" }]);
}, 60_000);

test("a table above the bound shrinks by at most 256 expired rows a request", async () => {
  const v = await vault();
  seed(v, 1500, Date.now() - 60 * SECOND - 1500);

  const first = await liveJoin(v, await newDevice("first"));
  const afterFirst = count(v.hub, "pending");
  const second = await liveJoin(v, await newDevice("second"));

  expect([first.status, first.json.reason]).toEqual([503, "pending-full"]);
  expect(afterFirst).toBe(1244);
  expect([second.status, second.json]).toEqual([202, { state: "pending" }]);
  expect(count(v.hub, "pending")).toBe(1024);
});

test("the linger purge and the eviction share one 256 row budget a request", async () => {
  const v = await vault();
  seed(v, 200, LINGERED);
  seed(v, 1100, Date.now() - 60 * SECOND - 1100);

  const refused = await liveJoin(v, await newDevice("joiner"));

  expect([refused.status, refused.json.reason]).toEqual([503, "pending-full"]);
  expect(count(v.hub, "pending")).toBe(1044);
  expect(count(v.hub, `pending WHERE expires < ${Date.now() - 24 * HOUR}`)).toBe(0);
});

test("each pairing read purges at most 256 rows past the linger", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const invite = randomId();
  const body = await joinBody(joiner, invite);

  expect((await send(v.hub, undefined, "POST", "/v1/pair", body)).status).toBe(202);

  seed(v, 300, LINGERED);
  const polled = await send(v.hub, joiner, "GET", `/v1/pair/${invite}`);
  const afterPoll = count(v.hub, "pending");
  const listed = await send(v.hub, v.founder, "GET", "/v1/pending");

  expect([polled.status, polled.json]).toEqual([200, { state: "pending" }]);
  expect(afterPoll).toBe(45);
  expect(listed.status).toBe(200);
  expect(count(v.hub, "pending")).toBe(1);
});

test("join refusal: an invite already past its expires", async () => {
  const v = await vault();
  await joinBatch(v, 1, () => Date.now() + HOUR);

  const { reply, before, after } = await postJoin(v, randomId(), Date.now() - 1);

  expect([reply.status, reply.json.reason]).toEqual([409, "invite-expired"]);
  expect([before, after]).toEqual([1, 1]);
});

test("join refusal: a fifth live join on one invite", async () => {
  const v = await vault();
  const invite = randomId();
  await joinBatch(
    v,
    4,
    () => Date.now() + HOUR,
    () => invite,
  );

  const { reply, before, after } = await postJoin(v, invite, Date.now() + HOUR);

  expect([reply.status, reply.json.reason]).toEqual([409, "invite-full"]);
  expect([before, after]).toEqual([4, 4]);
});

test("join refusal: 256 live joins over 64 invites fill the table", async () => {
  const v = await vault();
  const invites = Array.from({ length: 64 }, () => randomId());
  await joinBatch(
    v,
    256,
    () => Date.now() + HOUR,
    (index) => invites[index >> 2]!,
  );

  const { reply, before, after } = await postJoin(v, randomId(), Date.now() + HOUR);

  expect([reply.status, reply.json.reason]).toEqual([503, "pending-full"]);
  expect([before, after]).toEqual([256, 256]);
});

test("a joiner past its expires inside the linger reads expired", async () => {
  const v = await vault();
  const [joiner] = await joinBatch(v, 1, () => Date.now() + HOUR);
  if (joiner === undefined) throw new Error("the batch posts one join");

  setClock(Date.now() + 2 * HOUR);
  const polled = await send(v.hub, joiner.device, "GET", `/v1/pair/${joiner.invite}`);

  expect([polled.status, polled.json]).toEqual([200, { state: "expired" }]);
  expect(count(v.hub, "pending")).toBe(1);
});

test("a joiner whose invite another device consumed reads expired", async () => {
  const v = await vault();
  const [joiner] = await joinBatch(v, 1, () => Date.now() + HOUR);
  if (joiner === undefined) throw new Error("the batch posts one join");

  const pending = await send(v.hub, joiner.device, "GET", `/v1/pair/${joiner.invite}`);
  expect(
    (await extend(v, await deviceEntry(v, await newDevice("rival"), joiner.invite))).status,
  ).toBe(200);

  const polled = await send(v.hub, joiner.device, "GET", `/v1/pair/${joiner.invite}`);

  expect([pending.status, pending.json]).toEqual([200, { state: "pending" }]);
  expect([polled.status, polled.json]).toEqual([200, { state: "expired" }]);
});
