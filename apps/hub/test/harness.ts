import {
  canonicalJoin,
  canonicalRequest,
  epochKey,
  hex,
  leaseKey,
  randomId,
  recoveryKeys,
  recoverySecret,
  seal,
  sign,
  signEntry,
  signEvent,
  signingKeys,
  subkey,
  verifyChain,
  rootFingerprint,
  wrappingKeys,
  type AuthoredEvent,
  type AuthorTail,
  type Bytes,
  type EpochKey,
  type Id,
  type LaterDraft,
  type Membership,
  type SigningKeys,
  type WrappingKeys,
} from "skills-core";
import { Database } from "bun:sqlite";
import { afterEach, setSystemTime } from "bun:test";
import { join } from "node:path";
import { startHubFixture, type HubFixture } from "../../../packages/cli/src/test/hub-fixture.ts";
import { SKEW } from "../src/store.ts";
import { toBase64 } from "../src/wire.ts";

export type Device = {
  readonly id: Id;
  readonly sign: SigningKeys;
  readonly wrap: WrappingKeys;
  readonly name: string;
  tail: AuthorTail | undefined;
};

export type Recovery = { readonly sign: SigningKeys; readonly wrap: WrappingKeys };

export type Signer = Device | Recovery;

export type Vault = {
  readonly hub: HubFixture;
  readonly founder: Device;
  readonly recovery: Recovery;
  readonly keys: EpochKey[];
  entries: Bytes[];
  membership: Membership;
};

export type Prepared = {
  readonly method: string;
  readonly path: string;
  readonly body: string;
  readonly headers: Record<string, string>;
};

export type Reply = {
  readonly status: number;
  readonly text: string;
  readonly json: Record<string, unknown>;
  readonly incarnation: string | null;
};

export type SignOptions = {
  readonly time?: number;
  readonly incarnation?: Id;
  readonly protocol?: string;
};

let lastTime = 0;

let beforeJump: number | undefined;

function freshTime(): number {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return lastTime;
}

export function setClock(time: number): void {
  beforeJump ??= lastTime;
  setSystemTime(new Date(time));
}

export function restoreClock(): void {
  if (beforeJump === undefined) return;

  setSystemTime();
  if (lastTime - Date.now() > SKEW) lastTime = beforeJump;
  beforeJump = undefined;
}

function isDevice(signer: Signer): signer is Device {
  return "id" in signer;
}

export async function newDevice(name: string): Promise<Device> {
  return {
    id: randomId(),
    sign: await signingKeys(),
    wrap: await wrappingKeys(),
    name,
    tail: undefined,
  };
}

export async function sealedLabel(key: EpochKey, device: Id, name: string): Promise<Bytes> {
  return seal(await subkey(key, "labels"), new TextEncoder().encode(name), `label/${device}`);
}

export async function card(key: EpochKey, device: Device) {
  return {
    id: device.id,
    signing: device.sign.publicKey,
    wrapping: device.wrap.publicKey,
    label: await sealedLabel(key, device.id, device.name),
  };
}

export async function prepare(
  hub: HubFixture,
  signer: Signer | undefined,
  method: string,
  path: string,
  body?: unknown,
  options: SignOptions = {},
): Promise<Prepared> {
  const text = body === undefined ? "" : JSON.stringify(body);
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (signer === undefined) return { method, path, body: text, headers };

  const time = options.time ?? freshTime();
  const device = isDevice(signer) ? signer.id : "recovery";
  const message = await canonicalRequest({
    method: method as "GET",
    path,
    body: new TextEncoder().encode(text),
    time,
    device,
    incarnation: options.incarnation ?? hub.incarnation,
  });

  return {
    method,
    path,
    body: text,
    headers: {
      ...headers,
      "x-skills-protocol": options.protocol ?? "1",
      "x-skills-device": device,
      "x-skills-time": String(time),
      "x-skills-signature": toBase64(await sign("request", signer.sign, message)),
    },
  };
}

export async function deliver(hub: HubFixture, prepared: Prepared): Promise<Reply> {
  const response = await fetch(`${hub.url}${prepared.path}`, {
    method: prepared.method,
    headers: prepared.headers,
    body: prepared.body === "" ? undefined : prepared.body,
  });

  const text = await response.text();

  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    json = {};
  }

  return {
    status: response.status,
    text,
    json,
    incarnation: response.headers.get("x-skills-incarnation"),
  };
}

export async function send(
  hub: HubFixture,
  signer: Signer | undefined,
  method: string,
  path: string,
  body?: unknown,
  options?: SignOptions,
): Promise<Reply> {
  return deliver(hub, await prepare(hub, signer, method, path, body, options));
}

export async function foundVault(hub: HubFixture): Promise<Vault> {
  const founder = await newDevice("founder");
  const secret = recoverySecret();
  const recoveryPair = await recoveryKeys(secret);
  const recovery = { sign: recoveryPair.signing, wrap: recoveryPair.wrapping };
  const key = epochKey(1);
  const founding = await signEntry(
    { kind: "device", id: founder.id, keys: founder.sign },
    {
      kind: "founding",
      device: await card(key, founder),
      recovery: { signing: recovery.sign.publicKey, wrapping: recovery.wrap.publicKey },
      key,
    },
  );

  const membership = await verifyChain([founding], {
    fingerprint: await rootFingerprint(founding),
  });

  const reply = await send(hub, undefined, "POST", "/v1/vault", {
    code: hub.initCode,
    entries: [toBase64(founding)],
  });

  if (reply.status !== 201) throw new Error(`founding failed: ${reply.text}`);

  return { hub, founder, recovery, keys: [key], entries: [founding], membership };
}

