import { expect, test } from "bun:test";
import { once } from "node:events";
import { connect } from "node:net";
import { randomId } from "skills-core";
import type { HubFixture } from "../../../packages/cli/src/test/hub-fixture.ts";
import { toBase64 } from "../src/wire.ts";
import {
  authored,
  count,
  currentKey,
  deliver,
  deviceEntry,
  enroll,
  extend,
  foundingEntry,
  foundVault,
  hubLog,
  hubPool,
  joinBody,
  newDevice,
  overlapped,
  prepare,
  revoke,
  send,
  wire,
  writable,
  type Reply,
  type Vault,
} from "./harness.ts";

const { hub: freshHub, vault } = hubPool();

function admits(v: Vault, name: string) {
  return async (): Promise<Reply> => {
    const reply = await extend(v, await deviceEntry(v, await newDevice(name)));
    expect(reply.status).toBe(200);
    return reply;
  };
}

test("version answers unsigned with the range and the incarnation", async () => {
  const { hub } = await vault();
  const response = await fetch(`${hub.url}/v1/version`);

  expect(await response.text()).toBe(`{"min":1,"max":1,"incarnation":"${hub.incarnation}"}`);
  expect(response.headers.get("x-skills-incarnation")).toBe(hub.incarnation);
});

test("refuses a clock more than five minutes off", async () => {
  const { hub, founder } = await vault();
  const minutes = (n: number) => Date.now() + n * 60 * 1000;

  const behind = await send(hub, founder, "GET", "/v1/leases", undefined, { time: minutes(-6) });
  const ahead = await send(hub, founder, "GET", "/v1/leases", undefined, { time: minutes(6) });
  const close = await send(hub, founder, "GET", "/v1/leases", undefined, { time: minutes(-4) });

  expect([behind.status, behind.json.reason]).toEqual([401, "clock"]);
  expect([ahead.status, ahead.json.reason]).toEqual([401, "clock"]);
  expect(close.status).toBe(200);
});

test("refuses a replayed signature after a restart", async () => {
  const { hub, founder } = await vault();
  const request = await prepare(hub, founder, "GET", "/v1/leases");

  expect((await deliver(hub, request)).status).toBe(200);

  await hub.restart();
  const again = await deliver(hub, request);

  expect([again.status, again.json.reason]).toEqual([401, "replayed"]);
});

test("refuses a request bound to the previous incarnation", async () => {
  const { hub, founder } = await vault();
  const before = hub.incarnation;

  await hub.restart({ restored: true });
  const stale = await send(hub, founder, "GET", "/v1/leases", undefined, { incarnation: before });
  const unknown = await send(hub, founder, "GET", "/v1/leases", undefined, {
    incarnation: randomId(),
  });

  expect([stale.status, stale.json.reason]).toEqual([401, "incarnation"]);
  expect([unknown.status, unknown.json.reason]).toEqual([401, "signature"]);
});

test("a request that fails mid transaction leaves no replay record", async () => {
  const v = await vault();
  const event = await authored(v.founder, currentKey(v), { type: "start" });
  const request = await prepare(v.hub, v.founder, "POST", "/v1/events", { events: [wire(event)] });
  const spent = count(v.hub, "signatures");

  writable(
    v.hub,
    "CREATE TRIGGER fail_insert BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'injected'); END",
  );

  const failed = await deliver(v.hub, request);

  expect([failed.status, failed.json.reason]).toEqual([500, "internal"]);
  expect(count(v.hub, "signatures")).toBe(spent);
  expect(count(v.hub, "events")).toBe(0);

  writable(v.hub, "DROP TRIGGER fail_insert");
  const retried = await deliver(v.hub, request);

  expect(retried.status).toBe(200);
  expect(count(v.hub, "events")).toBe(1);
});

test("refuses a revoked device", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");

  expect((await send(v.hub, laptop, "GET", "/v1/leases")).status).toBe(200);
  expect((await revoke(v, laptop)).status).toBe(200);

  const refused = await send(v.hub, laptop, "GET", "/v1/leases");
  expect([refused.status, refused.json.reason]).toEqual([403, "device-revoked"]);
  expect((await send(v.hub, v.founder, "GET", "/v1/leases")).status).toBe(200);
});

test("refuses a pending device outside its invite route", async () => {
  const { hub } = await vault();
  const joiner = await newDevice("joiner");
  const invite = randomId();

  expect(
    (await send(hub, undefined, "POST", "/v1/pair", await joinBody(joiner, invite))).status,
  ).toBe(202);

  const own = await send(hub, joiner, "GET", `/v1/pair/${invite}`);
  const other = await send(hub, joiner, "GET", `/v1/pair/${randomId()}`);
  const events = await send(hub, joiner, "GET", "/v1/events");
  const membership = await send(hub, joiner, "GET", "/v1/membership");

  expect([own.status, own.json.state]).toEqual([200, "pending"]);
  expect([other.status, other.json.reason]).toEqual([403, "device-pending"]);
  expect([events.status, events.json.reason]).toEqual([403, "device-pending"]);
  expect([membership.status, membership.json.reason]).toEqual([403, "device-pending"]);
});

