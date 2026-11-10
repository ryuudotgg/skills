import { cpSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  POLICY_EVENT,
  SESSION_EVENT,
  type SessionPolicy,
  type TranscriptRecord,
} from "skills-core";
import { importStore } from "../plans/import.ts";
import { appendEvent, blobBytes, openStore, write, type Store } from "../plans/store.ts";
import { scanSessions } from "../sessions/scan.ts";
import { hostDirs } from "../sessions/transcripts.ts";

const fixture = join(import.meta.dir, "../sessions/fixture");

export type SessionsMachine = {
  readonly root: string;
  readonly plans: string;
  readonly store: Store;
  readonly env: NodeJS.ProcessEnv;
  readonly claude: string;
  readonly close: () => void;
};

const AGED = new Date("2026-01-01T00:00:00Z");
export function age(path: string): void {
  utimesSync(path, AGED, AGED);
}

export function setPolicy(m: SessionsMachine, policy: SessionPolicy): void {
  write(m.store, () =>
    appendEvent(m.store, {
      kind: "stored",
      type: POLICY_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "-",
      payload: { policy },
    }),
  );
}

export async function sessionsMachine(policy?: SessionPolicy): Promise<SessionsMachine> {
  const root = mkdtempSync(join(tmpdir(), "sessions-"));
  const plans = join(root, "plans");
  cpSync(join(fixture, "home"), join(root, "home"), { recursive: true });
  cpSync(join(fixture, "plans"), plans, { recursive: true });
  await importStore({ PLANS_DIR: plans });

  const store = openStore(join(plans, "plans.db"));
  write(store, () =>
    appendEvent(store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "001",
      payload: {
        host: "claude",
        session: "claude-fixture",
        branch: "feat/one",
        plans: ["001"],
        source: "startup",
        started: "2026-11-07T10:00:00Z",
      },
    }),
  );

  const env = {
    HOME: join(root, "home"),
    CLAUDE_CONFIG_DIR: join(root, "home/.claude"),
    CODEX_HOME: join(root, "home/.codex"),
    PATH: process.env.PATH,
  };

  const claude = join(
    root,
    "home/.claude/projects/-tmp-sessions-fixture-checkout-Alpha/claude-fixture.jsonl",
  );

  const close = () => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  };

  const m = { root, plans, store, env, claude, close };
  if (policy !== undefined) setPolicy(m, policy);

  age(claude);
  await scanSessions(plans, hostDirs(env));
  return m;
}

export function transcripts(store: Store): TranscriptRecord[] {
  const rows = store.db
    .query("SELECT payload FROM events WHERE type = 'transcript' ORDER BY seq")
    .all() as { payload: string }[];

  return rows.map((row) => JSON.parse(row.payload) as TranscriptRecord);
}

export function blobText(store: Store, sha256: string): string {
  return new TextDecoder().decode(blobBytes(store.db, sha256));
}
