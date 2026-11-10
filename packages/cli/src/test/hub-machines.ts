import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, LOG_HEADER } from "skills-core";
import { connect } from "../hub/client.ts";
import { enrolled, init, invite, join as joinVault, settle, type Deps } from "../hub/enroll.ts";
import { keyStore } from "../hub/keys.ts";
import { LONG_BUDGET, syncVerb } from "../hub/sync.ts";
import { appendLog } from "../plans/commit.ts";
import { importStore } from "../plans/import.ts";
import { openStore, type Store } from "../plans/store.ts";
import { startHubFixture, type HubFixture } from "./hub-fixture.ts";

export const DAY = 24 * 60 * 60 * 1000;

export const cleanup: (() => Promise<void> | void)[] = [];
export async function runCleanup(): Promise<void> {
  for (const step of cleanup.splice(0).reverse()) await step();
}

export type Machine = { root: string; store: Store; deps: Deps; lines: string[] };

function plans(root: string, files: Record<string, string>): void {
  mkdirSync(join(root, "Skills", "done"), { recursive: true });

  const rows = ["001\tone", "002\ttwo"].map((head) =>
    [head, "TODO", "P1", "S", "-", "-", "-", "2026-11-07", "-"].join("\t"),
  );

  writeFileSync(join(root, "Skills", "index.tsv"), [COLUMNS.join("\t"), ...rows, ""].join("\n"));
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);
  for (const [path, text] of Object.entries(files)) writeFileSync(join(root, path), text);
}

export async function machine(files?: Record<string, string>, from?: string): Promise<Machine> {
  const root = mkdtempSync(join(tmpdir(), "hub-sync-"));
  if (from !== undefined) cpSync(from, root, { recursive: true });
  else if (files !== undefined) plans(root, files);

  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  const lines: string[] = [];
  const deps: Deps = {
    store,
    keys: keyStore(
      { HOME: join(root, ".home"), HUB_KEYS: "file", PATH: process.env.PATH },
      "linux",
    ),
    connect: (url, deadline) => connect(url, "local", fetch, undefined, deadline),
    now: Date.now,
    sleep: async () => {},
    out: (line) => lines.push(line),
  };

  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  return { root, store, deps, lines };
}

export async function hub(): Promise<HubFixture> {
  const started = await startHubFixture();
  cleanup.push(() => started.stop());
  return started;
}

export async function sync(m: Machine, url: string, publishQuarantine = false): Promise<string[]> {
  m.lines.length = 0;
  await syncVerb(m.deps, url, { budget: LONG_BUDGET, publishQuarantine, quiet: false });
  return [...m.lines];
}

export async function enrolledPair(fixture: HubFixture): Promise<{ a: Machine; b: Machine }> {
  const a = await machine({ "Skills/001-one.md": "# 001 one\n", "Skills/ctx-x.md": "# ctx\n" });
  await appendLog("Skills", "001", "start", "feat/one", { PLANS_DIR: a.root });
  await init(a.deps, fixture.url, fixture.initCode ?? "", "A");

  const b = await machine();
  await enroll(a, b, fixture, "B");

  return { a, b };
}

export async function enroll(
  a: Machine,
  b: Machine,
  fixture: HubFixture,
  label: string,
): Promise<void> {
  a.lines.length = 0;
  await invite(a.deps, fixture.url, { label, lasts: DAY, wait: false });
  const line = (a.lines.at(-1) ?? "").split(" ").at(-1) ?? "";
  const settleInvites = async () =>
    void (await settle(a.deps, await enrolled(a.deps, fixture.url)));

  await joinVault({ ...b.deps, sleep: settleInvites }, fixture.url, line);
}
