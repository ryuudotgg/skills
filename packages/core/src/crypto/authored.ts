import { concat, equal, hex, own, parseId, sha256, utf8, type Bytes, type Id } from "./bytes.ts";
import { envelopeEpoch } from "./envelope.ts";
import { signAs, verifies, type SigningKeys } from "./keys.ts";
import type { Member, Membership } from "./membership.ts";
import { LAYOUT, refuse } from "./protocol.ts";

export type AuthorTail = { readonly sequence: number; readonly hash: Bytes };

export type AuthoredEvent = {
  readonly id: string;
  readonly author: Id;
  readonly sequence: number;
  readonly previous: Bytes;
  readonly envelope: Bytes;
  readonly signature: Bytes;
};

export type EventVerdict =
  | { readonly state: "fold"; readonly tail: AuthorTail }
  | { readonly state: "held" };

export const NO_HASH: Bytes = new Uint8Array(LAYOUT.hash);

function eventBody(event: Omit<AuthoredEvent, "signature">): Bytes {
  if (!/^[\x21-\x7e]{1,255}$/.test(event.id) || event.previous.length !== LAYOUT.hash)
    refuse("malformed");

  const fields = [event.id, parseId(event.author), String(event.sequence), hex(event.previous)];
  return concat(utf8(fields.map((field) => `${field}\n`).join("")), event.envelope);
}

export function eventHash(event: AuthoredEvent): Promise<Bytes> {
  return sha256(eventBody(event));
}

export async function signEvent(
  author: { readonly id: Id; readonly keys: SigningKeys },
  id: string,
  envelope: Uint8Array,
  tail: AuthorTail | undefined,
): Promise<{ event: AuthoredEvent; tail: AuthorTail }> {
  const sequence = (tail?.sequence ?? 0) + 1;
  const unsigned = {
    id,
    author: author.id,
    sequence,
    previous: own(tail?.hash ?? NO_HASH),
    envelope: own(envelope),
  };

  const body = eventBody(unsigned);
  const signature = await signAs("event", author.keys, body);
  return { event: { ...unsigned, signature }, tail: { sequence, hash: await sha256(body) } };
}

async function signedBy(
  membership: Membership,
  event: AuthoredEvent,
): Promise<{ member: Member; hash: Bytes }> {
  const member = membership.devices.get(event.author);
  if (member === undefined) return refuse("event-author");

  const epoch = envelopeEpoch(event.envelope);
  const revoked = member.revoked;
  if (epoch < member.joined.epoch || epoch > membership.checkpoint.epoch) refuse("event-epoch");
  if (revoked !== undefined && epoch >= revoked.epoch) refuse("event-epoch");

  const body = eventBody(event);
  if (!(await verifies("event", member.signing, body, event.signature))) refuse("event-signature");

  return { member, hash: await sha256(body) };
}

export async function verifyEvent(
  membership: Membership,
  event: AuthoredEvent,
  tail: AuthorTail | undefined,
): Promise<EventVerdict> {
  const { member, hash } = await signedBy(membership, event);
  if (member.revoked === undefined) {
    if (
      event.sequence !== (tail?.sequence ?? 0) + 1 ||
      !equal(event.previous, tail?.hash ?? NO_HASH)
    )
      refuse("event-chain");

    return { state: "fold", tail: { sequence: event.sequence, hash } };
  }

  const { cutoff } = member.revoked;
  if (event.sequence > cutoff.sequence) refuse("event-cutoff");
  if (event.sequence === cutoff.sequence && !equal(hash, cutoff.hash)) refuse("event-cutoff");

  return { state: "held" };
}

async function hashOrSkip(event: AuthoredEvent): Promise<string | undefined> {
  try {
    return hex(await eventHash(event));
  } catch {
    return undefined;
  }
}

async function signedOrSkip(membership: Membership, event: AuthoredEvent): Promise<boolean> {
  try {
    await signedBy(membership, event);
    return true;
  } catch {
    return false;
  }
}

export async function committedRun(
  membership: Membership,
  author: Id,
  events: readonly AuthoredEvent[],
): Promise<AuthoredEvent[]> {
  const revoked = membership.devices.get(author)?.revoked;
  if (revoked === undefined) throw new TypeError("a committed run belongs to a revoked author");

  const byHash = new Map<string, AuthoredEvent>();
  for (const event of events) {
    const hash = event.author === author ? await hashOrSkip(event) : undefined;
    if (hash !== undefined) byHash.set(hash, event);
  }

  const run: AuthoredEvent[] = [];

  let hash = revoked.cutoff.hash;
  for (let sequence = revoked.cutoff.sequence; sequence > 0; sequence -= 1) {
    const event = byHash.get(hex(hash));
    if (event === undefined || event.sequence !== sequence) break;
    if (!(await signedOrSkip(membership, event))) break;

    run.unshift(event);
    hash = event.previous;
  }

  return run;
}
