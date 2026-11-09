import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomId, signEntry } from "skills-core";
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
  send,
} from "./harness.ts";

const { vault } = hubPool();

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

  expect(replies.map((reply) => reply.status).sort()).toEqual([200, 409]);
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
  expect((chain.json.wraps as unknown[]).length).toBe(1);
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
