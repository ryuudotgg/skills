import { CryptoRefusal, PROTOCOL, type RefusalReason } from "skills-core";

const HUB_REASONS = {
  malformed: [400, "the request does not parse"],
  "lease-duration": [400, "a lease lasts from one second to 30 days"],
  unsigned: [401, "the request carries no signature"],
  clock: [401, "the request time is more than five minutes from the hub's"],
  incarnation: [401, "the request is bound to the hub's previous incarnation"],
  "device-unknown": [401, "the hub knows no device by that id"],
  signature: [401, "the signature does not verify"],
  "join-signature": [401, "the join request's own signature does not verify"],
  replayed: [401, "the hub has already seen this signature"],
  "device-revoked": [403, "the device is revoked"],
  "device-pending": [403, "a pending device may only read its own invite"],
  "recovery-route": [403, "the recovery identity may only use the recover routes"],
  "recovery-revoked": [403, "the recovery identity is revoked"],
  "member-route": [403, "this route is not for a member device"],
  "init-code": [403, "the init code does not match"],
  route: [404, "no such route"],
  "blob-missing": [404, "the hub holds no blob by that id"],
  method: [405, "the route does not take that method"],
  "no-vault": [409, "the hub holds no vault yet"],
  "vault-exists": [409, "the hub already holds a vault"],
  "chain-moved": [409, "the membership chain moved since the request was checked"],
  "label-not-sealed": [409, "a device label is not an envelope"],
  "invite-consumed": [409, "the invite has already been used"],
  "invite-expired": [409, "the invite has expired"],
  "device-taken": [409, "another join request or member holds that device id"],
  "event-not-own": [409, "a normal push carries only the signing device's events"],
  "epoch-below-current": [409, "the envelope is sealed under an epoch below the current one"],
  "event-conflict": [409, "the hub holds other bytes under that event id"],
  "sequence-taken": [409, "the author already used that sequence for another event"],
  "epoch-ahead": [409, "the envelope is sealed under an epoch the chain has not started"],
  "blob-conflict": [409, "the hub holds other bytes under that blob id"],
  "tombstone-event": [409, "the hub holds no event by that id"],
  "lease-held": [409, "another device holds the lease"],
  "lease-token": [409, "the token is not the lease's current token"],
  "lease-holder": [409, "only the holder releases a lease without breaking it"],
  "operation-reused": [409, "the operation id was used for another request"],
  "blob-deleted": [410, "the blob was deleted"],
  "too-large": [413, "the body is larger than the route takes"],
  protocol: [426, "the protocol version is outside the hub's range"],
  internal: [500, "the hub failed while handling the request"],
  "pending-full": [503, "the hub holds as many join requests as it keeps"],
  "invite-full": [409, "the invite already has as many join requests as the hub keeps"],
} as const satisfies Record<string, readonly [number, string]>;

type HubReason = keyof typeof HUB_REASONS;

export type Reason =
  | HubReason
  | Exclude<RefusalReason, "malformed" | "signature" | "invite-expired">;

export type Detail = Readonly<Record<string, unknown>>;

const CORE_STATUS: Partial<Record<RefusalReason, number>> = {
  "envelope-truncated": 400,
  "envelope-version": 400,
  "epoch-range": 400,
  "epoch-mismatch": 400,
  checksum: 400,
  "invite-mismatch": 400,
  "join-mac": 400,
  "bundle-malformed": 400,
};

function isHubReason(reason: string): reason is HubReason {
  return reason in HUB_REASONS;
}

export class Refusal extends Error {
  readonly reason: Reason;
  readonly status: number;
  readonly detail: Detail;

  constructor(reason: Reason, detail: Detail = {}, message?: string) {
    const [status, text] = isHubReason(reason)
      ? HUB_REASONS[reason]
      : [CORE_STATUS[reason] ?? 409, message ?? new CryptoRefusal(reason).message];

    super(message ?? text);
    this.name = "Refusal";
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

function fromCrypto(error: CryptoRefusal, detail: Detail = {}): Refusal {
  const entry = error.entry === undefined ? {} : { entry: error.entry };
  if (error.reason === "malformed") return new Refusal("malformed", { ...detail, ...entry });
  if (error.reason === "signature") return new Refusal("signature", detail);
  if (error.reason === "invite-expired") return new Refusal("invite-expired", detail);

  return new Refusal(error.reason, { ...detail, ...entry }, error.message);
}

export function asRefusal(error: unknown, detail: Detail = {}): Refusal | undefined {
  if (error instanceof Refusal) return error;
  if (error instanceof CryptoRefusal) return fromCrypto(error, detail);
  return undefined;
}

export function protocolSentence(spoken: string): string {
  return `hub speaks ${PROTOCOL}..${PROTOCOL}, this release speaks ${spoken}`;
}

export function refusalJson(refusal: Refusal): Readonly<Record<string, unknown>> {
  return { reason: refusal.reason, message: refusal.message, ...refusal.detail };
}
