import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { leftLine, selectBatch } from "./batch.ts";
import { frontmatterBlockers } from "./overlap.ts";
import { readProject } from "./projection.ts";
import { markStarted } from "./verbs.ts";

const bin = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
let temporary: string;
let plans: string;

function row(
  id: string,
  slug: string,
  status: string,
  pri: string,
  effort: string,
  blockedBy: string,
  branch: string,
) {
  return [id, slug, status, pri, effort, blockedBy, "-", branch, "2026-09-26", "-"].join("\t");
}

async function index(project: string, rows: readonly string[]): Promise<void> {
  await writeFixture(plans, `${project}/index.tsv`, `${[header, ...rows].join("\n")}\n`);
}

async function skills(args: readonly string[], cwd = temporary) {
  return runCommand([bin, ...args], {
    cwd,
    env: { ...suiteEnvironment(), PLANS_DIR: plans, SKILLS_CONF: join(temporary, "skills.conf") },
    timeout: 60_000,
  });
}

async function initRepo(path: string): Promise<void> {
  await fixtureGit(temporary, ["init", "-q", "-b", "main", path]);
  await fixtureGit(path, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-cross-"));
  plans = join(temporary, "plans");
  await writeFixture(temporary, "skills.conf", "DELIVERY=hands-off\n");
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function twoProjects(): Promise<string> {
  await index("Alpha", [
    row("001", "one", "TODO", "P2", "S", "-", "-"),
    row("002", "two", "TODO", "P2", "S", "-", "-"),
  ]);

  await index("Beta", [
    row("001", "one", "TODO", "P2", "S", "-", "-"),
    row("002", "two", "TODO", "P2", "S", "-", "-"),
  ]);

  const alpha = join(temporary, "alpha");
  await initRepo(alpha);
  return alpha;
}

test("add checks each ref, the frontier waits on it and start refuses before any PR read", async () => {
  const alpha = await twoProjects();

  const added = await skills(["plans", "add", "Alpha", "cross", "P3", "XS", "Beta/001", "-"]);
  expect([added.code, added.stdout.split("\t").slice(0, 6)]).toEqual([
    0,
    ["003", "cross", "TODO", "P3", "XS", "Beta/001"],
  ]);

  const refusals = [
    ["Beta/999", "blocked_by Beta/999: Beta has no row 999\n"],
    ["Nowhere/001", `blocked_by Nowhere/001: no project Nowhere in ${plans}\n`],
    ["beta/001", `blocked_by beta/001: no project beta in ${plans}, did you mean Beta\n`],
    ["Alpha/001", "blocked_by Alpha/001: names this project, write 001\n"],
    ["alpha/001", "blocked_by alpha/001: names this project, write 001\n"],
    ["Beta#1", "blocked_by Beta#1: no issue Beta#1\n"],
    ["050", "blocked_by 050: no row or plan file 050 in Alpha\n"],
    ["001 002", "bad blocked_by: 001 002\n"],
  ];

  for (const [ref, stderr] of refusals) {
    const refused = await skills(["plans", "add", "Alpha", "refused", "P3", "XS", ref!, "-"]);
    expect([ref, refused.code, refused.stderr]).toEqual([ref, 1, stderr]);
  }

  const canonical = await skills(["plans", "add", "Alpha", "both", "P3", "XS", " 001 ,-, 002,001"]);

  expect(canonical.stdout.split("\t").slice(0, 6)).toEqual([
    "004",
    "both",
    "TODO",
    "P3",
    "XS",
    "001,002",
  ]);

  expect((await skills(["plans", "frontier", "Alpha"])).stdout).toContain(
    "003  P3  cross                              waits on Beta/001\n",
  );

  const started = await skills(["plans", "start", "Alpha", "003"], alpha);
  expect([started.code, started.stderr]).toEqual([
    1,
    "stack-base: blocker Beta/001 is TODO in Beta\n",
  ]);

  expect(await fixtureGit(alpha, ["branch", "--list", "feat/cross"])).toBe("");

  const before = new Date().toISOString();
  await Bun.sleep(5);
  await skills(["plans", "set-row", "Beta", "001", "DROPPED", "-", "gone"]);

  const frontier = (await skills(["plans", "frontier", "Alpha"])).stdout;
  expect(frontier).toStartWith("READY 3\n001  P2  S   one");
  expect(frontier).toContain("003  P3  XS  cross");
  expect((await skills(["plans", "frontier", "--at", before, "Alpha"])).stdout).toContain(
    "waits on Beta/001",
  );
});

test("lint never reads the id inside another project's ref as a local one", async () => {
  await twoProjects();
  await skills(["plans", "add", "Alpha", "three", "P2", "S"]);
  await writeFixture(
    plans,
    "Alpha/ctx-cross.md",
    [
      "The mirror wants its own plan, Beta/002.",
      "The probe wants its own plan, see evidence/001-review/.",
      "The sync wants its own plan, unlike Beta/003.",
      "",
    ].join("\n"),
  );

  expect((await skills(["plans", "lint", "Alpha"])).stdout).toBe(
    "ctx-cross.md: line 3: intention with no id: wants its own plan\n1 error(s)\n",
  );
});

test("the batch claim leaves a member waiting on another project's open plan", () => {
  const member = (id: string, blockedBy: string) => ({
    id,
    slug: `plan-${id}`,
    status: "TODO",
    pri: "P2",
    effort: "S",
    blocked_by: blockedBy,
    ctx: "ctx-cross",
    branch: "-",
    updated: "2026-11-08",
    note: "-",
  });

  const rows = [member("001", "Beta/001"), member("002", "001"), member("003", "001 002")];
  const beta = (status: string) => ({
    projects: new Map([["Beta", [{ ...member("001", "-"), status }]]]),
    issues: new Map(),
  });

  expect(selectBatch(rows, "ctx-cross", beta("REVIEW")).left.map(leftLine)).toEqual([
    "left 001 waits on Beta/001 REVIEW",
    "left 002 waits on 001 TODO",
    "left 003 waits on 001 002 not a blocker ref",
  ]);

  expect(selectBatch(rows, "ctx-cross", beta("DONE")).members.map((row) => row.id)).toEqual([
    "001",
    "002",
  ]);
});

test("the frontier at a past time reads a blocker project whose directory has gone since", async () => {
  await twoProjects();
  await skills(["plans", "add", "Alpha", "cross", "P3", "XS", "Beta/001", "-"]);
  await skills(["plans", "set-row", "Beta", "001", "DONE"]);
  await Bun.sleep(5);

  const after = new Date().toISOString();
  await rm(join(plans, "Beta"), { recursive: true });

  expect((await skills(["plans", "frontier", "--at", after, "Alpha"])).stdout).toContain(
    "003  P3  XS  cross",
  );

  expect((await skills(["plans", "frontier", "Alpha"])).stdout).toContain("waits on Beta/001");
});

test("a project with rows the store has not imported refuses naming the import", async () => {
  await twoProjects();
  await mkdir(join(plans, "Gamma"));
  await writeFile(
    join(plans, "Gamma/index.tsv"),
    `${header}\n${row("001", "one", "TODO", "P2", "S", "-", "-")}\n`,
  );

  const refused = await skills(["plans", "add", "Alpha", "cross", "P3", "XS", "Gamma/001", "-"]);
  expect([refused.code, refused.stderr]).toEqual([
    1,
    "blocked_by Gamma/001: Gamma is not in the store yet, run skills plans import\n",
  ]);
});

test("start refuses an open foreign blocker before it reads a local blocker's PR", async () => {
  const alpha = await twoProjects();
  await skills(["plans", "set-row", "Alpha", "002", "REVIEW", "feat/two"]);
  await skills(["plans", "add", "Alpha", "cross", "P3", "XS", "002,Beta/001", "-"]);

  const started = await skills(["plans", "start", "Alpha", "003"], alpha);
  expect([started.code, started.stderr]).toEqual([
    1,
    "stack-base: blocker Beta/001 is TODO in Beta\n",
  ]);
});

test("overlap reads only local ids from a plan's frontmatter", () => {
  expect(frontmatterBlockers("---\nblocked_by: 001, Beta/002, Beta#3\n---\n")).toEqual(["001"]);
});

test("the claim refuses a row whose foreign blocker reopened after its checks", async () => {
  await twoProjects();
  await skills(["plans", "set-row", "Beta", "001", "DONE"]);
  await skills(["plans", "add", "Alpha", "cross", "P3", "XS", "Beta/001", "-"]);

  const env = { ...process.env, PLANS_DIR: plans };
  const read = await readProject("Alpha", env);
  if (read.kind !== "rows") throw new Error(read.kind);

  const checked = read.rows.find((entry) => entry.id === "003")!;
  await skills(["plans", "set-row", "Beta", "001", "TODO"]);

  const index = join(plans, "Alpha/index.tsv");
  expect(await markStarted(index, "Alpha", "feat/cross", [checked], env)).toEqual({
    refusal: "blocker Beta/001 is TODO in Beta",
  });

  expect(await markStarted(index, "Alpha", "feat/cross", [checked, checked], env)).toEqual({
    refusal: "row 003 blocker Beta/001 is TODO in Beta",
  });
});
