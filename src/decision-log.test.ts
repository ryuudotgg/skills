import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import * as fs from "node:fs";
import { mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendDecision, formulaSafe } from "./decision-log.ts";
import { removeTemporary, runCommand } from "./test/process.ts";

const bin = resolve(import.meta.dir, "../skills/playbook/bin/skills");
const header = "ts\tproject\tplan\tbranch\tevidence\tresult\n";
let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-decision-log-"));
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function log(file: string, cells: readonly string[]): Promise<void> {
  const result = await runCommand([bin, "log", file, ...cells], { cwd: temporary });
  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("");
}

async function expectLog(file: string, cells: readonly (readonly string[])[], unordered = false) {
  const content = await readFile(file, "utf8");
  const lines = content.split("\n").slice(1, -1);
  expect(content).toBe(header + lines.join("\n") + "\n");
  expect(lines).toHaveLength(cells.length);

  if (unordered)
    lines.sort((left, right) =>
      left.slice(left.indexOf("\t")).localeCompare(right.slice(right.indexOf("\t"))),
    );

  for (const [index, line] of lines.entries()) {
    const timestamp = line.split("\t")[0];
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(line).toBe(`${timestamp}\t${cells[index]?.join("\t")}`);
  }
}

test("log.sh: first use creates nested directories and later calls append", async () => {
  const file = join(temporary, "missing/nested/decisions.tsv");
  const first = ["project", "117", "feat/decision-log-verb", "src/decision-log.ts", "first"];
  const second = ["project", "117", "feat/decision-log-verb", "src/decision-log.test.ts", "second"];

  await log(file, first);
  await expectLog(file, [first]);

  await log(file, second);
  await expectLog(file, [first, second]);
});

test("log.sh: tabs, newlines and carriage returns each become one space", async () => {
  const file = join(temporary, "decisions.tsv");
  await log(file, ["project", "117", "branch", "evidence", "a\tb\nc\rd"]);
  await expectLog(file, [["project", "117", "branch", "evidence", "a b c d"]]);
});

test("log.sh: formula prefixes get a quote and embedded equals stay unchanged", async () => {
  const file = join(temporary, "decisions.tsv");
  await log(file, ["=SUM(A1)", "+1", "-rf", "@here", "a=b"]);
  await expectLog(file, [["'=SUM(A1)", "'+1", "'-rf", "'@here", "a=b"]]);
});

test("log.sh: whitespace replacement precedes the formula prefix check", async () => {
  const file = join(temporary, "decisions.tsv");
  await log(file, ["project", "117", "branch", "evidence", "\t=x"]);
  await expectLog(file, [["project", "117", "branch", "evidence", " =x"]]);
});

test("log.sh: five arguments report usage without creating a file", async () => {
  const file = join(temporary, "decisions.tsv");
  const result = await runCommand([bin, "log", file, "project", "117", "branch", "evidence"], {
    cwd: temporary,
  });

  expect(result.code).toBe(2);
  expect(result.timedOut).toBe(false);
  expect(result.stderr).toBe(
    "usage: skills log <file> <project> <plan> <branch> <evidence> <result>\n",
  );

  expect(result.stdout).toBe("");
  expect(existsSync(file)).toBe(false);
});

test("log.sh: a dangling symlink gets the header written through it", async () => {
  const file = join(temporary, "decisions.tsv");
  const target = join(temporary, "target/decisions.tsv");
  await symlink(target, file);

  await log(file, ["project", "117", "branch", "evidence", "result"]);

  await expectLog(target, [["project", "117", "branch", "evidence", "result"]]);
});

test("log.sh: a filesystem without hard links still gets the header", async () => {
  const file = join(temporary, "decisions.tsv");
  const link = spyOn(fs, "linkSync").mockImplementation(() => {
    throw Object.assign(new Error("operation not supported"), { code: "ENOTSUP" });
  });

  try {
    appendDecision(file, ["project", "117", "branch", "evidence", "result"], new Date(0));
    expect(link).toHaveBeenCalled();
  } finally {
    link.mockRestore();
  }

  expect(await readFile(file, "utf8")).toBe(
    `${header}1970-01-01T00:00:00Z\tproject\t117\tbranch\tevidence\tresult\n`,
  );

  expect(fs.readdirSync(temporary)).toEqual(["decisions.tsv"]);
});

test("log.sh: concurrent first calls keep one header before both rows", async () => {
  const first = ["first", "117", "branch", "evidence", "result"];
  const second = ["second", "117", "branch", "evidence", "result"];
  const files = Array.from({ length: 10 }, (_, iteration) =>
    join(temporary, `${iteration}/decisions.tsv`),
  );

  await Promise.all(files.map((file) => Promise.all([log(file, first), log(file, second)])));

  for (const file of files) await expectLog(file, [first, second], true);
}, 30_000);

test("log.sh: formulaSafe preserves the legacy cell transformations", () => {
  const cases = [
    ["a\tb\nc\rd", "a b c d"],
    ["=SUM(A1)", "'=SUM(A1)"],
    ["+1", "'+1"],
    ["-rf", "'-rf"],
    ["@here", "'@here"],
    ["a=b", "a=b"],
    ["\t=x", " =x"],
  ] as const;

  for (const [value, expected] of cases) expect(formulaSafe(value)).toBe(expected);
});
