import { LAYOUT, canonicalJoin, verify, type Id, type JoinRequest } from "skills-core";
import { Refusal, refusalJson } from "./refusal.ts";
import { KIB, MEMBER, ok, type Answer, type Context, type Effect, type Route } from "./route.ts";
import type { Tx } from "./store.ts";
import { base64, count, idOf, parseBody, same, shape, toBase64 } from "./wire.ts";

const WEEK = 7 * 24 * 60 * 60 * 1000;

const LINGER = 24 * 60 * 60 * 1000;

const PER_INVITE = 4;

const LIVE_MAX = 256;

const RETAINED_MAX = 4 * LIVE_MAX;

const PURGE_MAX = 256;

type PendingRow = {
  invite: string;
  device: string;
  signing: Uint8Array;
  wrapping: Uint8Array;
  nonce: string;
  mac: Uint8Array;
  signature: Uint8Array;
  expires: number;
};

function joinOf(value: unknown): JoinRequest {
  const record = shape(value, ["invite", "device", "signing", "wrapping", "nonce"]);
  return {
    invite: idOf(record.invite, "invite"),
    device: idOf(record.device, "device"),
    signing: base64(record.signing, "signing", LAYOUT.key),
    wrapping: base64(record.wrapping, "wrapping", LAYOUT.key),
    nonce: idOf(record.nonce, "nonce"),
  };
}

function sameRow(left: PendingRow, right: PendingRow): boolean {
  return (
    left.invite === right.invite &&
    same(left.signing, right.signing) &&
    same(left.wrapping, right.wrapping) &&
    left.nonce === right.nonce &&
    same(left.mac, right.mac) &&
    same(left.signature, right.signature)
  );
}

function purgeBefore(tx: Tx, cutoff: number, limit: number): number {
  return tx
    .query<never, { cutoff: number; limit: number }>(
      "DELETE FROM pending WHERE rowid IN (SELECT rowid FROM pending WHERE expires < $cutoff ORDER BY expires, device LIMIT $limit)",
    )
    .run({ cutoff, limit }).changes;
}

function purgeExpired(tx: Tx, now: number): number {
  return purgeBefore(tx, now - LINGER, PURGE_MAX);
}

function retainedCount(tx: Tx): number {
  const row = tx
    .query<{ n: number }, { cap: number }>(
      "SELECT count(*) AS n FROM (SELECT 1 FROM pending LIMIT $cap)",
    )
    .get({ cap: RETAINED_MAX + PURGE_MAX });

  return row?.n ?? 0;
}

function roomFor(tx: Tx, now: number, budget: number): boolean {
  const retained = retainedCount(tx);
  if (retained < RETAINED_MAX) return true;

  const evicted = purgeBefore(tx, now, Math.min(retained - (RETAINED_MAX - 1), budget));
  return retained - evicted < RETAINED_MAX;
}

function pendingFull(): Answer {
  const refusal = new Refusal("pending-full");
  // Answered rather than refused so settled commits the rows this request purged.
  return { status: refusal.status, body: refusalJson(refusal) };
}

function liveCount(tx: Tx, now: number, invite?: string): number {
  const row = tx
    .query<{ n: number }, { now: number; invite: string | null }>(
      "SELECT count(*) AS n FROM pending WHERE expires >= $now AND ($invite IS NULL OR invite = $invite)",
    )
    .get({ now, invite: invite ?? null });

  return row?.n ?? 0;
}

