import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIndex } from "skills-core";
import type { Io } from "../io.ts";
import { importStore } from "./import.ts";
import { recallVerb } from "./recall-verb.ts";
import { openStore, projectRows } from "./store.ts";

const FIXTURE = join(import.meta.dir, "..", "test", "recall-fixture");

const REVISIONS = [
  "Demo\t001\tOutcome\tTODO\t[Revision] history of plans, [revision] text kept.\tDemo/001-history.md",
  "Demo\t003\tOutcome\tTODO\t[Revision] text and machine labels.\tDemo/003-both.md",
];

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

async function fixture(): Promise<{ root: string; env: NodeJS.ProcessEnv }> {
  const root = join(mkdtempSync(join(tmpdir(), "skills-recall-verb-")), "plans");
  temporary.push(join(root, ".."));
  cpSync(FIXTURE, root, { recursive: true });

  const env = { PLANS_DIR: root };
  await importStore(env);
  return { root, env };
}

async function recall(env: NodeJS.ProcessEnv, ...args: string[]) {
  const io: Io & { stdout: string; stderr: string } = {
    cwd: "/",
    env,
    capture: true,
    stdout: "",
    stderr: "",
    out(text) {
      io.stdout += text;
    },
    err(text) {
      io.stderr += text;
    },
  };

  const code = await recallVerb(args, "usage", io);
  return { code, lines: io.stdout.split("\n").filter(Boolean), stderr: io.stderr };
}

test("the fixture's index round trips through plans import", async () => {
  const { root } = await fixture();
  const original = readFileSync(join(FIXTURE, "Demo", "index.tsv"), "utf8");
  const store = openStore(join(root, "plans.db"));
  try {
    expect(renderIndex(projectRows(store, "Demo"))).toBe(original);
  } finally {
    store.db.close();
  }

  expect(readFileSync(join(root, "Demo", "index.tsv"), "utf8")).toBe(original);
});

test("recall prints hits best first, bounded by the limit and the project", async () => {
  const { env } = await fixture();

  expect(await recall(env, "revisions")).toEqual({ code: 0, lines: REVISIONS, stderr: "" });
  expect((await recall(env, "revisions", "--limit", "1")).lines).toEqual(REVISIONS.slice(0, 1));
  expect((await recall(env, "revisions", "--project", "demo")).lines).toEqual(REVISIONS);
  expect(await recall(env, "zqxnothing")).toEqual({ code: 0, lines: [], stderr: "" });

  const unknown = await recall(env, "revisions", "--project", "Nope");
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toContain("Nope");
});

test("a query that is missing or blank, or a bad flag, is a usage error", async () => {
  const { env } = await fixture();
  for (const args of [[], ["  "], ["x", "--limit", "0"], ["x", "--project"], ["x", "--nope"]])
    expect(await recall(env, ...args)).toEqual({ code: 2, lines: [], stderr: "usage: usage\n" });
});

test("--json prints the hit fields with the recorded time and the fused rank", async () => {
  const { env } = await fixture();
  const { lines } = await recall(env, "machine labels", "--json");
  const hits = lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  expect(hits.map((hit) => [hit.ref, hit.section, hit.snippet])).toEqual([
    ["002", "Outcome", "[Machine] facts and [labels]."],
    ["003", "Outcome", "Revision text and [machine] [labels]."],
  ]);

  for (const hit of hits) {
    expect(Object.keys(hit)).toEqual([
      "project",
      "ref",
      "section",
      "status",
      "snippet",
      "path",
      "recorded",
      "rank",
    ]);

    expect(hit.recorded).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  }

  expect(hits[0]!.rank).toBeCloseTo(2 / 61, 12);
  expect(hits[1]!.rank).toBeCloseTo(2 / 62, 12);
});

test("a fragment of a word matches through the partial index alone", async () => {
  const { env } = await fixture();
  const { lines } = await recall(env, "recordRev");

  expect(lines).toEqual([
    "Demo\t004\tOutcome\tTODO\tCalls [recordRev]ision after plans.db opens; set-row stays.\tDemo/004-ident.md",
  ]);
});

test("an unrecorded edit is found at once, and a cleared index catches up", async () => {
  const { root, env } = await fixture();
  appendFileSync(join(root, "Demo", "002-labels.md"), "\n## Scratch\n\nzqxedited here\n");

  expect((await recall(env, "zqxedited")).lines).toEqual([
    "Demo\t002\tScratch\tTODO\t[zqxedited] here\tDemo/002-labels.md",
  ]);

  const db = new Database(join(root, "plans.db"));
  db.run("DELETE FROM recall");
  db.run("UPDATE recall_state SET value = 0");
  db.close();

  expect((await recall(env, "revisions")).lines).toEqual(REVISIONS);
});

test("a tab inside a heading never adds a field to the hit line", async () => {
  const { root, env } = await fixture();
  appendFileSync(join(root, "Demo", "001-history.md"), "\n## Design\tnotes\n\nzqxtabbed\n");

  const { lines } = await recall(env, "zqxtabbed");
  expect(lines.map((line) => line.split("\t"))).toEqual([
    ["Demo", "001", "Design notes", "TODO", "[zqxtabbed]", "Demo/001-history.md"],
  ]);
});

test("a short word stays required when the partial index searches only the long ones", async () => {
  const { env } = await fixture();

  expect((await recall(env, "zz", "labels")).lines).toEqual([]);
  expect((await recall(env, "db", "recordRev")).lines.map((line) => line.split("\t")[1])).toEqual([
    "004",
  ]);
});
