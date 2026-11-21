import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS } from "skills-core";
import { appendFixture, storedRows, writeFixture } from "./fixtures.ts";
import { editPlans, settleViews, type Views } from "./plans-views.ts";
import { removeTemporary } from "./process.ts";

const header = `${COLUMNS.join("\t")}\n`;
const trail =
  "ts\tproject\tid\tevent\tdetail\n2026-11-21T00:00:00Z\tfixture\t001\tstart\tfeat/one\n";

const temporary: string[] = [];

afterEach(async () => {
  for (const root of temporary.splice(0)) await removeTemporary(root);
});

function row(id: string, slug: string): string {
  return [id, slug, "TODO", "P1", "S", "-", "-", "-", "2026-11-21", "-"].join("\t");
}

type Fixture = { root: string; index: string; trail: string };

async function emptyRoot(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "skills-plans-views-"));
  temporary.push(root);
  return { root, index: join(root, "fixture/index.tsv"), trail: join(root, "log.tsv") };
}

async function store(views: Views): Promise<Fixture> {
  const fixture = await emptyRoot();
  await writeFixture(fixture.root, "fixture/index.tsv", `${header}${row("001", "one")}\n`, views);
  await editPlans(fixture.root, () => writeFile(fixture.trail, trail), true, views);

  return fixture;
}

function onDisk(fixture: Fixture): boolean[] {
  return [existsSync(fixture.index), existsSync(fixture.trail)];
}

test("editPlans leaves neither view, a fixture asked to keep them has both, and the rows match", async () => {
  const deleted = await store("deleted");
  const kept = await store("kept");

  expect(onDisk(deleted)).toEqual([false, false]);
  expect(onDisk(kept)).toEqual([true, true]);

  const rows = await storedRows(kept.index);
  expect(rows.map((entry) => [entry.id, entry.slug])).toEqual([["001", "one"]]);
  expect(await storedRows(deleted.index)).toEqual(rows);
});

test("settleViews deletes the views a fixture kept and the rows stay readable", async () => {
  const kept = await store("kept");
  const rows = await storedRows(kept.index);

  await settleViews({ PLANS_DIR: kept.root });

  expect(onDisk(kept)).toEqual([false, false]);
  expect(await storedRows(kept.index)).toEqual(rows);
});

test.each<Views>(["deleted", "kept"])(
  "an append to a store whose views are %s reaches its rows",
  async (views) => {
    const fixture = await store(views);

    await appendFixture(fixture.root, "fixture/index.tsv", `${row("002", "two")}\n`, views);

    expect(onDisk(fixture)).toEqual(views === "kept" ? [true, true] : [false, false]);
    expect((await storedRows(fixture.index)).map((entry) => entry.id)).toEqual(["001", "002"]);
  },
);

test("writeFixture and appendFixture keep the views unless the call asks otherwise", async () => {
  const fixture = await emptyRoot();

  await writeFixture(fixture.root, "fixture/index.tsv", header);
  await writeFixture(fixture.root, "log.tsv", trail);
  await appendFixture(fixture.root, "fixture/index.tsv", `${row("001", "one")}\n`);

  expect(onDisk(fixture)).toEqual([true, true]);
  expect(await storedRows(fixture.index)).toHaveLength(1);
});

test("writeFixture refuses a views choice for a file that is no view", async () => {
  const fixture = await emptyRoot();

  await expect(
    writeFixture(fixture.root, "fixture/001-one.md", "# one\n", "deleted"),
  ).rejects.toThrow("fixture/001-one.md is not a plans view");
});
