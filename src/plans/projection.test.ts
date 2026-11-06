import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { importRoot } from "./import.ts";
import { COLUMNS, type IndexRow } from "./index-tsv.ts";
import { readPlans, readProject } from "./projection.ts";
import { appendEvent, openStore, write } from "./store.ts";

const temporary: string[] = [];

afterEach(async () => {
  for (const path of temporary.splice(0)) {
    await chmod(path, 0o755).catch(() => {});
    await removeTemporary(path);
  }
});

async function directory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "skills-projection-"));
  temporary.push(path);
  return path;
}

const row: IndexRow = {
  id: "001",
  slug: "a",
  status: "TODO",
  pri: "P1",
  effort: "S",
  blocked_by: "-",
  ctx: "-",
  branch: "-",
  updated: "2026-11-06",
  note: "-",
};

async function plansWithRow(): Promise<string> {
  const root = await directory();
  await mkdir(join(root, "fixture"));
  await writeFile(
    join(root, "fixture/index.tsv"),
    `${COLUMNS.join("\t")}\n${COLUMNS.map((column) => row[column]).join("\t")}\n`,
  );

  return root;
}

test("a missing plans directory reads as no projects and no trail", async () => {
  const root = join(await directory(), "missing");
  expect(await readPlans({ PLANS_DIR: root })).toEqual({
    kind: "plans",
    plans: { projects: new Map(), trail: [] },
  });
});

test.skipIf(process.getuid?.() === 0)(
  "a plans directory that cannot be read is failed, never empty",
  async () => {
    const parent = await directory();
    await mkdir(join(parent, "plans"));
    await chmod(parent, 0);

    expect(await readPlans({ PLANS_DIR: join(parent, "plans") })).toEqual({
      kind: "failed",
      reason: `cannot read ${join(parent, "plans")}: EACCES`,
    });
  },
);

test("the first read imports the views into a new store", async () => {
  const root = await plansWithRow();
  expect(await readProject("fixture", { PLANS_DIR: root })).toEqual({ kind: "rows", rows: [row] });
  expect(existsSync(join(root, "plans.db"))).toBe(true);
});

test("a row stored with a tab or newline reads back flattened, as its view shows it", async () => {
  const root = await plansWithRow();
  await importRoot(root);

  const store = openStore(join(root, "plans.db"));
  try {
    write(store, () =>
      appendEvent(store, {
        type: "row",
        at: Date.now(),
        project: "fixture",
        plan: "001",
        payload: { row: { ...row, branch: "feat/a\tb\nc" } },
      }),
    );
  } finally {
    store.db.close();
  }

  expect(await readProject("fixture", { PLANS_DIR: root })).toEqual({
    kind: "rows",
    rows: [{ ...row, branch: "feat/a b c" }],
  });
});

test("a header only index the store has not seen reads as an empty project", async () => {
  const root = await plansWithRow();
  await importRoot(root);
  await mkdir(join(root, "fresh"));
  await writeFile(join(root, "fresh/index.tsv"), `${COLUMNS.join("\t")}\n`);

  expect(await readProject("fresh", { PLANS_DIR: root })).toEqual({ kind: "rows", rows: [] });
});

test("a project whose directory is gone is no longer read", async () => {
  const root = await plansWithRow();
  await importRoot(root);
  await rm(join(root, "fixture"), { recursive: true });

  expect(await readProject("fixture", { PLANS_DIR: root })).toEqual({ kind: "absent" });
});

test("a checked read refuses a view edited outside the store, a plain read does not", async () => {
  const root = await plansWithRow();
  await importRoot(root);
  await writeFile(join(root, "fixture/index.tsv"), `${COLUMNS.join("\t")}\n`);

  expect((await readPlans({ PLANS_DIR: root })).kind).toBe("plans");
  expect(await readPlans({ PLANS_DIR: root }, true)).toEqual({
    kind: "failed",
    reason: `${join(root, "fixture/index.tsv")} changed outside the store, run skills plans import to take the edit in`,
  });
});
