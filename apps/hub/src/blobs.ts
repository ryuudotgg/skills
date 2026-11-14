import { BLOB_MAX, ENVELOPE, envelopeEpoch, type Id } from "skills-core";
import { eventById, eventOfRow } from "./events.ts";
import { Refusal } from "./refusal.ts";
import { member, type Context, type Effect, type Route } from "./route.ts";
import type { Tx } from "./store.ts";
import { envelopeOf, eventIdOf, eventWire, idOf, list, parseBody, same, toBase64 } from "./wire.ts";

const BLOB_ENVELOPE_MAX = BLOB_MAX + ENVELOPE.overhead;

const PUT_BODY_MAX = Math.ceil(BLOB_ENVELOPE_MAX / 3) * 4 + 1024;

const HAVE_MAX = 1000;

function tombstoneOf(tx: Tx, blob: Id): Refusal | undefined {
  const row = tx
    .query<{ event: string }, { blob: string }>("SELECT event FROM tombstones WHERE blob = $blob")
    .get({ blob });

  if (row === null) return undefined;

  const event = eventById(tx, row.event);
  if (event === undefined) throw new TypeError("a tombstone names an event the hub does not hold");

  return new Refusal("blob-deleted", { event: eventWire(eventOfRow(event)) });
}

function storedBlob(tx: Tx, id: Id): { envelope: Uint8Array } | undefined {
  return (
    tx
      .query<{ envelope: Uint8Array }, { id: string }>("SELECT envelope FROM blobs WHERE id = $id")
      .get({ id }) ?? undefined
  );
}

async function putBlob(context: Context): Promise<Effect> {
  member(context.caller);
  const id = idOf(context.params.id, "id");
  const body = parseBody(context.body, ["envelope"]);
  const envelope = envelopeOf(body.envelope, "envelope", BLOB_ENVELOPE_MAX);
  const epoch = envelopeEpoch(envelope);

  const { chain } = context;
  if (chain.kind === "empty") throw new Refusal("no-vault");
  if (epoch > chain.membership.checkpoint.epoch) throw new Refusal("epoch-ahead", { epoch });

  return (tx) => {
    const tombstone = tombstoneOf(tx, id);
    if (tombstone !== undefined) return tombstone;

    const stored = storedBlob(tx, id);
    if (stored !== undefined)
      return same(stored.envelope, envelope)
        ? { status: 200, body: { id } }
        : new Refusal("blob-conflict", { id });

    tx.query<never, { id: string; epoch: number; envelope: Uint8Array }>(
      "INSERT INTO blobs (id, epoch, envelope) VALUES ($id, $epoch, $envelope)",
    ).run({ id, epoch, envelope });

    return { status: 201, body: { id } };
  };
}

async function getBlob(context: Context): Promise<Effect> {
  const id = idOf(context.params.id, "id");

  return (tx) => {
    const tombstone = tombstoneOf(tx, id);
    if (tombstone !== undefined) return tombstone;

    const stored = storedBlob(tx, id);
    if (stored === undefined) return new Refusal("blob-missing", { id });

    return { status: 200, body: { id, envelope: toBase64(stored.envelope) } };
  };
}

async function deleteBlob(context: Context): Promise<Effect> {
  member(context.caller);
  const id = idOf(context.params.id, "id");
  const body = parseBody(context.body, ["event"]);
  const eventId = eventIdOf(body.event, "event");

  return (tx) => {
    const stored = tx
      .query<{ event: string }, { blob: string }>("SELECT event FROM tombstones WHERE blob = $blob")
      .get({ blob: id });

    if (stored !== null) return { status: 200, body: { id, event: stored.event } };

    const event = eventById(tx, eventId);
    if (event === undefined) return new Refusal("tombstone-event", { event: eventId });

    tx.query<never, { blob: string; event: string }>(
      "INSERT INTO tombstones (blob, event) VALUES ($blob, $event)",
    ).run({ blob: id, event: eventId });

    tx.query<never, { id: string }>("DELETE FROM blobs WHERE id = $id").run({ id });

    return { status: 200, body: { id, event: eventId } };
  };
}

async function haveBlobs(context: Context): Promise<Effect> {
  const body = parseBody(context.body, ["ids"]);
  const ids = list(body, "ids", HAVE_MAX).map((value, index) => idOf(value, `ids.${index}`));

  return (tx) => {
    const missing: Id[] = [];
    const deleted: Id[] = [];
    for (const id of ids) {
      const tombstoned = tx
        .query<{ blob: string }, { blob: string }>("SELECT blob FROM tombstones WHERE blob = $blob")
        .get({ blob: id });

      if (tombstoned !== null) {
        deleted.push(id);
        continue;
      }

      const held = tx
        .query<{ id: string }, { id: string }>("SELECT id FROM blobs WHERE id = $id")
        .get({ id });

      if (held === null) missing.push(id);
    }

    return { status: 200, body: { missing, deleted } };
  };
}

const MEMBER = { kind: "signed", callers: ["member"] } as const;

export const blobRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: "/v1/blobs/have",
    access: MEMBER,
    limit: 64 * 1024,
    prepare: haveBlobs,
  },
  {
    method: "PUT",
    pattern: "/v1/blobs/:id",
    access: MEMBER,
    limit: PUT_BODY_MAX,
    prepare: putBlob,
  },
  { method: "GET", pattern: "/v1/blobs/:id", access: MEMBER, limit: 0, prepare: getBlob },
  { method: "DELETE", pattern: "/v1/blobs/:id", access: MEMBER, limit: 4096, prepare: deleteBlob },
];
