import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJoin, encodeInvite, joinMac, newInvite, randomId, sign } from "skills-core";
import { toBase64 } from "../src/wire.ts";
import {
  authored,
  count,
  currentKey,
  deviceEntry,
  extend,
  hubPool,
  leaseOf,
  newDevice,
  push,
  sealBlob,
  send,
} from "./harness.ts";

const { vault } = hubPool();

const NEEDLES = ["Fixture", "FixtureMac"];

function artifacts(dir: string): string[] {
  const names = ["hub.db", "hub.db-wal", "hub.db-shm", "hub.log"].map((name) => join(dir, name));
  const backup = join(dir, "backup");
  const backups = existsSync(backup) ? readdirSync(backup).map((name) => join(backup, name)) : [];
  return [...names, ...backups].filter((path) => existsSync(path));
}

function hits(paths: readonly string[]): string[] {
  return paths.filter((path) => {
    const bytes = readFileSync(path).toString("latin1");
    return NEEDLES.some((needle) => bytes.includes(needle));
  });
}

test("no file the hub writes names the project or the label it stores", async () => {
  const v = await vault();
  const mac = await newDevice("FixtureMac");
  const invite = newInvite({
    checkpoint: v.membership.checkpoint,
    expires: Date.now() + 60 * 60 * 1000,
    label: "FixtureMac",
  });

  expect(await encodeInvite(invite)).not.toContain("Fixture");

  const request = {
    invite: invite.id,
    device: mac.id,
    signing: mac.sign.publicKey,
    wrapping: mac.wrap.publicKey,
    nonce: randomId(),
  };

  const paired = await send(v.hub, undefined, "POST", "/v1/pair", {
    request: {
      ...request,
      signing: toBase64(request.signing),
      wrapping: toBase64(request.wrapping),
    },
    mac: toBase64(await joinMac(invite.secret, request)),
    signature: toBase64(await sign("join", mac.sign, canonicalJoin(request))),
    expires: invite.expires,
  });

  expect(paired.status).toBe(202);
  expect((await extend(v, await deviceEntry(v, mac, invite.id))).status).toBe(200);

  const key = currentKey(v);
  const events = [
    await authored(mac, key, {
      project: "Fixture",
      plan: "001",
      type: "start",
      machine: "FixtureMac",
    }),
    await authored(mac, key, {
      project: "Fixture",
      plan: "002",
      type: "note",
      title: "Fixture plan",
    }),
  ];

  expect((await push(v, mac, events)).status).toBe(200);

  const blob = randomId();
  const put = await send(v.hub, mac, "PUT", `/v1/blobs/${blob}`, {
    envelope: await sealBlob(key, blob, "# Fixture\n\nWritten on FixtureMac."),
  });

  expect(put.status).toBe(201);

  const lease = await send(v.hub, mac, "PUT", `/v1/leases/${await leaseOf(v, "Fixture", "001")}`, {
    operation: randomId(),
    token: null,
    ttl: 60 * 60 * 1000,
    pinned: false,
  });

  expect(lease.status).toBe(200);
  expect(count(v.hub, "events")).toBe(2);
  expect(count(v.hub, "blobs")).toBe(1);
  expect(count(v.hub, "membership")).toBe(2);

  mkdirSync(join(v.hub.dir, "backup"), { recursive: true });
  const db = new Database(join(v.hub.dir, "hub.db"));
  db.exec(`VACUUM INTO '${join(v.hub.dir, "backup", "hub.db")}'`);
  db.close();

  const running = artifacts(v.hub.dir);
  expect(running.map((path) => path.slice(v.hub.dir.length + 1)).sort()).toEqual([
    "backup/hub.db",
    "hub.db",
    "hub.db-shm",
    "hub.db-wal",
    "hub.log",
  ]);

  expect(hits(running)).toEqual([]);
  expect(readFileSync(join(v.hub.dir, "hub.log"), "utf8")).toContain(
    `PUT /v1/blobs/${blob} 201 ${mac.id}`,
  );

  await v.hub.stop();
  if (process.env.HUB_KEEP === "1") expect(hits(artifacts(v.hub.dir))).toEqual([]);
});
