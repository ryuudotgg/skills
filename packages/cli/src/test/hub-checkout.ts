import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hubLeases, keyFor, openLeaser } from "../hub/leases.ts";
import type { MoveIo, MoveWire } from "../hub/move.ts";
import type { HubFixture } from "./hub-fixture.ts";
import { cleanup, type Machine } from "./hub-machines.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "./process.ts";

export const repo = resolve(import.meta.dir, "../../../..");

export function scratch(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanup.unshift(() => removeTemporary(dir));
  return dir;
}

export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...suiteEnvironment(),
    HOME: home,
    HUB_URL: "",
    SKILLS_AUTO_UPDATE: "0",
    SKILLS_MACHINE_REFRESH: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
}

export function envOf(m: Machine, fixture: HubFixture): NodeJS.ProcessEnv {
  return {
    ...gitEnv(join(m.root, ".home")),
    HUB_KEYS: "file",
    HUB_URL: fixture.url,
    HUB_NETWORK: "local",
    PLANS_DIR: m.root,
    SKILLS_CONF: join(m.root, "skills.conf"),
  };
}

export async function run(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = await runCommand(argv, { cwd, env, timeout: 60_000 });
  if (result.timedOut) throw new Error(`${argv.join(" ")} timed out`);
  return result;
}

export async function must(
  argv: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const result = await run(argv, cwd, env);
  if (result.code !== 0) throw new Error(`${argv.join(" ")}: ${result.stderr || result.stdout}`);
  return result.stdout;
}

export async function halfDone(checkout: string, env: NodeJS.ProcessEnv): Promise<void> {
  writeFileSync(join(checkout, "one.txt"), "one\n");
  await must(["git", "add", "one.txt"], checkout, env);
  await must(["git", "-c", "commit.gpgsign=false", "commit", "-qm", "one"], checkout, env);
  writeFileSync(join(checkout, "one.txt"), "one\nedit\n");
  writeFileSync(join(checkout, "extra.txt"), "extra\n");
}

export function storeQuery(plans: string, sql: string): unknown[] {
  const db = new Database(join(plans, "plans.db"), { readonly: true });
  try {
    return db.query(sql).all();
  } finally {
    db.close();
  }
}

export function capture(cwd: string, env: NodeJS.ProcessEnv, wire?: MoveWire) {
  const out: string[] = [];
  const err: string[] = [];
  const io: MoveIo = {
    cwd,
    env,
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    capture: true,
    ...(wire && { wire }),
  };

  return { io, out, err };
}

export async function holderOf(m: Machine, url: string, id: string): Promise<string | undefined> {
  const leaser = await openLeaser(m.deps, url);
  return (await hubLeases(leaser.call)).get(await keyFor(leaser, "Skills", id))?.holder;
}
