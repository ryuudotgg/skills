import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { COLUMNS, readIndex } from "./index-tsv.ts";
import { closeVerb } from "./verbs.ts";

const originalZone = process.env.TZ;
const originalPlans = process.env.PLANS_DIR;
let directory: string | undefined;
let stdout: ReturnType<typeof spyOn<typeof process.stdout, "write">> | undefined;

afterEach(async () => {
  stdout?.mockRestore();
  stdout = undefined;

  if (originalZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalZone;

  if (originalPlans === undefined) delete process.env.PLANS_DIR;
  else process.env.PLANS_DIR = originalPlans;

  setSystemTime();

  if (directory !== undefined) await removeTemporary(directory);
  directory = undefined;
});

test.each([
  { zone: "Asia/Dubai", clock: "2026-10-02T03:30:00+04:00", updated: "2026-10-02" },
  { zone: "America/Los_Angeles", clock: "2026-10-02T23:30:00-07:00", updated: "2026-10-02" },
])("close stamps the local date in $zone", async ({ zone, clock, updated }) => {
  directory = await mkdtemp(join(tmpdir(), "skills-close-date-"));
  const project = join(directory, "fixture");
  const index = join(project, "index.tsv");

  await mkdir(project);
  await writeFile(index, `${COLUMNS.join("\t")}\n1\tnew\tREVIEW\tP1\tS\t-\t-\tfeat/new\t2026-09-26\t-\n`);
  await writeFile(join(project, "1-new.md"), "# New\n\n## Landed\n\nShipped.\n");

  process.env.TZ = zone;
  process.env.PLANS_DIR = directory;
  setSystemTime(new Date(clock));
  stdout = spyOn(process.stdout, "write").mockImplementation(() => true);

  expect(await closeVerb(["fixture", "1", "DONE", "Shipped"], "close")).toBe(0);
  expect(readIndex(index)[0]).toMatchObject({ status: "DONE", updated });
});
