import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { parseId, randomId, type Id } from "skills-core";

export type Tx = Database;

export type Incarnations = { readonly current: Id; readonly previous: Id | undefined };

export const SKEW = 5 * 60 * 1000;

export const RESTORE_MARKER = ".restored";

const HEX32 = (column: string) =>
  `CHECK (length(${column}) = 32 AND ${column} NOT GLOB '*[^0-9a-f]*')`;

const BYTES = (column: string, length: number) => `CHECK (length(${column}) = ${length})`;

const ENVELOPE = `CHECK (length(envelope) >= 31 AND hex(substr(envelope, 1, 1)) = '01' AND hex(substr(envelope, 2, 2)) = printf('%04X', epoch))`;

const EPOCH = "CHECK (epoch BETWEEN 1 AND 65535)";

const EVENT_ID = `CHECK ((length(id) = 32 AND id NOT GLOB '*[^0-9a-f]*') OR (length(id) = 36 AND id GLOB '????????-????-????-????-????????????' AND replace(id, '-', '') NOT GLOB '*[^0-9a-f]*' AND length(replace(id, '-', '')) = 32))`;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY CHECK (key IN ('incarnation', 'previous')),
  value TEXT NOT NULL ${HEX32("value")}
) STRICT;

CREATE TABLE IF NOT EXISTS membership (
  position INTEGER PRIMARY KEY CHECK (position >= 0),
  hash BLOB NOT NULL UNIQUE ${BYTES("hash", 32)},
  entry BLOB NOT NULL CHECK (length(entry) > 64)
) STRICT;

CREATE TABLE IF NOT EXISTS pending (
  invite TEXT NOT NULL ${HEX32("invite")},
  device TEXT NOT NULL ${HEX32("device")},
  signing BLOB NOT NULL ${BYTES("signing", 32)},
  wrapping BLOB NOT NULL ${BYTES("wrapping", 32)},
  nonce TEXT NOT NULL ${HEX32("nonce")},
  mac BLOB NOT NULL ${BYTES("mac", 32)},
  signature BLOB NOT NULL ${BYTES("signature", 64)},
  expires INTEGER NOT NULL CHECK (expires >= 0),
  PRIMARY KEY (invite, device),
  UNIQUE (device)
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  hub_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  author TEXT NOT NULL ${HEX32("author")},
  sequence INTEGER NOT NULL CHECK (sequence > 0),
  previous BLOB NOT NULL ${BYTES("previous", 32)},
  id TEXT NOT NULL UNIQUE ${EVENT_ID},
  epoch INTEGER NOT NULL ${EPOCH},
  envelope BLOB NOT NULL ${ENVELOPE},
  signature BLOB NOT NULL ${BYTES("signature", 64)},
  UNIQUE (author, sequence)
) STRICT;

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY ${HEX32("id")},
  epoch INTEGER NOT NULL ${EPOCH},
  envelope BLOB NOT NULL ${ENVELOPE}
) STRICT;

CREATE TABLE IF NOT EXISTS tombstones (
  blob TEXT PRIMARY KEY ${HEX32("blob")},
  event TEXT NOT NULL REFERENCES events (id)
) STRICT;

CREATE TABLE IF NOT EXISTS leases (
  key TEXT PRIMARY KEY CHECK (length(key) = 64 AND key NOT GLOB '*[^0-9a-f]*'),
  holder TEXT NOT NULL ${HEX32("holder")},
  token TEXT NOT NULL UNIQUE ${HEX32("token")},
  acquired INTEGER NOT NULL CHECK (acquired >= 0),
  expires INTEGER NOT NULL CHECK (expires > acquired),
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1))
) STRICT;

CREATE TABLE IF NOT EXISTS operations (
  device TEXT NOT NULL ${HEX32("device")},
  id TEXT NOT NULL ${HEX32("id")},
  intent TEXT NOT NULL CHECK (length(intent) = 64 AND intent NOT GLOB '*[^0-9a-f]*'),
  status INTEGER NOT NULL CHECK (status BETWEEN 200 AND 599),
  body TEXT NOT NULL CHECK (json_valid(body)),
  time INTEGER NOT NULL CHECK (time >= 0),
  PRIMARY KEY (device, id)
) STRICT;

CREATE TABLE IF NOT EXISTS signatures (
  digest BLOB PRIMARY KEY ${BYTES("digest", 32)},
  time INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS signatures_time ON signatures (time);
`;

export function openStore(dir: string): { db: Database; incarnations: Incarnations } {
  mkdirSync(dir, { recursive: true });

  const db = new Database(join(dir, "hub.db"), { create: true, strict: true });
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = FULL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");

  db.exec(SCHEMA);

  const marker = join(dir, RESTORE_MARKER);
  const restored = existsSync(marker);
  const incarnations = db.transaction(() => settleIncarnation(db, restored)).immediate();

  if (restored) rmSync(marker, { force: true });

  return { db, incarnations };
}

function metaValue(db: Database, key: "incarnation" | "previous"): Id | undefined {
  const row = db
    .query<{ value: string }, { key: string }>("SELECT value FROM meta WHERE key = $key")
    .get({ key });

  return row === null ? undefined : parseId(row.value);
}

function settleIncarnation(db: Database, restored: boolean): Incarnations {
  const current = metaValue(db, "incarnation");
  if (current !== undefined && !restored) return { current, previous: metaValue(db, "previous") };

  const minted = randomId();
  const upsert = db.query<never, { key: string; value: string }>(
    "INSERT INTO meta (key, value) VALUES ($key, $value) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  );

  upsert.run({ key: "incarnation", value: minted });
  if (current !== undefined) upsert.run({ key: "previous", value: current });
  db.run("DELETE FROM signatures");

  return { current: minted, previous: current };
}

export function commit<T>(db: Database, body: (tx: Tx) => T): T {
  return db.transaction(() => body(db)).immediate();
}

export function savepoint<T>(tx: Tx, body: (tx: Tx) => T): T {
  return tx.transaction(() => body(tx))();
}

export function spend(tx: Tx, digest: Uint8Array, time: number, now: number): "spent" | "replayed" {
  tx.query<never, { cutoff: number }>("DELETE FROM signatures WHERE time < $cutoff").run({
    cutoff: now - 2 * SKEW,
  });

  const inserted = tx
    .query<never, { digest: Uint8Array; time: number }>(
      "INSERT INTO signatures (digest, time) VALUES ($digest, $time) ON CONFLICT (digest) DO NOTHING",
    )
    .run({ digest, time });

  return inserted.changes === 1 ? "spent" : "replayed";
}
