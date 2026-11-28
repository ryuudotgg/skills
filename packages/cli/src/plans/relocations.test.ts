import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_HEADER } from "skills-core";
import { importStore } from "./import.ts";
import {
  dropPending,
  readRelocations,
  RELOCATIONS,
  relocationRecord,
  settleRelocation,
  writePending,
} from "./relocations.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function scratch(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "skills-relocations-")));
  temporary.push(root);
  return root;
}

function paths<const T extends readonly string[]>(
  root: string,
  ...names: T
): { [K in keyof T]: string } {
  return names.map((name) => join(root, name)) as { [K in keyof T]: string };
}

function moved(plans: string, from: string, to: string, at: number): void {
  writePending(plans, [from], to);
  mkdirSync(to, { recursive: true });
  settleRelocation(plans, to, at);
}

test("a second relocation moves the first row's target to the last place", () => {
  const root = scratch();
  const [a, b, c] = paths(root, "a", "b", "c");
  moved(root, a, b, 1);
  moved(root, b, c, 2);

  expect(readRelocations(root)).toEqual([
    { source: a, target: c, at: 1 },
    { source: b, target: c, at: 2 },
  ]);

  expect(
    relocationRecord(root)
      .placesOf(join(a, "app"))
      .map((each) => each.place),
  ).toEqual([join(c, "app")]);
});

test("a relocation back to the old path drops the row it undoes", () => {
  const root = scratch();
  const [a, b] = paths(root, "a", "b");
  moved(root, a, b, 1);
  moved(root, b, a, 2);

  expect(readRelocations(root)).toEqual([{ source: b, target: a, at: 2 }]);
});

test("a second run that settles again keeps its rows and their time", () => {
  const root = scratch();
  const [a, b] = paths(root, "a", "b");
  moved(root, a, b, 1);
  settleRelocation(root, b, 5);

  expect(readRelocations(root)).toEqual([{ source: a, target: b, at: 1 }]);
});

test("a pending row is read by no reader and leaves with dropPending", () => {
  const root = scratch();
  const [a, b] = paths(root, "a", "b");
  mkdirSync(b);
  writePending(root, [a, join(root, "spelled")], b);

  expect(readFileSync(join(root, RELOCATIONS), "utf8")).toBe(
    `${a}\t${b}\t\n${join(root, "spelled")}\t${b}\t\n`,
  );

  expect(relocationRecord(root).placesOf(a)).toEqual([]);

  dropPending(root, b);
  expect(readRelocations(root)).toEqual([]);
});

test("a row whose target is gone changes no reading", () => {
  const root = scratch();
  const [a, b] = paths(root, "a", "b");
  moved(root, a, b, 1);
  rmSync(b, { recursive: true });

  expect(relocationRecord(root).placesOf(a)).toEqual([]);
});

test("rows hold their source and what is inside it, read in time order", () => {
  const root = scratch();
  const [outer, inner, x, y] = paths(root, "outer", "outer/inner", "x", "y");
  moved(root, outer, x, 3);
  moved(root, inner, y, 2);

  const record = relocationRecord(root);
  expect(record.placesOf(join(inner, "app")).map((each) => each.place)).toEqual([
    join(y, "app"),
    join(x, "inner/app"),
  ]);

  expect(record.placesOf(`${outer}-other`)).toEqual([]);
  expect(record.placesOf(root)).toEqual([]);
});

test("a record reads its file once, at its first lookup", () => {
  const root = scratch();
  const [a, b] = paths(root, "a", "b");
  const record = relocationRecord(root);
  moved(root, a, b, 1);

  expect(record.placesOf(a).map((each) => each.place)).toEqual([b]);

  rmSync(join(root, RELOCATIONS));
  expect(record.placesOf(a).map((each) => each.place)).toEqual([b]);
  expect(relocationRecord(root).placesOf(a)).toEqual([]);
});