test("the only unsigned writes are vault with the init code and pair", async () => {
  const hub = await freshHub();

  const wrongCode = await send(hub, undefined, "POST", "/v1/vault", {
    code: "0".repeat(26),
    entries: [],
  });

  expect([wrongCode.status, wrongCode.json.reason]).toEqual([403, "init-code"]);

  await foundVault(hub);
  const founded = await send(hub, undefined, "POST", "/v1/vault", {
    code: hub.initCode,
    entries: [],
  });

  expect([founded.status, founded.json.reason]).toEqual([409, "vault-exists"]);

  const writes = [
    ["POST", "/v1/membership"],
    ["POST", "/v1/recover"],
    ["POST", "/v1/events"],
    ["POST", "/v1/events?history=1"],
    ["POST", "/v1/blobs/have"],
    ["PUT", `/v1/blobs/${randomId()}`],
    ["DELETE", `/v1/blobs/${randomId()}`],
    ["PUT", `/v1/leases/${"a".repeat(64)}`],
    ["DELETE", `/v1/leases/${"a".repeat(64)}`],
  ] as const;

  for (const [method, path] of writes) {
    const reply = await send(hub, undefined, method, path, {});
    expect([method, path, reply.status, reply.json.reason]).toEqual([
      method,
      path,
      401,
      "unsigned",
    ]);
  }

  const joiner = await newDevice("joiner");
  const pair = await send(hub, undefined, "POST", "/v1/pair", await joinBody(joiner, randomId()));
  expect(pair.status).toBe(202);
});

async function headOnly(hub: HubFixture, path: string, declared: number) {
  const url = new URL(hub.url);
  const socket = connect(Number(url.port), url.hostname);
  try {
    await once(socket, "connect");
    socket.write(
      [`POST ${path} HTTP/1.1`, `host: ${url.host}`, `content-length: ${declared}`, "", ""].join(
        "\r\n",
      ),
    );

    let received = "";
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const timer = setTimeout(() => reject(new Error("no reply within 5 s")), 5000);
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const end = received.indexOf("\r\n\r\n");
      const length = /^content-length: (\d+)\r?$/im.exec(received.slice(0, end));
      if (end >= 0 && length !== null && received.length >= end + 4 + Number(length[1]))
        resolve(received);
    });

    const reply = await promise.finally(() => clearTimeout(timer));
    const status = Number(reply.split(" ")[1]);
    const body = JSON.parse(reply.slice(reply.indexOf("\r\n\r\n") + 4)) as Record<string, unknown>;
    return [status, body.reason];
  } finally {
    socket.destroy();
  }
}

async function notJson(hub: HubFixture) {
  const response = await fetch(`${hub.url}/v1/vault`, {
    method: "POST",
    // Bun's fetch pools a connection whose upload the hub never read, and hub.stop() waits out its idle timeout.
    headers: { connection: "close" },
    body: "x".repeat(4 * 1024 * 1024),
  });

  const body = (await response.json()) as Record<string, unknown>;
  return [response.status, body.reason];
}

test("a founded hub refuses a vault post unread", async () => {
  const hub = await freshHub();
  expect(await notJson(hub)).toEqual([400, "malformed"]);

  await foundVault(hub);
  expect(await headOnly(hub, "/v1/vault", 32 * 1024 * 1024)).toEqual([409, "vault-exists"]);
  expect(hubLog(hub)).toMatch(/^POST \/v1\/vault 409 -$/m);
  expect(await notJson(hub)).toEqual([409, "vault-exists"]);
}, 15_000);

test("a vault founded mid request is refused vault-exists", async () => {
  const hub = await freshHub();
  const { founding } = await foundingEntry();

  const second = await overlapped([() => foundVault(hub)], () =>
    send(hub, undefined, "POST", "/v1/vault", {
      code: hub.initCode,
      entries: [toBase64(founding)],
    }),
  );

  expect([second.status, second.json.reason]).toEqual([409, "vault-exists"]);
  expect(count(hub, "membership")).toBe(1);
});

test("a verified request the hub refuses still spends its signature", async () => {
  const { hub, founder } = await vault();
  const request = await prepare(hub, founder, "GET", `/v1/blobs/${randomId()}`);

  const first = await deliver(hub, request);
  const again = await deliver(hub, request);

  expect([first.status, first.json.reason]).toEqual([404, "blob-missing"]);
  expect([again.status, again.json.reason]).toEqual([401, "replayed"]);
});

