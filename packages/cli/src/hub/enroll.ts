import {
  CryptoRefusal,
  Invite,
  RECOVERY,
  canonicalJoin,
  decodeInvite,
  decodeRecovery,
  encodeInvite,
  encodeRecovery,
  epochKey,
  eventHash,
  fromHex,
  joinMac,
  newInvite,
  parseId,
  randomId,
  recoveryKeys,
  recoverySecret,
  rootFingerprint,
  sign,
  signEntry,
  verifyChain,
  verifyJoin,
  type AuthorTail,
  type Bytes,
  type Entry,
  type EpochKey,
  type Id,
  type JoinRequest,
  type Member,
  type Membership,
} from "skills-core";
import { hold, markSeen, seen } from "../plans/outbox.ts";
import type { Store } from "../plans/store.ts";
import { HubRefusal, Offline, type HubClient, type HubSigner } from "./client.ts";
import { KeyStoreError, type DeviceKeys, type KeyStore } from "./keys.ts";
import {
  ForkDetected,
  adopt,
  dropInvite,
  epochKeys,
  hasInvite,
  heldEpochs,
  liveInvites,
  openLabel,
  readLocal,
  readOutgoing,
  readPending,
  readable,
  saveInvite,
  sealLabel,
  setDevice,
  setOutgoing,
  setPending,
  verifiedLocal,
  type Local,
  type Outgoing,
  type StoredInvite,
} from "./vault.ts";

export type Deps = {
  readonly store: Store;
  readonly keys: KeyStore;
  readonly connect: (url: string, deadline?: number) => Promise<HubClient>;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly out: (line: string) => void;
  readonly quiet?: boolean;
};

export class EnrollRefusal extends Error {
  override name = "EnrollRefusal";
}

export type Enrolled = {
  readonly client: HubClient;
  readonly device: Id;
  readonly keys: DeviceKeys;
  readonly signer: HubSigner;
  readonly wires: readonly Bytes[];
  readonly membership: Membership;
  readonly epochKeys: ReadonlyMap<number, EpochKey>;
};

export const RECOVERY_WARNING =
  "This recovery code is never shown again. It is full vault authority: whoever holds it reads every plan and can enroll devices.";

const HUB_SENTENCES: Readonly<Record<string, string>> = {
  "vault-exists": "hub has a vault",
  "invite-consumed": "invite consumed",
  "invite-expired": "invite expired",
  "recovery-revoked": "recovery identity revoked",
  "device-revoked": "device revoked",
  "init-code": "the init code does not match",
  "no-vault": "the hub holds no vault yet",
  "chain-moved": "the membership chain moved, run the verb again",
  "chain-fork": "the membership chain moved, run the verb again",
};

const MOVED = new Set(["chain-moved", "chain-fork"]);

const CRYPTO_SENTENCES: Partial<Record<CryptoRefusal["reason"], string>> = {
  "chain-root": "the hub's founding entry is not this vault's",
  "chain-fork": "fork detected",
  checksum: "the code does not match its checksum",
};

export function sentence(error: unknown): string | undefined {
  if (error instanceof HubRefusal)
    return HUB_SENTENCES[error.reason] ?? `the hub refused: ${error.message}`;

  if (error instanceof CryptoRefusal) return CRYPTO_SENTENCES[error.reason] ?? error.message;
  if (error instanceof Offline || error instanceof ForkDetected) return error.message;
  if (error instanceof EnrollRefusal || error instanceof KeyStoreError) return error.message;
  return undefined;
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return Buffer.from(left).equals(Buffer.from(right));
}

