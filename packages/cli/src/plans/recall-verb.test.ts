import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  appendFileSync,
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderIndex } from "skills-core";
import type { Io } from "../io.ts";
import { importStore } from "./import.ts";
import { recallVerb } from "./recall-verb.ts";
import { openStore, projectRows, recordRevision, sha256 } from "./store.ts";

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

function bulk(root: string): void {
  for (let at = 1; at <= 80; at++)
    writeFileSync(
      join(root, "Demo", `${100 + at}-bulk.md`),
      [
        "---",
        `id: ${100 + at}`,
        "slug: bulk",
        "project: Demo",
        "surface: the recall fixture",
        "---",
        "",
        "## Outcome",
        "",
        `zqxbulk qz ${"x ".repeat(3 * at)}${`${"m".repeat(40)} `.repeat(80 - at)}`,
        "",
      ].join("\n"),
    );
}

function refs(lines: string[]): string[] {
  return lines.map((line) => line.split("\t")[1]!);
}

test("a limit above fifty prints that many hits when that many match", async () => {
  const { root, env } = await fixture();
  bulk(root);

  const all = await recall(env, "zqxbulk", "--limit", "80");
  expect(all.code).toBe(0);
  expect(all.lines).toHaveLength(80);
  expect(new Set(refs(all.lines)).size).toBe(80);

  expect((await recall(env, "zqxbulk", "--limit", "60")).lines).toHaveLength(60);
  expect((await recall(env, "zqxbulk")).lines).toHaveLength(20);
  expect((await recall(env, "qz", "--limit", "80")).lines).toHaveLength(80);
  expect((await recall(env, "qxbul", "--limit", "80")).lines).toHaveLength(80);
  expect((await recall(env, "zqxbulk", "--limit", "9223372036854775807")).lines).toHaveLength(80);
});

test("a limit at or below fifty fuses each index fifty deep", async () => {
  const { root, env } = await fixture();
  bulk(root);

  const overlap = Array.from({ length: 20 }, (_, at) => String(131 + at));
  for (const args of [[], ["--limit", "20"]])
    expect(refs((await recall(env, "zqxbulk", ...args)).lines).sort()).toEqual(overlap);
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

async function settle(env: NodeJS.ProcessEnv, ...args: string[]) {
  const ahead = Date.now() + 10_000;
  const now = spyOn(Date, "now").mockImplementation(() => ahead);
  try {
    return await recall(env, ...args);
  } finally {
    now.mockRestore();
  }
}

function copiesRead(reads: ReturnType<typeof spyOn<typeof fs, "readFileSync">>): string[] {
  const paths = reads.mock.calls.map(([path]) => String(path));
  return [...new Set(paths.filter((path) => /\/(\d{3}-[^/]*|ctx-[^/]*)\.md$/.test(path)))];
}

test("unchanged copies are not read, and an appended copy is read alone", async () => {
  const { root, env } = await fixture();
  const settled = await settle(env, "revisions");
  expect(settled.lines).toEqual(REVISIONS);

  const reads = spyOn(fs, "readFileSync");
  try {
    expect(await recall(env, "revisions")).toEqual(settled);
    expect(copiesRead(reads)).toEqual([]);

    const edited = join(root, "Demo", "002-labels.md");
    appendFileSync(edited, "\n## Scratch\n\nzqxappended here\n");
    reads.mockClear();

    expect((await recall(env, "zqxappended")).lines).toEqual([
      "Demo\t002\tScratch\tTODO\t[zqxappended] here\tDemo/002-labels.md",
    ]);

    expect(copiesRead(reads)).toEqual([edited]);
  } finally {
    reads.mockRestore();
  }
});

function copy(word: string): string {
  return `---\nid: 005\nslug: racy\nproject: Demo\n---\n\n## Outcome\n\n${word}\n`;
}

function place(path: string, word: string, seconds: number): void {
  writeFileSync(path, copy(word));
  utimesSync(path, seconds, seconds);
  expect(statSync(path).mtimeMs).toBe(seconds * 1000);
}

function rewrite(path: string, word: string): void {
  const { mtimeMs, size } = statSync(path);
  place(path, word, mtimeMs / 1000);
  expect(statSync(path).size).toBe(size);
}

const RACY = "Demo\t005\tOutcome\t-\t[%s]\tDemo/005-racy.md";

test("a copy rewritten with the same size and mtime right after a recall is read", async () => {
  const { root, env } = await fixture();
  const path = join(root, "Demo", "005-racy.md");
  place(path, "zqxfirst", Math.floor(Date.now() / 1000));

  const real = fs.statSync;
  const ctime = statSync(path).ctimeMs;
  const stats = spyOn(fs, "statSync").mockImplementation(((target, options) => {
    const stat = real(target, options);
    if (stat && target === path) stat.ctimeMs = ctime;
    return stat;
  }) as typeof fs.statSync);

  try {
    expect((await recall(env, "zqxfirst")).lines).toEqual([RACY.replace("%s", "zqxfirst")]);

    rewrite(path, "zqxsecnd");
    expect((await recall(env, "zqxsecnd")).lines).toEqual([RACY.replace("%s", "zqxsecnd")]);
    expect((await recall(env, "zqxfirst")).lines).toEqual([]);
  } finally {
    stats.mockRestore();
  }
});

test("a settled copy rewritten under its old mtime is read", async () => {
  const { root, env } = await fixture();
  const path = join(root, "Demo", "005-racy.md");
  place(path, "zqxfirst", Math.floor(Date.now() / 1000));

  expect((await settle(env, "zqxfirst")).lines).toEqual([RACY.replace("%s", "zqxfirst")]);

  rewrite(path, "zqxsecnd");
  expect((await recall(env, "zqxsecnd")).lines).toEqual([RACY.replace("%s", "zqxsecnd")]);
});

test("a stale revision recorded after a settled recall is replaced from disk", async () => {
  const { root, env } = await fixture();
  const path = join(root, "Demo", "005-racy.md");
  place(path, "zqxfirst", Math.floor(Date.now() / 1000));
  await settle(env, "zqxfirst");

  const stale = new TextEncoder().encode(copy("zqxstale"));
  const store = openStore(join(root, "plans.db"));
  try {
    recordRevision(store, "Demo", join("Demo", "005-racy.md"), stale, sha256(stale));
  } finally {
    store.db.close();
  }

  expect((await recall(env, "zqxfirst")).lines).toEqual([RACY.replace("%s", "zqxfirst")]);
  expect((await recall(env, "zqxstale")).lines).toEqual([]);
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

test("a directory that cannot be listed refuses instead of reading as empty", async () => {
  const { root, env } = await fixture();
  const done = join(root, "Demo", "done");
  mkdirSync(done);
  chmodSync(done, 0o000);
  try {
    const unreadable = await recall(env, "revisions");
    expect(unreadable.code).toBe(1);
    expect(unreadable.lines).toEqual([]);
    expect(unreadable.stderr).toContain(`cannot read ${done}`);
  } finally {
    chmodSync(done, 0o755);
  }
});