export function currentKey(vault: Vault): EpochKey {
  const key = vault.keys.at(-1);
  if (key === undefined) throw new Error("a vault holds at least one epoch key");
  return key;
}

export async function draftEntry(vault: Vault, signer: Device, draft: LaterDraft): Promise<Bytes> {
  return signEntry({ kind: "device", id: signer.id, keys: signer.sign }, draft, vault.membership);
}

export async function adopt(vault: Vault, entry: Bytes): Promise<void> {
  vault.entries = [...vault.entries, entry];
  vault.membership = await verifyChain(vault.entries, vault.membership.checkpoint);
}

export async function extend(
  vault: Vault,
  entry: Bytes,
  signer: Signer = vault.founder,
): Promise<Reply> {
  const reply = await send(vault.hub, signer, "POST", "/v1/membership", {
    from: vault.entries.length,
    entries: [toBase64(entry)],
  });

  if (reply.status === 200) await adopt(vault, entry);
  return reply;
}

export async function deviceEntry(vault: Vault, device: Device, invite: Id | null = randomId()) {
  return draftEntry(vault, vault.founder, {
    kind: "device",
    device: await card(currentKey(vault), device),
    invite,
    keys: vault.keys,
  });
}

export async function enroll(vault: Vault, name: string): Promise<Device> {
  const device = await newDevice(name);
  const reply = await extend(vault, await deviceEntry(vault, device));
  if (reply.status !== 200) throw new Error(`enrolment failed: ${reply.text}`);
  return device;
}

export async function revoke(vault: Vault, device: Device): Promise<Reply> {
  const key = epochKey(currentKey(vault).epoch + 1);
  const entry = await draftEntry(vault, vault.founder, {
    kind: "revocation",
    revoked: device.id,
    cutoff: device.tail ?? null,
    key,
  });

  const reply = await extend(vault, entry);
  if (reply.status === 200) vault.keys.push(key);

  return reply;
}

export async function rotate(vault: Vault): Promise<void> {
  const key = epochKey(currentKey(vault).epoch + 1);
  const reply = await extend(vault, await draftEntry(vault, vault.founder, { kind: "epoch", key }));
  if (reply.status !== 200) throw new Error(`rotation failed: ${reply.text}`);

  vault.keys.push(key);
}

export async function authored(
  author: Device,
  key: EpochKey,
  plaintext: unknown,
  id: string = Bun.randomUUIDv7("hex"),
): Promise<AuthoredEvent> {
  const envelope = await seal(
    await subkey(key, "events"),
    new TextEncoder().encode(JSON.stringify(plaintext)),
    id,
  );

  const { event, tail } = await signEvent(
    { id: author.id, keys: author.sign },
    id,
    envelope,
    author.tail,
  );

  author.tail = tail;

  return event;
}

export function wire(event: AuthoredEvent) {
  return {
    id: event.id,
    author: event.author,
    sequence: event.sequence,
    previous: hex(event.previous),
    envelope: toBase64(event.envelope),
    signature: toBase64(event.signature),
  };
}

export async function push(
  vault: Vault,
  device: Device,
  events: readonly AuthoredEvent[],
  history = false,
): Promise<Reply> {
  return send(vault.hub, device, "POST", history ? "/v1/events?history=1" : "/v1/events", {
    events: events.map(wire),
  });
}

export async function sealBlob(key: EpochKey, id: Id, content: string): Promise<string> {
  return toBase64(await seal(await subkey(key, "blobs"), new TextEncoder().encode(content), id));
}

export async function leaseOf(vault: Vault, project: string, plan: string): Promise<string> {
  const first = vault.keys[0];
  if (first === undefined) throw new Error("a vault holds epoch 1");
  return leaseKey(await subkey(first, "leases"), project, plan);
}

export async function joinBody(device: Device, invite: Id, expires = Date.now() + 60 * 60 * 1000) {
  const request = {
    invite,
    device: device.id,
    signing: device.sign.publicKey,
    wrapping: device.wrap.publicKey,
    nonce: randomId(),
  };

  const signature = await sign("join", device.sign, canonicalJoin(request));
  return {
    request: {
      ...request,
      signing: toBase64(request.signing),
      wrapping: toBase64(request.wrapping),
    },
    mac: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    signature: toBase64(signature),
    expires,
  };
}

export function hubPool() {
  const hubs: HubFixture[] = [];
  afterEach(async () => {
    restoreClock();
    await Promise.all(hubs.splice(0).map((hub) => hub.stop()));
  });

  const hub = async () => {
    const started = await startHubFixture();
    hubs.push(started);
    return started;
  };

  return { hub, vault: async () => foundVault(await hub()) };
}

export function count(hub: HubFixture, table: string): number {
  const db = new Database(join(hub.dir, "hub.db"), { readonly: true });
  try {
    return db.query<{ n: number }, []>(`SELECT count(*) AS n FROM ${table}`).get()?.n ?? -1;
  } finally {
    db.close();
  }
}

export function pendingDevices(hub: HubFixture): Set<string> {
  const db = new Database(join(hub.dir, "hub.db"), { readonly: true });
  try {
    return new Set(
      db
        .query<{ device: string }, []>("SELECT device FROM pending")
        .all()
        .map((row) => row.device),
    );
  } finally {
    db.close();
  }
}

export function writable(hub: HubFixture, sql: string): void {
  const db = new Database(join(hub.dir, "hub.db"));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}