function refuse(message: string): never {
  throw new EnrollRefusal(message);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function bytesOf(value: unknown): Bytes {
  if (typeof value !== "string") throw new Offline("the hub sent bytes that are not base64");
  return new Uint8Array(Buffer.from(value, "base64"));
}

function wiresOf(value: unknown): Bytes[] {
  if (!Array.isArray(value)) throw new Offline("the hub sent no entry list");
  return value.map(bytesOf);
}

function hubLength(body: Record<string, unknown>): number {
  if (typeof body.length !== "number") throw new Offline("the hub sent no chain length");
  return body.length;
}

export function recoveryLine(code: string): string {
  return `recovery code ${code.split(RECOVERY.separator).join(" ")}`;
}

async function ownKeys(deps: Deps, device: Id): Promise<DeviceKeys> {
  const known = await deps.keys.read(device);
  if (known !== "not enrolled") return known;

  await deps.keys.delete(device);
  return deps.keys.create(device);
}

function sameKeys(member: Pick<Member, "signing" | "wrapping">, keys: DeviceKeys): boolean {
  return equal(member.signing, keys.sign.publicKey) && equal(member.wrapping, keys.wrap.publicKey);
}

function chainRefusal(known: number): (error: unknown) => never {
  return (error) => {
    if (!(error instanceof CryptoRefusal)) throw error;

    const forked =
      error.reason === "chain-fork" ||
      error.reason === "chain-root" ||
      (error.reason === "chain-link" && error.entry === known);

    if (forked) throw new ForkDetected();
    throw new Offline(`the hub's chain does not verify: ${error.message}`);
  };
}

async function extend(
  deps: Deps,
  membership: Membership,
  wires: readonly Bytes[],
): Promise<{ wires: Bytes[]; membership: Membership }> {
  const next = await verifyChain(wires, membership.checkpoint).catch(
    chainRefusal(membership.checkpoint.length),
  );

  if (wires.length > membership.checkpoint.length) adopt(deps.store, wires, next);
  return { wires: [...wires], membership: next };
}

async function pushChainTail(enrolled: Enrolled, from: number): Promise<void> {
  const { wires, client, signer } = enrolled;
  const entries = wires.slice(from).map(base64);
  await client.call("POST", "/v1/membership", { from, entries }, signer);
}

async function pull(deps: Deps, enrolled: Enrolled, repair = false): Promise<Enrolled> {
  const { wires, membership, client, signer } = enrolled;
  const body = await client.call("GET", `/v1/membership?after=${wires.length}`, undefined, signer);
  const all = [...wires, ...wiresOf(body.entries)];

  const held = hubLength(body);
  if (held < wires.length) {
    if (!repair)
      throw new Offline(`the hub holds ${held} of this store's ${wires.length} chain entries`);

    await pushChainTail(enrolled, held);
    return pull(deps, enrolled);
  }

  if (held !== all.length) throw new Offline("the hub's chain length does not add up");

  const next = await extend(deps, membership, all);
  const keys = await epochKeys(next.membership, enrolled.device, enrolled.keys.wrap);
  await announce(deps, next.membership, keys);

  return { ...enrolled, ...next, epochKeys: keys };
}

type Draft = (enrolled: Enrolled) => Promise<Bytes | undefined>;

async function send(deps: Deps, current: Enrolled, wire: Bytes): Promise<void> {
  const { wires, client, signer } = current;
  setOutgoing(deps.store, { from: wires.length, wire });
  await client.call(
    "POST",
    "/v1/membership",
    { from: wires.length, entries: [base64(wire)] },
    signer,
  );
}

async function post(
  deps: Deps,
  start: Enrolled,
  draft: Draft,
): Promise<{ enrolled: Enrolled; wire?: Bytes }> {
  let current = start;
  for (let attempt = 0; ; attempt++) {
    const wire = await draft(current);
    if (wire === undefined) return { enrolled: current };

    try {
      await send(deps, current, wire);
      return { enrolled: current, wire };
    } catch (error) {
      if (!(error instanceof HubRefusal) || !MOVED.has(error.reason) || attempt > 0) throw error;
      current = await pull(deps, current);
    }
  }
}

async function settled(deps: Deps, enrolled: Enrolled, wire: Bytes): Promise<Enrolled> {
  const next = await extend(deps, enrolled.membership, [...enrolled.wires, wire]);
  setOutgoing(deps.store, undefined);

  const keys = await epochKeys(next.membership, enrolled.device, enrolled.keys.wrap);
  return { ...enrolled, ...next, epochKeys: keys };
}

const LOST_ROTATION =
  "a recovery rotation landed without its code being shown, run skills hub recovery rotate again";

async function resolveOutgoing(deps: Deps, start: Enrolled): Promise<Enrolled> {
  const outgoing = readOutgoing(deps.store);
  if (outgoing === undefined || start.wires.length < outgoing.from) return start;

  let current = start;
  if (current.wires.length === outgoing.from) {
    try {
      await send(deps, current, outgoing.wire);
      current = await settled(deps, current, outgoing.wire);
      await announce(deps, current.membership, current.epochKeys);
    } catch (error) {
      if (!(error instanceof HubRefusal) || !MOVED.has(error.reason)) throw error;
      current = await pull(deps, current);
    }
  }

  const slot = current.wires[outgoing.from];
  if (slot === undefined) return current;

  setOutgoing(deps.store, undefined);
  const entry = current.membership.entries[outgoing.from];
  if (equal(slot, outgoing.wire) && entry?.change.kind === "recovery") deps.out(LOST_ROTATION);

  return current;
}

function signer(enrolled: Enrolled) {
  return { kind: "device" as const, id: enrolled.device, keys: enrolled.keys.sign };
}

export async function labelOf(
  membership: Membership,
  keys: ReadonlyMap<number, EpochKey>,
  id: Id | "recovery",
): Promise<string> {
  if (id === "recovery") return "recovery";
  const member = membership.devices.get(id);
  return (member && (await openLabel(keys, member))) ?? id;
}

export async function describe(
  entry: Entry,
  membership: Membership,
  keys: ReadonlyMap<number, EpochKey>,
): Promise<string> {
  const label = (id: Id | "recovery") => labelOf(membership, keys, id);
  const by = await label(entry.signer.kind === "recovery" ? "recovery" : entry.signer.id);

  const { change } = entry;
  if (change.kind === "founding") return `vault founded by ${by}`;
  if (change.kind === "device") return `device ${await label(change.device.id)} added by ${by}`;
  if (change.kind === "revocation") return `device ${await label(change.revoked)} revoked by ${by}`;
  return `epoch ${change.epoch} started by ${by}`;
}

export async function announce(
  deps: Deps,
  membership: Membership,
  known?: ReadonlyMap<number, EpochKey>,
): Promise<{ membership: Membership; keys: ReadonlyMap<number, EpochKey> }> {
  const device = readLocal(deps.store).device;
  const own = device === undefined ? "not enrolled" : await deps.keys.read(device);
  const keys =
    known ??
    (device === undefined || own === "not enrolled"
      ? new Map<number, EpochKey>()
      : await epochKeys(membership, device, own.wrap));

  if (deps.quiet === true) return { membership, keys };

  const from = seen(deps.store);
  for (const entry of membership.entries.slice(from))
    deps.out(await describe(entry, membership, keys));

  if (membership.entries.length > from) markSeen(deps.store, membership.entries.length);
  return { membership, keys };
}

export async function enrolled(
  deps: Deps,
  url: string,
  writes = true,
  connected?: HubClient,
  deadline?: number,
): Promise<Enrolled> {
  const local = readLocal(deps.store);
  const membership = await verifiedLocal(local);
  const device = local.device;
  const member = device === undefined ? undefined : membership?.devices.get(device);
  if (membership === undefined || device === undefined || member === undefined)
    refuse("this store is not enrolled, run skills hub init, join or recover");

  if (member.revoked !== undefined) refuse("device revoked");

  const keys = await deps.keys.read(device);
  if (keys === "not enrolled" || !sameKeys(member, keys))
    refuse(`the keys of device ${device} are missing, so this store cannot sign`);

  const client = connected ?? (await deps.connect(url, deadline));
  const start: Enrolled = {
    client,
    device,
    keys,
    signer: { device, keys: keys.sign },
    wires: local.wires,
    membership,
    epochKeys: await epochKeys(membership, device, keys.wrap),
  };

  const pulled = await pull(deps, start, writes);
  return writes ? resolveOutgoing(deps, pulled) : pulled;
}

function allEpochs(enrolled: Enrolled): EpochKey[] {
  const { epoch } = enrolled.membership.checkpoint;
  const keys = heldEpochs(enrolled.epochKeys, epoch);
  if (keys.length !== epoch)
    refuse(`this device holds ${keys.length} of the vault's ${epoch} epoch keys`);

  return keys;
}

function currentKey(enrolled: Enrolled): EpochKey {
  return allEpochs(enrolled).at(-1) ?? refuse("this device holds no epoch key");
}

async function deviceFor(
  deps: Deps,
  local: Local,
  membership: Membership | undefined,
  reuse = true,
): Promise<{ device: Id; keys: DeviceKeys }> {
  const known = local.device;
  const member = known === undefined ? undefined : membership?.devices.get(known);
  if (member !== undefined && member.revoked === undefined)
    refuse("this store is already enrolled");

  const unused = known !== undefined && member === undefined;
  const device = unused && reuse ? known : randomId();
  if (unused && device !== known) await deps.keys.delete(known);

  const keys = await ownKeys(deps, device);
  if (member !== undefined && known !== undefined) hold(deps.store, known);
  if (device !== known) setDevice(deps.store, device);

  return { device, keys };
}

async function adoptAndShow(
  deps: Deps,
  wires: readonly Bytes[],
  membership: Membership,
  keys: ReadonlyMap<number, EpochKey>,
): Promise<void> {
  adopt(deps.store, wires, membership);
  setPending(deps.store, undefined);
  await announce(deps, membership, keys);

  deps.out(`head ${Buffer.from(membership.checkpoint.head).toString("hex")}`);
}

async function claimOwnFounding(
  deps: Deps,
  client: HubClient,
  device: Id,
  keys: DeviceKeys,
): Promise<boolean> {
  let wires: Bytes[];
  try {
    const body = await client.call("GET", "/v1/membership?after=0", undefined, {
      device,
      keys: keys.sign,
    });

    wires = wiresOf(body.entries);
  } catch (error) {
    if (error instanceof HubRefusal) return false;
    throw error;
  }

  const founding = wires[0];
  if (founding === undefined) return false;

  const membership = await verifyChain(wires, { fingerprint: await rootFingerprint(founding) });
  const first = membership.entries[0]?.change;
  const member = membership.devices.get(device);
  if (
    first?.kind !== "founding" ||
    first.device.id !== device ||
    !member ||
    !sameKeys(member, keys)
  )
    return false;

  adopt(deps.store, wires, membership);
  markSeen(deps.store, wires.length);
  return true;
}

export async function init(
  deps: Deps,
  url: string,
  code: string,
  label: string,
): Promise<"reseed" | "minted"> {
  const local = readLocal(deps.store);
  const client = await deps.connect(url);
  if (local.checkpoint !== undefined) {
    await verifiedLocal(local);

    try {
      await client.call("POST", "/v1/vault", { code, entries: local.wires.map(base64) }, undefined);
    } catch (error) {
      if (error instanceof HubRefusal && error.reason === "vault-exists") return "reseed";
      throw error;
    }

    deps.out(
      `chain ${local.wires.length} ${local.wires.length === 1 ? "entry" : "entries"} pushed`,
    );

    return "reseed";
  }

  const { device, keys } = await deviceFor(deps, local, undefined);
  const secret = recoverySecret();
  const recovery = await recoveryKeys(secret);
  const key = epochKey(1);
  const wire = await signEntry(
    { kind: "device", id: device, keys: keys.sign },
    {
      kind: "founding",
      device: {
        id: device,
        signing: keys.sign.publicKey,
        wrapping: keys.wrap.publicKey,
        label: await sealLabel(key, device, label),
      },
      recovery: { signing: recovery.signing.publicKey, wrapping: recovery.wrapping.publicKey },
      key,
    },
  );

  const fingerprint = await rootFingerprint(wire);
  const membership = await verifyChain([wire], { fingerprint });

  try {
    await client.call("POST", "/v1/vault", { code, entries: [base64(wire)] }, undefined);
  } catch (error) {
    if (!(error instanceof HubRefusal) || error.reason !== "vault-exists") throw error;
    if (!(await claimOwnFounding(deps, client, device, keys))) refuse("hub has a vault");

    setPending(deps.store, undefined);
    deps.out("if no recovery code was printed, run skills hub recovery rotate");
    deps.out(`device ${label} ${device} enrolled`);
    return "minted";
  }

  deps.out(RECOVERY_WARNING);
  deps.out(recoveryLine(await encodeRecovery(secret, fingerprint)));

  adopt(deps.store, [wire], membership);
  markSeen(deps.store, 1);
  setPending(deps.store, undefined);

  deps.out(`device ${label} ${device} enrolled`);
  return "minted";
}

type PendingRequest = { request: JoinRequest; mac: Bytes };

function pendingRequests(body: Record<string, unknown>): PendingRequest[] {
  if (!Array.isArray(body.requests)) throw new Offline("the hub sent no join request list");

  return body.requests.flatMap((raw: Record<string, Record<string, unknown>>) => {
    try {
      const request = raw.request ?? {};
      return [
        {
          request: {
            invite: parseId(String(request.invite)),
            device: parseId(String(request.device)),
            signing: bytesOf(request.signing),
            wrapping: bytesOf(request.wrapping),
            nonce: parseId(String(request.nonce)),
          },
          mac: bytesOf(raw.mac),
        },
      ];
    } catch {
      return [];
    }
  });
}

function joinDraft(deps: Deps, stored: StoredInvite, request: JoinRequest): Draft {
  return async (current) => {
    if (!hasInvite(deps.store, stored.id) || current.membership.devices.has(request.device))
      return undefined;

    const draft = {
      kind: "device" as const,
      device: {
        id: request.device,
        signing: new Uint8Array(request.signing),
        wrapping: new Uint8Array(request.wrapping),
        label: await sealLabel(currentKey(current), request.device, stored.label),
      },
      invite: stored.id,
      keys: allEpochs(current),
    };

    return signEntry(signer(current), draft, current.membership);
  };
}

export async function settle(deps: Deps, start: Enrolled): Promise<Enrolled> {
  let current = start;
  const invites = liveInvites(deps.store, 0);
  if (invites.length === 0) return current;

  const body = await current.client.call("GET", "/v1/pending", undefined, current.signer);
  for (const { request, mac } of pendingRequests(body)) {
    const stored = invites.find((invite) => invite.id === request.invite);
    if (stored === undefined) continue;

    const invite = new Invite(
      { ...stored, checkpoint: current.membership.checkpoint },
      stored.secret,
    );

    try {
      await verifyJoin(invite, request, mac, deps.now());
    } catch (error) {
      if (!(error instanceof CryptoRefusal)) throw error;

      deps.out(`join refused for invite ${stored.label}: ${error.message}`);
      if (error.reason === "invite-expired") dropInvite(deps.store, stored.id);
      continue;
    }

    let posted: Awaited<ReturnType<typeof post>>;
    try {
      posted = await post(deps, current, joinDraft(deps, stored, request));
    } catch (error) {
      if (!(error instanceof CryptoRefusal)) throw error;
      deps.out(`join refused for invite ${stored.label}: ${error.message}`);
      continue;
    }

    current =
      posted.wire === undefined
        ? posted.enrolled
        : await settled(deps, posted.enrolled, posted.wire);

    if (posted.wire !== undefined) await announce(deps, current.membership, current.epochKeys);
  }

  return current;
}

export type InviteOptions = {
  readonly label: string | undefined;
  readonly lasts: number;
  readonly wait: boolean;
};

export async function invite(deps: Deps, url: string, options: InviteOptions): Promise<number> {
  let current = await enrolled(deps, url);
  const now = deps.now();
  const label = options.label ?? `device ${current.membership.devices.size + 1}`;
  const known = liveInvites(deps.store, now).find(
    (stored) => stored.label === label && stored.text !== undefined,
  );

  const made =
    known?.text === undefined
      ? newInvite({
          checkpoint: current.membership.checkpoint,
          expires: now + options.lasts,
          label,
        })
      : await decodeInvite(known.text);

  const text = known?.text ?? (await encodeInvite(made));
  if (known === undefined) saveInvite(deps.store, { ...made, secret: made.secret, text }, now);

  deps.out(`skills hub join ${current.client.url} ${text}`);
  if (!options.wait) return 0;

  for (;;) {
    current = await settle(deps, current);
    if (!hasInvite(deps.store, made.id)) return 0;

    if (deps.now() > made.expires) {
      dropInvite(deps.store, made.id);
      deps.out("invite expired");
      return 1;
    }

    await deps.sleep(2000);
    current = await pull(deps, current);
  }
}

async function joinState(client: HubClient, invite: Id, signer: HubSigner): Promise<string> {
  const body = await client.call("GET", `/v1/pair/${invite}`, undefined, signer);
  return String(body.state);
}

function unknownDevice(error: unknown): undefined {
  if (error instanceof HubRefusal && error.reason === "device-unknown") return undefined;
  throw error;
}

async function postJoin(
  client: HubClient,
  invite: Invite,
  joiner: { device: Id; keys: DeviceKeys; nonce: Id },
): Promise<void> {
  const { device, keys, nonce } = joiner;
  const request: JoinRequest = {
    invite: invite.id,
    device,
    signing: keys.sign.publicKey,
    wrapping: keys.wrap.publicKey,
    nonce,
  };

  const body = {
    request: { ...request, signing: base64(request.signing), wrapping: base64(request.wrapping) },
    mac: base64(await joinMac(invite.secret, request)),
    signature: base64(await sign("join", keys.sign, canonicalJoin(request))),
    expires: invite.expires,
  };

  await client.call("POST", "/v1/pair", body, undefined);
}

async function verifyJoined(
  wires: readonly Bytes[],
  invite: Invite,
  local: Local,
): Promise<Membership> {
  let membership: Membership;
  try {
    membership = await verifyChain(wires, invite.checkpoint);
  } catch (error) {
    if (!(error instanceof CryptoRefusal)) throw error;
    if (error.reason === "chain-root")
      refuse("the hub's founding entry is not the one the invite names");

    if (error.reason === "chain-fork")
      refuse("the hub's chain does not extend the invite's checkpoint");

    throw error;
  }

  if (local.checkpoint !== undefined)
    await verifyChain(wires, local.checkpoint).catch(chainRefusal(local.checkpoint.length));

  return membership;
}

async function revokedHere(
  deps: Deps,
  client: HubClient,
  local: Local,
  stored: Membership | undefined,
): Promise<Local> {
  const device = local.device;
  const member = device === undefined ? undefined : stored?.devices.get(device);
  if (device === undefined || member === undefined || member.revoked !== undefined) return local;

  const keys = await deps.keys.read(device);
  if (keys === "not enrolled") refuse(`the keys of device ${device} are missing`);

  try {
    await client.call("GET", `/v1/membership?after=${local.wires.length}`, undefined, {
      device,
      keys: keys.sign,
    });
  } catch (error) {
    if (error instanceof HubRefusal && error.reason === "device-revoked") {
      hold(deps.store, device);
      return { ...local, device: undefined };
    }

    throw error;
  }

  return refuse("this store is already enrolled");
}

export async function join(deps: Deps, url: string, text: string): Promise<void> {
  const invite = await decodeInvite(text);
  const local = readLocal(deps.store);
  const stored = await verifiedLocal(local);

  if (
    local.checkpoint !== undefined &&
    !equal(local.checkpoint.fingerprint, invite.checkpoint.fingerprint)
  )
    refuse("this store belongs to another vault");

  const client = await deps.connect(url);
  const current = await revokedHere(deps, client, local, stored);
  const pending = readPending(deps.store);
  const reused = pending?.invite === invite.id ? pending : undefined;
  const { device, keys } =
    reused === undefined
      ? await deviceFor(deps, current, stored, pending === undefined)
      : { device: reused.device, keys: await ownKeys(deps, reused.device) };

  const nonce = reused?.nonce ?? randomId();
  if (reused === undefined) setPending(deps.store, { invite: invite.id, device, nonce });

  const signer = { device, keys: keys.sign };
  const known =
    reused === undefined
      ? undefined
      : await joinState(client, invite.id, signer).catch(unknownDevice);

  if (known === undefined) {
    if (deps.now() > invite.expires) refuse("invite expired");
    await postJoin(client, invite, { device, keys, nonce });
  }

  for (let state = known ?? "pending"; state !== "enrolled";) {
    if (state === "expired" || deps.now() > invite.expires) refuse("invite expired");
    await deps.sleep(1000);
    state = await joinState(client, invite.id, signer);
  }

  const body = await client.call("GET", "/v1/membership?after=0", undefined, signer);
  const wires = wiresOf(body.entries);
  const membership = await verifyJoined(wires, invite, local);
  const member = membership.devices.get(device);
  if (member === undefined || member.revoked !== undefined || !sameKeys(member, keys))
    refuse("the hub's chain holds no entry for this device");

  await adoptAndShow(deps, wires, membership, await epochKeys(membership, device, keys.wrap));
  deps.out("enrolled");
}

async function cutoffOf(store: Store, author: Id): Promise<AuthorTail | null> {
  const row = store.db
    .query(
      `SELECT id, sequence, previous, envelope, signature FROM events
       WHERE author = ? AND quarantined IS NULL AND envelope IS NOT NULL
       ORDER BY sequence DESC LIMIT 1`,
    )
    .get(author) as {
    id: string;
    sequence: number;
    previous: string;
    envelope: Uint8Array;
    signature: Uint8Array;
  } | null;

  if (row === null) return null;

  const hash = await eventHash({
    id: row.id,
    author,
    sequence: row.sequence,
    previous: fromHex(row.previous),
    envelope: new Uint8Array(row.envelope),
    signature: new Uint8Array(row.signature),
  });

  return { sequence: row.sequence, hash };
}

async function findDevice(enrolled: Enrolled, named: string): Promise<Member> {
  const members = [...enrolled.membership.devices.values()];
  const byId = members.find((member) => member.id === named);
  if (byId !== undefined) return byId;

  const labelled: Member[] = [];
  for (const member of members)
    if ((await openLabel(enrolled.epochKeys, member)) === named) labelled.push(member);

  if (labelled.length > 1)
    refuse(`${labelled.length} devices carry the label ${named}, name one by id`);

  return labelled[0] ?? refuse(`no device ${named}`);
}

function revokedLine(label: string, revocation: Entry): string {
  const { change } = revocation;
  if (change.kind !== "revocation") throw new TypeError("a revoked line names a revocation entry");
  return `revoked ${label}, epoch ${change.epoch}, cutoff ${change.cutoff.sequence}`;
}

function ownRevocation(enrolled: Enrolled, target: Id): Entry | undefined {
  const revoked = enrolled.membership.devices.get(target)?.revoked;
  const entry = revoked === undefined ? undefined : enrolled.membership.entries[revoked.entry];
  const mine = entry?.signer.kind === "device" && entry.signer.id === enrolled.device;
  return mine ? entry : undefined;
}

export async function revoke(deps: Deps, url: string, named: string): Promise<void> {
  const current = await enrolled(deps, url);
  const target = await findDevice(current, named);
  const label = await labelOf(current.membership, current.epochKeys, target.id);
  if (target.revoked !== undefined) {
    const revocation = ownRevocation(current, target.id);
    if (revocation === undefined) refuse(`device ${named} is already revoked`);

    deps.out(revokedLine(label, revocation));
    return;
  }

  if (target.id === current.device)
    refuse("revoke runs on another enrolled device, never on the one it revokes");

  const cutoff = await cutoffOf(deps.store, target.id);
  const posted = await post(deps, current, async (latest) => {
    if (latest.membership.devices.get(target.id)?.revoked !== undefined) return undefined;

    const key = epochKey(latest.membership.checkpoint.epoch + 1);
    return signEntry(
      signer(latest),
      { kind: "revocation", revoked: target.id, cutoff, key },
      latest.membership,
    );
  });

  if (posted.wire === undefined) {
    const revocation = ownRevocation(posted.enrolled, target.id);
    if (revocation === undefined) refuse(`device ${named} was revoked by another device meanwhile`);

    deps.out(revokedLine(label, revocation));
    return;
  }

  const next = await settled(deps, posted.enrolled, posted.wire);
  deps.out(
    revokedLine(label, next.membership.entries.at(-1) ?? refuse("the chain lost its revocation")),
  );
}

export async function rotateRecovery(deps: Deps, url: string): Promise<void> {
  const current = await enrolled(deps, url);
  const secret = recoverySecret();
  const recovery = await recoveryKeys(secret);
  const card = { signing: recovery.signing.publicKey, wrapping: recovery.wrapping.publicKey };
  const posted = await post(deps, current, async (latest) => {
    const keys = [...allEpochs(latest), epochKey(latest.membership.checkpoint.epoch + 1)];
    return signEntry(signer(latest), { kind: "recovery", recovery: card, keys }, latest.membership);
  }).catch((error: unknown) => {
    if (error instanceof Offline)
      deps.out(
        "if the hub took the rotation, the old code no longer works: run skills hub recovery rotate again",
      );

    throw error;
  });

  if (posted.wire === undefined) throw new TypeError("a recovery rotation always drafts an entry");

  deps.out(RECOVERY_WARNING);
  deps.out(recoveryLine(await encodeRecovery(secret, current.membership.checkpoint.fingerprint)));

  const next = await settled(deps, posted.enrolled, posted.wire);
  deps.out(`epoch ${next.membership.checkpoint.epoch}`);
}

async function recoveryEntry(
  outgoing: Outgoing | undefined,
  wires: readonly Bytes[],
  membership: Membership,
  device: Id,
  keys: DeviceKeys,
): Promise<Bytes | undefined> {
  if (outgoing === undefined || outgoing.from !== membership.checkpoint.length) return undefined;

  const extended = await verifyChain([...wires, outgoing.wire], membership.checkpoint).catch(
    () => undefined,
  );

  const entry = extended?.entries.at(-1);
  const change = entry?.change;
  const enrolls =
    entry?.signer.kind === "recovery" &&
    change?.kind === "device" &&
    change.device.id === device &&
    sameKeys(change.device, keys);

  return enrolls ? outgoing.wire : undefined;
}

export async function recover(deps: Deps, url: string, text: string, label: string): Promise<void> {
  const code = await decodeRecovery(text.trim());
  const identity = await recoveryKeys(code.secret);
  const local = readLocal(deps.store);
  await verifiedLocal(local);

  if (local.checkpoint !== undefined && !equal(local.checkpoint.fingerprint, code.fingerprint))
    refuse("this store belongs to another vault");

  const client = await deps.connect(url);
  const signer: HubSigner = { device: "recovery", keys: identity.signing };
  const body = await client.call("GET", "/v1/recover", undefined, signer);
  const wires = wiresOf(body.entries);

  let membership: Membership;
  try {
    membership = await verifyChain(wires, { fingerprint: code.fingerprint });
  } catch (error) {
    if (error instanceof CryptoRefusal && error.reason === "chain-root")
      refuse("the hub's founding entry is not the one the recovery code names");

    throw error;
  }

  if (local.checkpoint !== undefined)
    await verifyChain(wires, local.checkpoint).catch(chainRefusal(local.checkpoint.length));

  if (!equal(membership.recovery.signing, identity.signing.publicKey))
    refuse("recovery identity revoked");

  const held = await epochKeys(membership, "recovery", identity.wrapping);
  const { epoch } = membership.checkpoint;
  const keys = heldEpochs(held, epoch);
  if (keys.length !== epoch)
    refuse(`the recovery identity holds ${keys.length} of the vault's ${epoch} epoch keys`);

  const already = local.device === undefined ? undefined : membership.devices.get(local.device);
  const ownKnown = local.device === undefined ? "not enrolled" : await deps.keys.read(local.device);
  if (
    already !== undefined &&
    already.revoked === undefined &&
    ownKnown !== "not enrolled" &&
    sameKeys(already, ownKnown)
  ) {
    await adoptAndShow(deps, wires, membership, held);
    setOutgoing(deps.store, undefined);
    deps.out(`device ${label} ${already.id} enrolled`);
    return;
  }

  const lost = already !== undefined && already.revoked === undefined;
  if (lost) hold(deps.store, already.id);

  const { device, keys: own } = await deviceFor(
    deps,
    lost ? { ...local, device: undefined } : local,
    membership,
  );

  if (lost) deps.out(`device ${already.id} has no keys here, revoke it from an enrolled device`);

  const saved = await recoveryEntry(readOutgoing(deps.store), wires, membership, device, own);
  const wire =
    saved ??
    (await signEntry(
      { kind: "recovery", keys: identity.signing },
      {
        kind: "device",
        device: {
          id: device,
          signing: own.sign.publicKey,
          wrapping: own.wrap.publicKey,
          label: await sealLabel(keys.at(-1) ?? refuse("no epoch key"), device, label),
        },
        invite: null,
        keys,
      },
      membership,
    ));

  setOutgoing(deps.store, { from: membership.checkpoint.length, wire });
  await client.call("POST", "/v1/recover", { entry: base64(wire) }, signer);

  const all = [...wires, wire];
  const extended = await verifyChain(all, membership.checkpoint);
  if (extended.devices.get(device)?.revoked !== undefined || !extended.devices.has(device))
    refuse("the recovered entry does not name this device");

  await adoptAndShow(deps, all, extended, held);
  setOutgoing(deps.store, undefined);
  deps.out(`device ${label} ${device} enrolled`);
}

export type DeviceLine = {
  readonly id: Id | "recovery";
  readonly label: string;
  readonly state: "enrolled" | "revoked";
  readonly epochs: string;
};

async function deviceLines(
  membership: Membership,
  keys: ReadonlyMap<number, EpochKey>,
): Promise<DeviceLine[]> {
  const range = (id: Id | "recovery") => {
    const found = readable(membership, id);
    return found === undefined ? "-" : `${found.first}..${found.last}`;
  };

  const lines: DeviceLine[] = [];
  for (const member of membership.devices.values())
    lines.push({
      id: member.id,
      label: await labelOf(membership, keys, member.id),
      state: member.revoked === undefined ? "enrolled" : "revoked",
      epochs: range(member.id),
    });

  lines.push({ id: "recovery", label: "recovery", state: "enrolled", epochs: range("recovery") });
  return lines;
}

async function localView(
  deps: Deps,
): Promise<{ membership: Membership; keys: ReadonlyMap<number, EpochKey> } | undefined> {
  const local = readLocal(deps.store);
  const membership = await verifiedLocal(local);
  if (membership === undefined || local.device === undefined) return undefined;

  const own = await deps.keys.read(local.device);
  const keys =
    own === "not enrolled"
      ? new Map<number, EpochKey>()
      : await epochKeys(membership, local.device, own.wrap);

  return { membership, keys };
}

export async function devices(deps: Deps): Promise<void> {
  const view = await localView(deps);
  if (view === undefined)
    refuse("this store is not enrolled, run skills hub init, join or recover");

  for (const line of await deviceLines(view.membership, view.keys))
    deps.out(`${line.id} ${line.label} ${line.state} ${line.epochs}`);
}
