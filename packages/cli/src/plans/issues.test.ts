import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { viewText, writeFixture } from "../test/fixtures.ts";
import { viewsDeleted } from "../test/plans-views.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

const bin = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";

let temporary: string;
let plans: string;
async function skills(args: readonly string[]) {
  return runCommand([bin, ...args], {
    cwd: temporary,
    env: { ...suiteEnvironment(), PLANS_DIR: plans, SKILLS_CONF: join(temporary, "skills.conf") },
    timeout: 60_000,
  });
}

async function ok(args: readonly string[]): Promise<string> {
  const result = await skills(args);
  expect(result.stderr).toBe("");
  expect(result.code).toBe(0);
  return result.stdout;
}

function trailLines(): number | undefined {
  const path = join(plans, "log.tsv");
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").length : undefined;
}

function indexText(project: string): Promise<string | null> {
  return viewText(join(plans, project, "index.tsv"));
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-issues-"));
  plans = join(temporary, "plans");
  await writeFixture(temporary, "skills.conf", "DELIVERY=hands-off\n");
  await writeFixture(temporary, "body.md", "Needs a lint rule for refs.\n");

  for (const project of ["Alpha", "Beta"]) {
    await writeFixture(plans, `${project}/index.tsv`, `${header}\n`);
    await ok(["plans", "add", project, "one", "P2", "S", "-", "-"]);
    await ok(["plans", "add", project, "two", "P2", "S", "-", "-"]);
  }
});

afterEach(async () => {
  await removeTemporary(temporary);
});

test("file numbers issues per project and writes no view or trail line", async () => {
  const trail = trailLines();
  const views = await Promise.all([indexText("Alpha"), indexText("Beta")]);
  const body = join(temporary, "body.md");

  expect(
    await ok(["issues", "file", "Beta", "Lint plan refs", "--body", body, "--from", "Alpha/001"]),
  ).toBe("Beta#1\n");

  expect(await ok(["issues", "file", "Beta", "Second\tline"])).toBe("Beta#2\n");
  expect(await ok(["issues", "file", "Alpha", "Its own count"])).toBe("Alpha#1\n");

  const nowhere = await skills(["issues", "file", "Nowhere", "x"]);
  expect(nowhere.code).toBe(1);
  expect(nowhere.stderr).toContain("no project Nowhere");

  await writeFixture(plans, "My Project/index.tsv", `${header}\n`);

  const spaced = await skills(["issues", "file", "My Project", "x"]);
  expect(spaced.code).toBe(1);
  expect(spaced.stderr).toContain("My Project cannot head an issue ref");

  const beta = await skills(["issues", "file", "beta", "x"]);
  expect(beta.code).toBe(1);
  expect(beta.stderr).toContain("did you mean Beta");

  const missing = await skills(["issues", "file", "Beta", "x", "--from", "Alpha/999"]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Alpha/999");

  const issueFrom = await skills(["issues", "file", "Beta", "x", "--from", "Alpha#1"]);
  expect(issueFrom.code).toBe(1);
  expect(issueFrom.stderr).toContain("not a plan ref");

  expect(trailLines()).toBe(trail);
  expect(await Promise.all([indexText("Alpha"), indexText("Beta")])).toEqual(
    viewsDeleted ? [null, null] : views,
  );

  expect(await ok(["plans", "import"])).toBe("imported 0 rows, 0 events, 0 files\n");
});

test("list and show print the inbox, close moves an issue out of it once", async () => {
  await ok([
    "issues",
    "file",
    "Beta",
    "Lint plan refs",
    "--from",
    "Alpha/001",
    "--body",
    join(temporary, "body.md"),
  ]);

  await ok(["issues", "file", "Beta", "Second\nline"]);

  const both = "Beta#1\topen\tLint plan refs\tAlpha/001\nBeta#2\topen\tSecond line\t-\n";
  expect(await ok(["issues", "list", "Beta"])).toBe(both);
  expect(await ok(["issues", "list"])).toBe(both);
  expect(await ok(["issues", "list", "Alpha"])).toBe("");

  const shown = (await ok(["issues", "show", "Beta#1"])).split("\n");
  expect(shown[0]).toBe("Lint plan refs");
  expect(shown[1]).toBe("from Alpha/001");
  expect(shown[2]).toMatch(/^filed \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  expect(shown.slice(3)).toEqual(["open", "", "Needs a lint rule for refs.", ""]);
  expect(await ok(["issues", "show", "Beta#2"])).toMatch(
    /^Second line\nfrom -\nfiled \S+\nopen\n\n$/,
  );

  expect(await ok(["issues", "close", "Beta#1", "already linted"])).toBe(
    "Beta#1\tclosed\tLint plan refs\tAlpha/001\n",
  );

  expect(await ok(["issues", "list", "Beta"])).toBe("Beta#2\topen\tSecond line\t-\n");
  expect(await ok(["issues", "list", "Beta", "--all"])).toBe(
    "Beta#1\tclosed\tLint plan refs\tAlpha/001\nBeta#2\topen\tSecond line\t-\n",
  );

  expect(await ok(["issues", "show", "Beta#1"])).toContain("\nclosed: already linted\n");

  const again = await skills(["issues", "close", "Beta#1", "twice"]);
  expect(again.code).toBe(1);
  expect(again.stderr).toBe("issues close: Beta#1 is already closed\n");

  const unknown = await skills(["issues", "show", "Beta#9"]);
  expect(unknown.code).toBe(1);
  expect(unknown.stderr).toBe("issues show: no issue Beta#9\n");

  expect((await skills(["issues", "show", "Beta/001"])).code).toBe(2);
  expect((await skills(["issues", "list", "Nowhere"])).code).toBe(1);
});