test("a malformed line is skipped", () => {
  const root = scratch();
  writeFileSync(join(root, RELOCATIONS), "relative\t/b\t1\n/a\t/b\tsoon\n/a\t/b\n/c\t/d\t7\n");
  expect(readRelocations(root)).toEqual([{ source: "/c", target: "/d", at: 7 }]);
});

test("skills plans import leaves relocations.tsv byte identical", async () => {
  const root = scratch();
  mkdirSync(join(root, "Skills"));
  writeFileSync(
    join(root, "Skills", "index.tsv"),
    "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n",
  );

  writeFileSync(join(root, "log.tsv"), LOG_HEADER);
  moved(root, join(root, "a"), join(root, "b"), 1);
  writePending(root, [join(root, "c")], join(root, "d"));

  const before = readFileSync(join(root, RELOCATIONS));
  await importStore({ PLANS_DIR: root });
  await importStore({ PLANS_DIR: root });

  expect(readFileSync(join(root, RELOCATIONS))).toEqual(before);
});

test("a move into a vacated target settles again and carries the rows that point at it", () => {
  const root = scratch();
  const [a, b, x] = paths(root, "a", "b", "x");
  moved(root, a, b, 1);
  rmSync(b, { recursive: true });

  moved(root, x, a, 2);
  moved(root, a, b, 3);

  expect(readRelocations(root)).toEqual([
    { source: x, target: b, at: 2 },
    { source: a, target: b, at: 3 },
  ]);
});

test("an inner move after an outer one keeps the outer source reaching the inner place", () => {
  const root = scratch();
  const [f, t, y] = paths(root, "f", "t", "y");
  moved(root, f, t, 1);
  mkdirSync(join(t, "sub"));
  moved(root, join(t, "sub"), y, 2);

  expect(readRelocations(root)).toEqual([
    { source: f, target: t, at: 1 },
    { source: join(t, "sub"), target: y, at: 2 },
    { source: join(f, "sub"), target: y, at: 2 },
  ]);

  expect(
    relocationRecord(root)
      .placesOf(join(f, "sub/app"))
      .map((each) => each.place),
  ).toEqual([join(t, "sub/app"), join(y, "app")]);
});

test("a record sees its target leave and come back between lookups", () => {
  const root = scratch();
  const [a, b] = paths(root, "a", "b");
  moved(root, a, b, 1);

  const record = relocationRecord(root);
  expect(record.placesOf(a).map((each) => each.place)).toEqual([b]);

  rmSync(b, { recursive: true });
  expect(record.placesOf(a)).toEqual([]);

  mkdirSync(b);
  expect(record.placesOf(a).map((each) => each.place)).toEqual([b]);
});

test("a directory under another spelling of a row's source has its place where the disk folds case", () => {
  const root = scratch();
  const [repo, target] = paths(root, "Repo", "moved");
  moved(root, repo, target, 1);
  const folds = existsSync(join(root, "MOVED"));

  const record = relocationRecord(root);
  expect(record.placesOf(join(root, "repo/App")).map((each) => each.place)).toEqual(
    folds ? [join(target, "App")] : [],
  );

  expect(record.formerPathsOf(join(root, "MOVED"))).toEqual(folds ? [repo] : []);
  expect(record.formerPathsOf(target)).toEqual([repo]);
});

test("a case only move after an older row carries its target and drops no row", () => {
  const root = scratch();
  const [old, upper, lower] = paths(root, "old", "Repo", "repo");
  moved(root, old, upper, 1);
  moved(root, upper, lower, 2);

  expect(readRelocations(root)).toEqual([
    { source: old, target: lower, at: 1 },
    { source: upper, target: lower, at: 2 },
  ]);
});

test("only ASCII letters fold when a reader compares a row", () => {
  const root = scratch();
  const [source, target] = paths(root, "RÉPO", "MÖVED");
  moved(root, source, target, 1);

  const record = relocationRecord(root);
  expect(record.placesOf(join(root, "RéPO/app"))).toEqual([]);
  expect(record.formerPathsOf(join(root, "MöVED"))).toEqual([]);
});
