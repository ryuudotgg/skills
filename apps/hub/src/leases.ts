import { randomId, type Id } from "skills-core";
import { Refusal, refusalJson } from "./refusal.ts";
import { member, type Context, type Effect, type Route } from "./route.ts";
import type { Tx } from "./store.ts";
import { count, flag, idOf, malformed, parseBody, type Json } from "./wire.ts";

const DAY = 24 * 60 * 60 * 1000;

const TTL_MAX = 30 * DAY;

const TTL_MIN = 1000;

type LeaseRow = {
  key: string;
  holder: string;
  token: string;
  acquired: number;
  expires: number;
  pinned: number;
};

type Outcome = { readonly status: number; readonly body: unknown };

type Change =
  | {
      readonly kind: "put";
      readonly token: Id | null;
      readonly ttl: number;
      readonly pinned: boolean;
    }
  | { readonly kind: "release" | "break"; readonly token: Id };

function keyOf(value: string | undefined): string {
  if (value === undefined || !/^[0-9a-f]{64}$/.test(value)) return malformed("key");
  return value;
}

function leaseWire(row: LeaseRow) {
  return {
    key: row.key,
    holder: row.holder,
    token: row.token,
    acquired: row.acquired,
    expires: row.expires,
    pinned: row.pinned === 1,
  };
}

function refused(refusal: Refusal): Outcome {
  return { status: refusal.status, body: refusalJson(refusal) };
}

function liveLease(tx: Tx, key: string, now: number): LeaseRow | undefined {
  tx.query<never, { key: string; now: number }>(
    "DELETE FROM leases WHERE key = $key AND expires <= $now",
  ).run({ key, now });

  return (
    tx.query<LeaseRow, { key: string }>("SELECT * FROM leases WHERE key = $key").get({ key }) ??
    undefined
  );
}

function put(
  tx: Tx,
  key: string,
  caller: Id,
  change: Change & { kind: "put" },
  now: number,
): Outcome {
  const lease = liveLease(tx, key, now);
  const pinned = change.pinned ? 1 : 0;
  if (lease === undefined) {
    if (change.token !== null) return refused(new Refusal("lease-token"));

    const row: LeaseRow = {
      key,
      holder: caller,
      token: randomId(),
      acquired: now,
      expires: now + change.ttl,
      pinned,
    };

    tx.query<never, LeaseRow>(
      "INSERT INTO leases (key, holder, token, acquired, expires, pinned) VALUES ($key, $holder, $token, $acquired, $expires, $pinned)",
    ).run(row);

    return { status: 200, body: leaseWire(row) };
  }

  if (lease.holder !== caller)
    return refused(
      new Refusal("lease-held", {
        holder: lease.holder,
        acquired: lease.acquired,
        expires: lease.expires,
      }),
    );

  if (change.token !== lease.token) return refused(new Refusal("lease-token"));

  const expires = Math.max(lease.expires, now + change.ttl);

  tx.query<never, { key: string; expires: number; pinned: number }>(
    "UPDATE leases SET expires = $expires, pinned = $pinned WHERE key = $key",
  ).run({ key, expires, pinned });

  return { status: 200, body: leaseWire({ ...lease, expires, pinned }) };
}

function remove(
  tx: Tx,
  key: string,
  caller: Id,
  change: Change & { kind: "release" | "break" },
  now: number,
): Outcome {
  const lease = liveLease(tx, key, now);
  if (lease === undefined || lease.token !== change.token)
    return refused(new Refusal("lease-token"));

  if (change.kind === "release" && lease.holder !== caller)
    return refused(new Refusal("lease-holder", { holder: lease.holder }));

  tx.query<never, { key: string }>("DELETE FROM leases WHERE key = $key").run({ key });

  return { status: 200, body: { released: leaseWire(lease), mode: change.kind } };
}

function operate(context: Context, change: Change, operation: Id): Effect {
  const caller = member(context.caller);
  const key = keyOf(context.params.key);
  const now = context.hub.now();
  const intent = new Bun.CryptoHasher("sha256").update(JSON.stringify([key, change])).digest("hex");

  return (tx) => {
    tx.query<never, { cutoff: number }>("DELETE FROM operations WHERE time < $cutoff").run({
      cutoff: now - TTL_MAX,
    });

    const recorded = tx
      .query<{ intent: string; status: number; body: string }, { device: string; id: string }>(
        "SELECT intent, status, body FROM operations WHERE device = $device AND id = $id",
      )
      .get({ device: caller, id: operation });

    if (recorded !== null)
      return recorded.intent === intent
        ? { status: recorded.status, body: JSON.parse(recorded.body) as unknown }
        : new Refusal("operation-reused", { operation });

    const outcome =
      change.kind === "put"
        ? put(tx, key, caller, change, now)
        : remove(tx, key, caller, change, now);

    tx.query<
      never,
      { device: string; id: string; intent: string; status: number; body: string; time: number }
    >(
      "INSERT INTO operations (device, id, intent, status, body, time) VALUES ($device, $id, $intent, $status, $body, $time)",
    ).run({
      device: caller,
      id: operation,
      intent,
      status: outcome.status,
      body: JSON.stringify(outcome.body),
      time: now,
    });

    return outcome;
  };
}

function tokenOf(body: Json): Id | null {
  return body.token === null ? null : idOf(body.token, "token");
}

async function putLease(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["operation", "token", "ttl", "pinned"]);
  const ttl = count(body.ttl, "ttl");
  if (ttl < TTL_MIN || ttl > TTL_MAX) throw new Refusal("lease-duration");

  const change: Change = { kind: "put", token: tokenOf(body), ttl, pinned: flag(body, "pinned") };
  return operate(context, change, idOf(body.operation, "operation"));
}

async function deleteLease(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["operation", "token", "mode"]);
  const mode = body.mode;
  if (mode !== "release" && mode !== "break") return malformed("mode");

  const change: Change = { kind: mode, token: idOf(body.token, "token") };
  return operate(context, change, idOf(body.operation, "operation"));
}

async function listLeases(context: Context): Promise<Effect> {
  const now = context.hub.now();

  return (tx) => {
    const rows = tx
      .query<LeaseRow, { now: number }>("SELECT * FROM leases WHERE expires > $now ORDER BY key")
      .all({ now });

    return { status: 200, body: { leases: rows.map(leaseWire) } };
  };
}

const MEMBER = { kind: "signed", callers: ["member"] } as const;

export const leaseRoutes: readonly Route[] = [
  { method: "GET", pattern: "/v1/leases", access: MEMBER, limit: 0, prepare: listLeases },
  { method: "PUT", pattern: "/v1/leases/:key", access: MEMBER, limit: 4096, prepare: putLease },
  {
    method: "DELETE",
    pattern: "/v1/leases/:key",
    access: MEMBER,
    limit: 4096,
    prepare: deleteLease,
  },
];