async function postPair(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["request", "mac", "signature", "expires"]);
  const { chain } = context;
  if (chain.kind === "empty") throw new Refusal("no-vault");

  const request = joinOf(body.request);
  const mac = base64(body.mac, "mac", LAYOUT.hash);
  const signature = base64(body.signature, "signature", LAYOUT.signature);
  try {
    await verify("join", request.signing, canonicalJoin(request), signature);
  } catch {
    throw new Refusal("join-signature");
  }

  const now = context.hub.now();
  const claimed = count(body.expires, "expires");
  if (claimed < now) throw new Refusal("invite-expired");
  if (chain.membership.invitesUsed.has(request.invite)) throw new Refusal("invite-consumed");
  if (chain.membership.devices.has(request.device)) throw new Refusal("device-taken");

  const row: PendingRow = {
    invite: request.invite,
    device: request.device,
    signing: request.signing,
    wrapping: request.wrapping,
    nonce: request.nonce,
    mac,
    signature,
    expires: Math.min(claimed, now + WEEK),
  };

  return (tx) => {
    const purged = purgeExpired(tx, now);

    const existing = tx
      .query<PendingRow, { device: string }>("SELECT * FROM pending WHERE device = $device")
      .get({ device: row.device });

    if (existing !== null) {
      if (sameRow(existing, row)) return { status: 202, body: { state: "pending" } };
      return new Refusal("device-taken");
    }

    if (liveCount(tx, now, row.invite) >= PER_INVITE) return new Refusal("invite-full");
    if (liveCount(tx, now) >= LIVE_MAX || !roomFor(tx, now, PURGE_MAX - purged))
      return pendingFull();

    tx.query<never, PendingRow>(
      "INSERT INTO pending (invite, device, signing, wrapping, nonce, mac, signature, expires) VALUES ($invite, $device, $signing, $wrapping, $nonce, $mac, $signature, $expires)",
    ).run(row);

    return { status: 202, body: { state: "pending" } };
  };
}

async function pairState(context: Context): Promise<Effect> {
  const invite = idOf(context.params.invite, "invite");
  const { caller, chain } = context;
  if (chain.kind === "empty") throw new Refusal("no-vault");

  if (caller.kind === "member") {
    const entry = chain.membership.entries.find(
      (candidate) =>
        candidate.change.kind === "device" &&
        candidate.change.device.id === caller.device &&
        candidate.change.invite === invite,
    );

    if (entry === undefined) throw new Refusal("route");
    return ok({ state: "enrolled", entry: entry.index });
  }

  const now = context.hub.now();
  return (tx) => {
    purgeExpired(tx, now);

    const row = tx
      .query<{ expires: number }, { invite: string; device: string }>(
        "SELECT expires FROM pending WHERE invite = $invite AND device = $device",
      )
      .get({ invite, device: caller.kind === "pending" ? caller.device : "" });

    const expired = row === null || row.expires < now || chain.membership.invitesUsed.has(invite);
    return { status: 200, body: { state: expired ? "expired" : "pending" } };
  };
}

function pendingWire(row: PendingRow) {
  return {
    request: {
      invite: row.invite,
      device: row.device,
      signing: toBase64(row.signing),
      wrapping: toBase64(row.wrapping),
      nonce: row.nonce,
    },
    mac: toBase64(row.mac),
    signature: toBase64(row.signature),
    expires: row.expires,
  };
}

async function listPending(context: Context): Promise<Effect> {
  const { chain } = context;
  const used = chain.kind === "founded" ? chain.membership.invitesUsed : new Set<Id>();
  const now = context.hub.now();

  return (tx) => {
    purgeExpired(tx, now);

    const rows = tx
      .query<PendingRow, { now: number }>(
        "SELECT * FROM pending WHERE expires >= $now ORDER BY expires, device",
      )
      .all({ now })
      .filter((row) => !used.has(row.invite as Id));

    return { status: 200, body: { requests: rows.map(pendingWire) } };
  };
}

export const pairingRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: "/v1/pair",
    access: { kind: "unsigned" },
    limit: 4 * KIB,
    prepare: postPair,
  },
  {
    method: "GET",
    pattern: "/v1/pair/:invite",
    access: { kind: "signed", callers: ["pending", "member"] },
    limit: 0,
    prepare: pairState,
  },
  {
    method: "GET",
    pattern: "/v1/pending",
    access: MEMBER,
    limit: 0,
    prepare: listPending,
  },
];
