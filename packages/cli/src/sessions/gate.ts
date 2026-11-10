import {
  mergedEffort,
  policyAllows,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  TRANSCRIPT_EVENT,
  type Host,
  type SessionPolicy,
  type SessionRecord,
  type SessionStats,
  type TranscriptRecord,
  type Usage,
} from "skills-core";
import { queueDeletion } from "../plans/outbox.ts";
import { appendEvent, write, type Store } from "../plans/store.ts";
import type { RemoteRecord } from "../plans/sync.ts";
import { localLinks, sessionKey, sessionPolicies } from "./policy.ts";
import { mainFiles, originOf } from "./chunks.ts";
import { envSecrets, redact } from "./redact.ts";

type Secrets = readonly string[];

type Gated = {
  needs(payload: never): SessionPolicy;
  scrub(payload: never, secrets: Secrets): unknown;
};

function mergedUsage(left: Usage, right: Usage): Usage {
  const merged: Record<string, string | number> = {
    ...left,
    effort: mergedEffort(left.effort, right.effort),
  };

  for (const [field, count] of Object.entries(right))
    if (typeof count === "number") merged[field] = Number(merged[field] ?? 0) + count;

  return merged as Usage;
}

function scrubbedUsage(models: Record<string, Usage>, secrets: Secrets): Record<string, Usage> {
  const efforts = Object.entries(models).map(([model, usage]) => [
    model,
    { ...usage, effort: redact(usage.effort, secrets) },
  ]);

  return renamed(Object.fromEntries(efforts) as Record<string, Usage>, secrets, mergedUsage);
}

function renamed<T>(
  record: Record<string, T>,
  secrets: Secrets,
  merge: (left: T, right: T) => T,
): Record<string, T> {
  const out = Object.create(null) as Record<string, T>;
  for (const [key, value] of Object.entries(record)) {
    const name = redact(key, secrets);
    out[name] = Object.hasOwn(out, name) ? merge(out[name] as T, value) : value;
  }

  return out;
}

const GATED: Record<string, Gated> = {
  [SESSION_EVENT]: {
    needs: () => "stats",
    scrub: (payload: SessionRecord, secrets) => ({
      ...payload,
      branch: redact(payload.branch, secrets),
      source: redact(payload.source, secrets),
    }),
  },
  [SESSION_STATS_EVENT]: {
    needs: () => "stats",
    scrub: (payload: SessionStats, secrets) => ({
      ...payload,
      tools: renamed(payload.tools, secrets, (left, right) => left + right),
      models: scrubbedUsage(payload.models, secrets),
    }),
  },
  [TRANSCRIPT_EVENT]: {
    needs: (payload: TranscriptRecord) => payload.policy,
    scrub: (payload: TranscriptRecord, secrets) =>
      payload.cwd === undefined
        ? payload
        : {
            ...payload,
            cwd: redact(payload.cwd, secrets),
            root: redact(payload.root ?? payload.cwd, secrets),
            home: redact(payload.home ?? "", secrets),
          },
  },
};

type Typed = Pick<RemoteRecord, "type" | "payload">;

export type Gate = {
  passes(record: Typed): boolean;
  outgoing(record: RemoteRecord): RemoteRecord;
};

function keyOf(payload: unknown): string {
  const { host, session } = payload as { host: Host; session: string };
  return sessionKey(host, session);
}

function secretsOf(root: string): (key: string) => Secrets {
  const files = mainFiles(root);
  const known = new Map<string, Secrets>();
  return (key) => {
    const found = known.get(key);
    if (found !== undefined) return found;

    const origin = originOf(files.get(key)?.cwd ?? null, process.env);
    const secrets = origin === undefined ? [] : envSecrets([origin.cwd, origin.root]);
    known.set(key, secrets);
    return secrets;
  };
}

export function pushGate(store: Store, root: string): Gate {
  const policies = sessionPolicies(store, localLinks(root));
  const secrets = secretsOf(root);
  return {
    passes(record) {
      const gated = GATED[record.type];
      if (gated === undefined) return true;

      const policy = policies.get(keyOf(record.payload)) ?? "off";
      return policyAllows(policy, gated.needs(record.payload as never));
    },
    outgoing(record) {
      const gated = GATED[record.type];
      return gated === undefined
        ? record
        : {
            ...record,
            payload: gated.scrub(record.payload as never, secrets(keyOf(record.payload))),
          };
    },
  };
}

export const GATED_TYPES: readonly string[] = Object.keys(GATED);

export type Sent = { project: string; payload: string };

type Blob = { locator: string; sha256: string; needs: SessionPolicy };

function blobsOf(payload: TranscriptRecord): Blob[] {
  return [
    { locator: payload.blob, sha256: payload.sha256, needs: payload.policy },
    { locator: payload.digestBlob, sha256: payload.digest, needs: "redacted" },
  ];
}

export function authorDeletions(store: Store, root: string, retired: readonly Sent[] = []): number {
  const policies = sessionPolicies(store, localLinks(root));

  const recorded = store.db
    .query(
      `SELECT project, payload, author IS NOT NULL AS sent FROM events
       WHERE type = ? AND quarantined IS NULL AND withheld IS NULL`,
    )
    .all(TRANSCRIPT_EVENT) as (Sent & { sent: number })[];

  const live = new Set<string>();
  const dead = new Map<string, Sent & { sha256: string }>();
  const consider = (row: Sent, forced: boolean, pending: boolean) => {
    const payload = JSON.parse(row.payload) as TranscriptRecord;
    const policy = policies.get(keyOf(payload)) ?? "off";
    if (pending && !policyAllows(policy, payload.policy)) return;

    for (const blob of blobsOf(payload))
      if (!forced && policyAllows(policy, blob.needs)) live.add(blob.locator);
      else if (!pending) dead.set(blob.locator, { ...row, sha256: blob.sha256 });
  };

  for (const row of recorded) consider(row, false, row.sent === 0);
  for (const row of retired) consider(row, true, false);

  return write(store, () => {
    const kept = new Set(
      (
        store.db
          .query(
            `SELECT json_extract(payload, '$.blob') AS locator FROM events
             WHERE type = 'blob-deleted' AND quarantined IS NULL
             UNION SELECT locator FROM revisions UNION SELECT locator FROM file_chunks`,
          )
          .all() as { locator: string }[]
      ).map((row) => row.locator),
    );

    let authored = 0;
    for (const [locator, { project, sha256 }] of dead) {
      if (live.has(locator) || kept.has(locator)) continue;

      const event = appendEvent(store, {
        kind: "stored",
        type: "blob-deleted",
        at: Date.now(),
        project,
        plan: "-",
        payload: { blob: locator },
      });

      queueDeletion(store, { locator, event });
      store.db.run("DELETE FROM blob_uploads WHERE sha256 = ?", [sha256]);
      authored++;
    }

    return authored;
  });
}
