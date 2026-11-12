import { existsSync, statSync } from "node:fs";
import {
  policyAllows,
  TRANSCRIPT_EVENT,
  USAGE_FIELDS,
  type SessionStats,
  type TranscriptRecord,
} from "skills-core";
import type { Fetch } from "../plans/outbox.ts";
import { blobBytes, isDeleted, type Store } from "../plans/store.ts";
import { mainFiles, originOf } from "./chunks.ts";
import { digestText, foldDigest, freshDigest } from "./digest.ts";
import { lineText, type SessionLine } from "./ledger.ts";
import { localLinks, sessionKey, sessionPolicies } from "./policy.ts";
import { envSecrets, redact } from "./redact.ts";
import { object } from "./jsonl.ts";
import { claudeTranscripts, codexTranscripts, hostDirs, lines, parsed } from "./transcripts.ts";

export const TRANSCRIPT_MISSING = "digest: transcript missing";

export const BLOB_MISSING = "digest: blob missing";

const CWD_LINES = 50;

const SHA256 = /^[0-9a-f]{64}$/u;

const LOCATOR = /^[0-9a-f]{32}$/u;

type LocalFile = { path: string; cwd: string | null };

export type Shown =
  | { kind: "missing" }
  | { kind: "refused"; policy: string }
  | { kind: "shown"; text: string };

function sorted<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([left], [right]) => (left < right ? -1 : 1));
}

function fieldLines(
  line: SessionLine,
  stats: SessionStats | null,
  shown: (text: string) => string,
) {
  const models = sorted(stats?.models ?? {}).map(([model, usage]) =>
    [
      "model",
      shown(model),
      shown(usage.effort),
      ...USAGE_FIELDS[line.host].map((field) => `${field} ${usage[field] ?? 0}`),
    ].join(" "),
  );

  const tools = sorted(stats?.tools ?? {}).map(([name, calls]) => `tool ${shown(name)} ${calls}`);
  return [
    `host ${line.host}`,
    `project ${line.project}`,
    `plans ${line.plans.length ? line.plans.join(",") : "-"}`,
    `branch ${shown(line.branch)}`,
    `machine ${line.machine}`,
    `policy ${line.policy}`,
    `start ${line.start}`,
    `end ${line.end}`,
    ...models,
    ...tools,
  ];
}

function readDigest(line: SessionLine, path: string, secrets: readonly string[]): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  const digest = freshDigest(line.host);
  for (const [raw] of lines(path, 0, size)) {
    const record = parsed(raw);
    if (record !== null) foldDigest(digest, record, secrets);
  }

  return digestText(digest, secrets);
}

function recordedCwd(path: string): string | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }

  let read = 0;
  for (const [raw] of lines(path, 0, size)) {
    const record = parsed(raw);
    const payload = record?.type === "session_meta" ? record.payload : record;
    if (object(payload) && typeof payload.cwd === "string" && payload.cwd) return payload.cwd;
    if (++read >= CWD_LINES) break;
  }

  return null;
}

function localFile(root: string, env: NodeJS.ProcessEnv, line: SessionLine): LocalFile | undefined {
  const scanned = mainFiles(root).get(sessionKey(line.host, line.session));
  if (scanned !== undefined && existsSync(scanned.path)) return scanned;

  const dirs = hostDirs(env);
  const listed =
    line.host === "claude"
      ? claudeTranscripts(dirs.claude)
      : line.host === "codex"
        ? codexTranscripts(dirs.codex)
        : [];

  const found = listed.find((each) => !each.subagent && each.session === line.session);
  return found === undefined ? undefined : { path: found.path, cwd: recordedCwd(found.path) };
}

export function showSession(
  root: string,
  env: NodeJS.ProcessEnv,
  found: SessionLine | undefined,
  withDigest: boolean,
): Shown {
  if (found === undefined) return { kind: "missing" };
  if (!policyAllows(found.policy, "redacted")) return { kind: "refused", policy: found.policy };

  const file = localFile(root, env, found);
  const origin = originOf(file?.cwd ?? null, env);
  const secrets = origin === undefined ? [] : envSecrets([origin.cwd, origin.root]);

  const shown =
    found.policy === "full" ? (text: string) => text : (text: string) => redact(text, secrets);

  const visible: SessionLine = {
    ...found,
    project: shown(found.project),
    branch: shown(found.branch),
    machine: shown(found.machine),
    models: found.models.map(shown),
  };

  const head = [lineText(visible), ...fieldLines(visible, found.stats, shown)].join("\n");
  if (!withDigest) return { kind: "shown", text: `${head}\n` };

  const digest = file === undefined ? null : readDigest(found, file.path, secrets);
  return { kind: "shown", text: `${head}\n${digest ?? `${TRANSCRIPT_MISSING}\n`}` };
}

type Newest = { event: string; record: TranscriptRecord };

function newestTranscripts(store: Store): Map<string, Newest> {
  const rows = store.db
    .query(
      `SELECT id, payload FROM events
       WHERE type = ? AND legacy = 0 AND quarantined IS NULL
       ORDER BY wall, counter, machine, id`,
    )
    .all(TRANSCRIPT_EVENT) as { id: string; payload: string }[];

  const newest = new Map<string, Newest>();
  for (const row of rows) {
    const record = JSON.parse(row.payload) as TranscriptRecord;
    newest.set(sessionKey(record.host, record.session), { event: row.id, record });
  }

  return newest;
}

export function missingDigests(store: Store, root: string): Fetch[] {
  const policies = sessionPolicies(store, localLinks(root));
  const held = store.db.query("SELECT 1 FROM blobs WHERE sha256 = ?");
  const found = new Map<string, Fetch>();
  for (const [key, { event, record }] of newestTranscripts(store)) {
    const { digest, digestBlob } = record;
    if (!SHA256.test(String(digest)) || !LOCATOR.test(String(digestBlob))) continue;
    if (!policyAllows(policies.get(key) ?? "off", "redacted")) continue;
    if (found.has(digest) || held.get(digest) !== null || isDeleted(store.db, digestBlob)) continue;

    found.set(digest, { sha256: digest, locator: digestBlob, event });
  }

  return [...found.values()];
}

function newestDigest(store: Store, newest: Newest | undefined): string | undefined {
  if (newest === undefined) return BLOB_MISSING;

  const { digest, digestBlob } = newest.record;
  if (typeof digest !== "string" || typeof digestBlob !== "string") return BLOB_MISSING;
  if (isDeleted(store.db, digestBlob)) return undefined;

  const bytes = blobBytes(store.db, digest);
  return bytes === undefined ? BLOB_MISSING : new TextDecoder().decode(bytes);
}

export function planDigests(
  store: Store,
  sessions: readonly SessionLine[],
  project: string,
  id: string,
): string {
  const link = `${project}/${id}`;
  const newest = newestTranscripts(store);
  const blocks: string[] = [];
  for (const line of sessions) {
    if (line.silenced || !line.links.includes(link)) continue;
    if (!policyAllows(line.policy, "redacted")) continue;

    const digest = newestDigest(store, newest.get(sessionKey(line.host, line.session)));
    if (digest === undefined) continue;

    blocks.push(
      `Session ${line.host} ${line.session}\n${digest.endsWith("\n") ? digest : `${digest}\n`}`,
    );
  }

  return blocks.join("");
}
