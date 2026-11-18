import { cpSync, mkdtempSync, readdirSync, realpathSync, rmSync, utimesSync } from "node:fs";
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
import { removeTemporary, runCommand, suiteEnvironment } from "./process.ts";

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

export type LedgerMachine = {
  readonly root: string;
  readonly hooks: { readonly claude: string; readonly codex: string };
  readonly close: () => Promise<void>;
};

function hookPayload(session: string, transcript: string, cwd: string): string {
  const payload = {
    session_id: session,
    transcript_path: transcript,
    cwd,
    hook_event_name: "SessionStart",
    source: "startup",
  };

  return `${JSON.stringify(payload)}\n`;
}

export async function ledgerMachine(): Promise<LedgerMachine> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-sessions-")));
  try {
    return { root, hooks: await layOut(root), close: () => removeTemporary(root) };
  } catch (error) {
    await removeTemporary(root);
    throw error;
  }
}

async function layOut(root: string): Promise<LedgerMachine["hooks"]> {
  for (const part of ["home", "checkout", "plans"])
    cpSync(join(fixture, part), join(root, part), { recursive: true });

  const alpha = join(root, "checkout/Alpha");
  rmSync(join(alpha, ".gitkeep"));
  const init = await runCommand(["git", "init", "-q", "-b", "feat/one", alpha], {
    cwd: root,
    env: suiteEnvironment(),
  });

  if (init.code !== 0) throw new Error(`git init: ${init.stderr}`);

  const home = join(root, "home");
  for (const entry of readdirSync(home, { recursive: true, encoding: "utf8" }))
    if (entry.endsWith(".jsonl")) age(join(home, entry));

  const claude = join(home, ".claude/projects/-tmp-sessions-fixture-checkout-Alpha");
  const codex = join(home, ".codex/sessions/2026/11/07");
  return {
    claude: hookPayload("claude-fixture", join(claude, "claude-fixture.jsonl"), alpha),
    codex: hookPayload(
      "codex-fixture",
      join(codex, "rollout-2026-11-07T10-00-00-codex-fixture.jsonl"),
      alpha,
    ),
  };
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