test("unknown routes, wrong methods, oversized bodies and foreign protocols each have a reason", async () => {
  const { hub, founder } = await vault();

  const route = await send(hub, founder, "GET", "/v1/nowhere");
  const method = await send(hub, founder, "PUT", "/v1/events", {});
  const large = await send(hub, undefined, "POST", "/v1/pair", { padding: "x".repeat(8192) });
  const protocol = await send(hub, founder, "GET", "/v1/leases", undefined, { protocol: "9" });

  expect([route.status, route.json.reason]).toEqual([404, "route"]);
  expect([method.status, method.json.reason]).toEqual([405, "method"]);
  expect([large.status, large.json.reason]).toEqual([413, "too-large"]);
  expect([protocol.status, protocol.text]).toEqual([426, "hub speaks 1..1, this release speaks 9"]);
  expect(protocol.incarnation).toBe(hub.incarnation);
});

test("a signed read the chain moved under is answered", async () => {
  const v = await vault();

  const reply = await overlapped([admits(v, "desktop")], () =>
    send(v.hub, v.founder, "GET", "/v1/pending"),
  );

  expect([reply.status, reply.json.requests]).toEqual([200, []]);
  expect(count(v.hub, "membership")).toBe(2);
  expect(hubLog(v.hub)).not.toMatch(/^GET \/v1\/pending 409 /m);
});

test("a re-prepared request authenticates against the new chain", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");

  const revoked = await overlapped([() => revoke(v, laptop)], () =>
    send(v.hub, laptop, "GET", "/v1/pending"),
  );

  expect([revoked.status, revoked.json.reason]).toEqual([403, "device-revoked"]);

  const request = await prepare(v.hub, v.founder, "GET", "/v1/pending");
  const answered = await overlapped([admits(v, "desktop")], () => deliver(v.hub, request));
  const again = await deliver(v.hub, request);

  expect(answered.status).toBe(200);
  expect([again.status, again.json.reason]).toEqual([401, "replayed"]);
});

test("a request the chain moves under twice is refused once", async () => {
  const v = await vault();
  const request = await prepare(v.hub, v.founder, "GET", "/v1/pending");

  const moved = await overlapped([admits(v, "laptop"), admits(v, "desktop")], () =>
    deliver(v.hub, request),
  );

  const again = await deliver(v.hub, request);

  expect([moved.status, moved.json.reason]).toEqual([409, "chain-moved"]);
  expect([again.status, again.json.reason]).toEqual([401, "replayed"]);
  expect(count(v.hub, "membership")).toBe(3);
});

test("a join poll that overlaps its own admission answers enrolled", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const invite = randomId();

  expect(
    (await send(v.hub, undefined, "POST", "/v1/pair", await joinBody(joiner, invite))).status,
  ).toBe(202);

  const admit = async () =>
    expect((await extend(v, await deviceEntry(v, joiner, invite))).status).toBe(200);

  const poll = await overlapped([admit], () => send(v.hub, joiner, "GET", `/v1/pair/${invite}`));

  expect([poll.status, poll.json]).toEqual([200, { state: "enrolled", entry: 1 }]);
});

test("an unsigned join the chain moved under is answered", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const body = await joinBody(joiner, randomId());

  const reply = await overlapped([admits(v, "desktop")], () =>
    send(v.hub, undefined, "POST", "/v1/pair", body),
  );

  expect([reply.status, reply.json]).toEqual([202, { state: "pending" }]);
  expect(count(v.hub, "membership")).toBe(2);
});

test("a re-prepare that no longer knows the device still spends its signature", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const invite = randomId();

  expect(
    (await send(v.hub, undefined, "POST", "/v1/pair", await joinBody(joiner, invite))).status,
  ).toBe(202);

  const request = await prepare(v.hub, joiner, "GET", `/v1/pair/${invite}`);
  const forget = async () => writable(v.hub, `DELETE FROM pending WHERE device = '${joiner.id}'`);
  const forgotten = await overlapped([admits(v, "desktop"), forget], () => deliver(v.hub, request));

  expect(
    (await send(v.hub, undefined, "POST", "/v1/pair", await joinBody(joiner, invite))).status,
  ).toBe(202);

  const again = await deliver(v.hub, request);

  expect([forgotten.status, forgotten.json.reason]).toEqual([401, "device-unknown"]);
  expect([again.status, again.json.reason]).toEqual([401, "replayed"]);
});

test("a refusal the chain moves under again is refused chain-moved", async () => {
  const v = await vault();
  const joiner = await newDevice("joiner");
  const invite = randomId();

  expect(
    (await send(v.hub, undefined, "POST", "/v1/pair", await joinBody(joiner, invite))).status,
  ).toBe(202);

  const admit = async () =>
    expect((await extend(v, await deviceEntry(v, joiner, invite))).status).toBe(200);

  const moved = await overlapped([admits(v, "desktop"), admit], () =>
    send(v.hub, joiner, "GET", "/v1/membership"),
  );

  expect([moved.status, moved.json.reason]).toEqual([409, "chain-moved"]);
});
