import { expect, test } from "bun:test";
import { randomId } from "skills-core";
import { enroll, hubPool, leaseOf, send, type Device, type Vault } from "./harness.ts";

const { vault } = hubPool();

const DAY = 24 * 60 * 60 * 1000;
function acquire(
  v: Vault,
  device: Device,
  key: string,
  operation = randomId(),
  token: string | null = null,
) {
  return send(v.hub, device, "PUT", `/v1/leases/${key}`, {
    operation,
    token,
    ttl: DAY,
    pinned: false,
  });
}

function release(
  v: Vault,
  device: Device,
  key: string,
  token: unknown,
  mode = "release",
  operation = randomId(),
) {
  return send(v.hub, device, "DELETE", `/v1/leases/${key}`, { operation, token, mode });
}

test("second holder gets 409 with the first device id", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");
  const key = await leaseOf(v, "Project", "001");

  const [first, second] = await Promise.all([acquire(v, v.founder, key), acquire(v, laptop, key)]);
  const winner = first.status === 200 ? v.founder : laptop;
  const loser = first.status === 200 ? second : first;

  expect([first.status, second.status].sort()).toEqual([200, 409]);
  expect([loser.json.reason, loser.json.holder]).toEqual(["lease-held", winner.id]);
});

test("a repeated lease operation id is a no op", async () => {
  const v = await vault();
  const key = await leaseOf(v, "Project", "002");
  const operation = randomId();

  const acquired = await acquire(v, v.founder, key, operation);
  const repeated = await acquire(v, v.founder, key, operation);

  expect(acquired.status).toBe(200);
  expect(repeated.json).toEqual(acquired.json);

  const releasing = randomId();
  const released = await release(v, v.founder, key, acquired.json.token, "release", releasing);
  const reacquired = await acquire(v, v.founder, key);
  const replayed = await release(v, v.founder, key, acquired.json.token, "release", releasing);
  const leases = await send(v.hub, v.founder, "GET", "/v1/leases");

  expect(released.status).toBe(200);
  expect(replayed.json).toEqual(released.json);
  expect((leases.json.leases as { token: string }[]).map((lease) => lease.token)).toEqual([
    reacquired.json.token as string,
  ]);

  const elsewhere = await acquire(v, v.founder, await leaseOf(v, "Project", "003"), operation);
  expect([elsewhere.status, elsewhere.json.reason]).toEqual([409, "operation-reused"]);
});

test("refuses a stale lease token", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");
  const key = await leaseOf(v, "Project", "004");

  const old = await acquire(v, v.founder, key);
  await release(v, v.founder, key, old.json.token);
  const current = await acquire(v, v.founder, key);

  const staleRelease = await release(v, v.founder, key, old.json.token);
  const staleRefresh = await acquire(v, v.founder, key, randomId(), old.json.token as string);
  const staleBreak = await release(v, laptop, key, old.json.token, "break");
  const foreignRelease = await release(v, laptop, key, current.json.token);
  const broken = await release(v, laptop, key, current.json.token, "break");

  expect([staleRelease.status, staleRelease.json.reason]).toEqual([409, "lease-token"]);
  expect([staleRefresh.status, staleRefresh.json.reason]).toEqual([409, "lease-token"]);
  expect([staleBreak.status, staleBreak.json.reason]).toEqual([409, "lease-token"]);
  expect([foreignRelease.status, foreignRelease.json.reason]).toEqual([409, "lease-holder"]);
  expect([broken.status, broken.json.mode]).toEqual([200, "break"]);
});

test("a lease lasts at most 30 days", async () => {
  const v = await vault();
  const key = await leaseOf(v, "Project", "005");

  const refused = await send(v.hub, v.founder, "PUT", `/v1/leases/${key}`, {
    operation: randomId(),
    token: null,
    ttl: 31 * DAY,
    pinned: true,
  });

  expect([refused.status, refused.json.reason]).toEqual([400, "lease-duration"]);
});

test("a refresh never shortens a longer pin", async () => {
  const v = await vault();
  const key = await leaseOf(v, "Project", "006");
  const pinned = await send(v.hub, v.founder, "PUT", `/v1/leases/${key}`, {
    operation: randomId(),
    token: null,
    ttl: 7 * DAY,
    pinned: true,
  });

  const refreshed = await acquire(v, v.founder, key, randomId(), pinned.json.token as string);

  expect(refreshed.json.expires).toBe(pinned.json.expires);
});

test("an operation id reused with another intent is refused", async () => {
  const v = await vault();
  const key = await leaseOf(v, "Project", "007");
  const operation = randomId();
  const acquired = await acquire(v, v.founder, key, operation);

  const released = await release(v, v.founder, key, acquired.json.token, "release", operation);

  expect([released.status, released.json.reason]).toEqual([409, "operation-reused"]);
  expect(
    ((await send(v.hub, v.founder, "GET", "/v1/leases")).json.leases as unknown[]).length,
  ).toBe(1);
});
