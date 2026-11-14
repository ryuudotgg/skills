import {
  envelopeEpoch,
  verifyEvent,
  type AuthoredEvent,
  type AuthorTail,
  type Id,
} from "skills-core";
import { asRefusal, Refusal } from "./refusal.ts";
import { KIB, MEMBER, MIB, member, type Context, type Effect, type Route } from "./route.ts";
import type { Tx } from "./store.ts";
import { eventOf, eventWire, list, malformed, parseBody, queryCount, same } from "./wire.ts";

const EVENT_ENVELOPE_MAX = 64 * KIB;

const BATCH_MAX = 500;

const PAGE_MAX = 1000;

const PAGE_BYTES = 8 * MIB;

export type EventRow = {
  hub_seq: number;
  author: string;
  sequence: number;
  previous: Uint8Array;
  id: string;
  epoch: number;
  envelope: Uint8Array;
  signature: Uint8Array;
};

export function eventOfRow(row: EventRow): AuthoredEvent {
  return {
    id: row.id,
    author: row.author as Id,
    sequence: row.sequence,
    previous: new Uint8Array(row.previous),
    envelope: new Uint8Array(row.envelope),
    signature: new Uint8Array(row.signature),
  };
}

export function eventById(tx: Tx, id: string): EventRow | undefined {
  return (
    tx.query<EventRow, { id: string }>("SELECT * FROM events WHERE id = $id").get({ id }) ??
    undefined
  );
}

function selfTail(event: AuthoredEvent): AuthorTail | undefined {
  return event.sequence === 1 ? undefined : { sequence: event.sequence - 1, hash: event.previous };
}

function sameAuthored(row: EventRow, event: AuthoredEvent): boolean {
  return (
    row.author === event.author &&
    row.sequence === event.sequence &&
    same(row.previous, event.previous) &&
    same(row.envelope, event.envelope) &&
    same(row.signature, event.signature)
  );
}

function storeEvent(tx: Tx, event: AuthoredEvent, floor: number): number {
  const existing = eventById(tx, event.id);
  if (existing !== undefined) {
    if (sameAuthored(existing, event)) return existing.hub_seq;
    throw new Refusal("event-conflict", { event: event.id });
  }

  if (envelopeEpoch(event.envelope) < floor)
    throw new Refusal("epoch-below-current", { event: event.id, epoch: floor });

  const taken = tx
    .query<{ id: string }, { author: string; sequence: number }>(
      "SELECT id FROM events WHERE author = $author AND sequence = $sequence",
    )
    .get({ author: event.author, sequence: event.sequence });

  if (taken !== null) throw new Refusal("sequence-taken", { event: event.id, existing: taken.id });

  const inserted = tx
    .query<{ hub_seq: number }, Omit<EventRow, "hub_seq">>(
      "INSERT INTO events (author, sequence, previous, id, epoch, envelope, signature) VALUES ($author, $sequence, $previous, $id, $epoch, $envelope, $signature) RETURNING hub_seq",
    )
    .get({ ...event, epoch: envelopeEpoch(event.envelope) });

  if (inserted === null) throw new TypeError("an event insert returned no hub_seq");
  return inserted.hub_seq;
}

function authorHeads(tx: Tx): Record<string, number> {
  const rows = tx
    .query<{ author: string; sequence: number }, []>(
      "SELECT author, min(sequence) AS sequence FROM events AS e WHERE EXISTS (SELECT 1 FROM events WHERE author = e.author AND sequence = 1) AND NOT EXISTS (SELECT 1 FROM events WHERE author = e.author AND sequence = e.sequence + 1) GROUP BY author ORDER BY author",
    )
    .all();

  return Object.fromEntries(rows.map((row) => [row.author, row.sequence]));
}

async function pushEvents(context: Context): Promise<Effect> {
  const caller = member(context.caller);
  const flag = context.query.get("history");
  if (flag !== null && flag !== "1") malformed("history");

  const history = flag === "1";
  const body = parseBody(context.body, ["events"]);
  const batch = list(body, "events", BATCH_MAX).map((value) => eventOf(value, EVENT_ENVELOPE_MAX));

  const { chain } = context;
  if (chain.kind === "empty") throw new Refusal("no-vault");

  for (const event of batch) {
    const detail = { event: event.id };
    if (!history && event.author !== caller) throw new Refusal("event-not-own", detail);

    try {
      await verifyEvent(chain.membership, event, selfTail(event));
    } catch (error) {
      throw asRefusal(error, detail) ?? error;
    }
  }

  const floor = history ? 0 : chain.membership.checkpoint.epoch;

  return (tx) => {
    const accepted = batch.map((event) => ({
      id: event.id,
      hub_seq: storeEvent(tx, event, floor),
    }));

    const heads = history && batch.length === 0;
    return { status: 200, body: heads ? { accepted, authors: authorHeads(tx) } : { accepted } };
  };
}

function fitted(rows: Iterable<EventRow>): EventRow[] {
  const page: EventRow[] = [];

  let size = 0;
  for (const row of rows) {
    size += row.envelope.byteLength;
    if (page.length > 0 && size > PAGE_BYTES) break;
    page.push(row);
  }

  return page;
}

async function pageEvents(context: Context): Promise<Effect> {
  const after = queryCount(context.query.get("after"), 0, "after");
  const limit = Math.min(
    Math.max(queryCount(context.query.get("limit"), 500, "limit"), 1),
    PAGE_MAX,
  );

  const { incarnations } = context.hub;

  return (tx) => {
    const rows = tx
      .query<EventRow, { after: number; limit: number }>(
        "SELECT * FROM events WHERE hub_seq > $after ORDER BY hub_seq LIMIT $limit",
      )
      .iterate({ after, limit });

    const page = fitted(rows);
    const head = tx
      .query<{ head: number | null }, []>("SELECT max(hub_seq) AS head FROM events")
      .get();

    return {
      status: 200,
      body: {
        events: page.map((row) => ({ hub_seq: row.hub_seq, ...eventWire(eventOfRow(row)) })),
        head: head?.head ?? 0,
        incarnation: incarnations.current,
      },
    };
  };
}

export const eventRoutes: readonly Route[] = [
  {
    method: "POST",
    pattern: "/v1/events",
    access: MEMBER,
    limit: 48 * MIB,
    prepare: pushEvents,
  },
  {
    method: "GET",
    pattern: "/v1/events",
    access: MEMBER,
    limit: 0,
    prepare: pageEvents,
  },
];
