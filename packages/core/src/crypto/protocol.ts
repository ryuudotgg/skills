export const PROTOCOL = 1;

export const MAX_EPOCH = 65535;

const HEADER = 3;
const NONCE = 12;
const TAG = 16;

export const ENVELOPE = {
  version: 0x01,
  header: HEADER,
  nonce: NONCE,
  tag: TAG,
  overhead: HEADER + NONCE + TAG,
} as const;

export const INVITE = { version: 0x01, maxLabel: 64, checksum: 2 } as const;

export const RECOVERY = { groups: 20, group: 4, separator: "-", checksum: 2 } as const;

export const LAYOUT = {
  version: 0x01,
  id: 16,
  hash: 32,
  key: 32,
  signature: 64,
  fingerprint: 16,
} as const;

export const LABELS = {
  events: "skills-hub/events/v1",
  blobs: "skills-hub/blobs/v1",
  labels: "skills-hub/labels/v1",
  leases: "skills-hub/leases/v1",
  wrap: "skills-hub/wrap/v1",
  recoverSign: "skills-hub/recover/sign/v1",
  recoverWrap: "skills-hub/recover/wrap/v1",
} as const;

export const DOMAINS = {
  request: "skills-hub/request/v1",
  join: "skills-hub/join/v1",
  event: "skills-hub/event/v1",
  entry: "skills-hub/entry/v1",
} as const;

export const ENTRY_KINDS = ["founding", "device", "revocation", "epoch", "recovery"] as const;

export const SIGNERS = ["device", "recovery"] as const;

export const REFUSALS = [
  "malformed",
  "envelope-truncated",
  "envelope-version",
  "envelope-unauthentic",
  "epoch-range",
  "epoch-mismatch",
  "checksum",
  "invite-mismatch",
  "invite-expired",
  "join-mac",
  "signature",
  "bundle-malformed",
  "event-author",
  "event-epoch",
  "event-signature",
  "event-chain",
  "event-cutoff",
  "chain-root",
  "chain-fork",
  "chain-link",
  "entry-signer",
  "entry-signature",
  "entry-rule",
] as const;

export type RefusalReason = (typeof REFUSALS)[number];

const MESSAGES: Record<RefusalReason, string> = {
  malformed: "the bytes or text do not parse",
  "envelope-truncated": "the envelope is shorter than its header and tag",
  "envelope-version": "the envelope names an unknown version",
  "envelope-unauthentic": "the envelope does not authenticate under this key and associated data",
  "epoch-range": "the epoch is outside 1 to 65535",
  "epoch-mismatch": "the envelope names another epoch than its key",
  checksum: "the code does not match its checksum",
  "invite-mismatch": "the join request names another invite",
  "invite-expired": "the invite has expired",
  "join-mac": "the join request does not match its MAC",
  signature: "the signature does not verify",
  "bundle-malformed": "the wrapped bundle holds no valid epoch keys",
  "event-author": "the event author is not a member",
  "event-epoch": "the event epoch is outside its author's membership",
  "event-signature": "the event signature does not verify",
  "event-chain": "the event does not extend its author's chain",
  "event-cutoff": "the event is past its revoked author's committed cutoff",
  "chain-root": "the founding entry does not match the vault fingerprint",
  "chain-fork": "the chain does not extend the checkpoint head",
  "chain-link": "an entry does not link to the entry before it",
  "entry-signer": "an entry is signed by a non member",
  "entry-signature": "an entry signature does not verify",
  "entry-rule": "an entry breaks a membership rule",
};

export class CryptoRefusal extends Error {
  readonly reason: RefusalReason;
  readonly entry: number | undefined;

  constructor(reason: RefusalReason, entry?: number) {
    super(entry === undefined ? MESSAGES[reason] : `entry ${entry}: ${MESSAGES[reason]}`);
    this.name = "CryptoRefusal";
    this.reason = reason;
    this.entry = entry;
  }
}

export function refuse(reason: RefusalReason, entry?: number): never {
  throw new CryptoRefusal(reason, entry);
}

export function checkEpoch(epoch: number): number {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > MAX_EPOCH) refuse("epoch-range");
  return epoch;
}
