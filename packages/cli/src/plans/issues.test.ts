import { afterEach, beforeEach, expect, test } from "bun:test";
import { COLUMNS } from "skills-core";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, storedRows, viewText, writeFixture } from "../test/fixtures.ts";
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

async function refused(args: readonly string[], message: string): Promise<void> {
  const result = await skills(args);
  expect([result.code, result.stderr]).toEqual([1, `${message}\n`]);
}

async function row(project: string, id: string) {
  const rows = await storedRows(join(plans, project, "index.tsv"));
  return rows.find((entry) => entry.id === id);
}

async function landed(project: string, name: string): Promise<void> {
  const [id = "", slug = ""] = name.split(/-(.*)/);
  await writeFixture(
    plans,
    `${project}/${name}.md`,
    `# ${id} ${slug}\n\n## Landed\n\nBranch feat/${slug}, not merged yet.\nShipped.\n`,
  );
}

test("--blocks holds the row on the issue, a resolving close releases it and logs only done", async () => {
  const trail = trailLines();
  expect(
    await ok([
      "issues",
      "file",
      "Beta",
      "Lint plan refs",
      "--from",
      "Alpha/001",
      "--blocks",
      "Alpha/002",
    ]),
  ).toBe("Beta#1\n");

  expect(await ok(["plans", "frontier", "Alpha"])).toContain("waits on Beta#1\n");
  expect((await row("Alpha", "002"))?.blocked_by).toBe("Beta#1");
  expect(await ok(["plans", "frontier", "Beta"])).toEndWith(
    "\n\nINBOX 1\nBeta#1 Lint plan refs from Alpha/001\n",
  );

  expect(
    await ok(["plans", "add", "Beta", "lint-refs", "P3", "XS", "-", "-", "--resolves", "Beta#1"]),
  ).toStartWith("003\tlint-refs\tTODO\t");

  expect(await ok(["issues", "show", "Beta#1"])).toMatch(
    /\nopen\nblocks Alpha\/002\nresolves Beta\/003\n\n$/,
  );

  expect(trailLines()).toBe(trail);

  await landed("Beta", "003-lint-refs");
  await ok(["plans", "set-row", "Alpha", "002", "BLOCKED", "feat/two", "waits on Beta"]);
  await ok(["plans", "close", "Beta", "003", "DONE", "linted", "--sha", "0123abc"]);

  expect(await ok(["issues", "list", "Beta"])).toBe("");
  expect(await ok(["issues", "show", "Beta#1"])).toContain("\nclosed: resolved by Beta/003\n");
  expect(await row("Alpha", "002")).toMatchObject({
    status: "TODO",
    branch: "feat/two",
    note: "unblocked by Beta#1",
  });

  expect(await ok(["plans", "frontier", "Alpha"])).toStartWith("READY 2\n");
  expect(await ok(["plans", "frontier", "Beta"])).not.toContain("INBOX");
  expect(readFileSync(join(plans, "log.tsv"), "utf8").split("\n").slice(1, -1)).toEqual([
    expect.stringMatching(/\tBeta\t003\tdone\tlinted$/),
  ]);

  expect(await ok(["plans", "import"])).toBe("imported 0 rows, 0 events, 0 files\n");
});

test("a DROPPED close unlinks, resolving the issue when the other resolvers are DONE", async () => {
  await ok(["issues", "file", "Beta", "Two ways"]);
  await ok(["issues", "file", "Beta", "Dropped"]);
  await ok(["issues", "link", "Beta#1", "001"]);
  await ok(["issues", "link", "Beta#1", "002"]);
  expect(await ok(["issues", "link", "Beta#2", "002"])).toBe("Beta#2\topen\tDropped\t-\n");

  await landed("Beta", "001-one");
  await ok(["plans", "close", "Beta", "001", "DONE", "shipped", "--sha", "0123abc"]);
  expect(await ok(["issues", "show", "Beta#1"])).toContain("\nopen\n");

  await landed("Beta", "002-two");
  await ok(["plans", "close", "Beta", "002", "DROPPED", "not needed"]);

  expect(await ok(["issues", "show", "Beta#1"])).toMatch(
    /\nclosed: resolved by Beta\/001\nresolves Beta\/001\n\n$/,
  );

  expect(await ok(["issues", "show", "Beta#2"])).toMatch(/\nopen\n\n$/);
  await refused(["issues", "link", "Beta#1", "002"], "issues link: Beta#1 is closed");
  await refused(["issues", "link", "Beta#2", "002"], "issues link: Beta/002 is DROPPED");
});

test("a release waits for every blocker, read with the closing row already DONE", async () => {
  await ok(["issues", "file", "Beta", "Both"]);
  await ok(["plans", "add", "Alpha", "three", "P2", "S", "Beta/001,Beta#1", "-"]);
  await ok(["plans", "set-row", "Alpha", "003", "BLOCKED", "feat/three", "-"]);
  await ok(["issues", "link", "Beta#1", "001"]);
  expect(await ok(["issues", "show", "Beta#1"])).toContain(
    "\nblocks Alpha/003\nresolves Beta/001\n",
  );

  await landed("Beta", "001-one");
  await ok(["plans", "close", "Beta", "001", "DONE", "shipped", "--sha", "0123abc"]);

  expect(await row("Alpha", "003")).toMatchObject({ status: "TODO", note: "unblocked by Beta#1" });
});

test("a hand close releases a blocked row unless another blocker still holds it", async () => {
  await ok(["issues", "file", "Beta", "One", "--blocks", "Alpha/001"]);
  await ok(["issues", "file", "Beta", "Two", "--blocks", "Alpha/002"]);
  await ok(["plans", "set-row", "Alpha", "002", "BLOCKED", "feat/two", "held"]);
  await ok(["plans", "add", "Alpha", "three", "P2", "S", "001,Beta#2", "-"]);
  await ok(["plans", "set-row", "Alpha", "003", "BLOCKED", "feat/three", "held"]);

  expect(await ok(["issues", "close", "Beta#2", "won't fix"])).toBe("Beta#2\tclosed\tTwo\t-\n");

  expect(await row("Alpha", "002")).toMatchObject({ status: "TODO", note: "unblocked by Beta#2" });
  expect(await row("Alpha", "003")).toMatchObject({ status: "BLOCKED", note: "held" });
  expect((await row("Alpha", "001"))?.blocked_by).toBe("Beta#1");
});

test("links refuse before writing: a closed row, a foreign row, a plan that waits on its issue", async () => {
  await ok(["issues", "file", "Beta", "First"]);
  await ok(["plans", "set-row", "Alpha", "002", "DONE"]);

  await refused(
    ["issues", "file", "Beta", "Late", "--blocks", "Alpha/002"],
    "issues file: --blocks Alpha/002: the row is DONE",
  );

  await refused(
    ["issues", "file", "Beta", "Late", "--blocks", "Alpha/009"],
    "issues file: --blocks Alpha/009: Alpha has no row 009",
  );

  expect(await ok(["issues", "list", "Beta"])).toBe("Beta#1\topen\tFirst\t-\n");
  expect(await ok(["issues", "file", "Beta", "Next"])).toBe("Beta#2\n");

  await refused(
    ["plans", "add", "Alpha", "three", "P2", "S", "-", "-", "--resolves", "Beta#1"],
    "--resolves Beta#1: Beta#1 is in Beta, link a row of Beta",
  );

  await refused(
    ["plans", "add", "Beta", "three", "P2", "S", "Beta#1", "-", "--resolves", "Beta#1"],
    "--resolves Beta#1: Beta/003 waits on Beta#1, so it cannot resolve it",
  );

  await refused(
    ["plans", "add", "Beta", "three", "P2", "S", "Beta#9", "-"],
    "blocked_by Beta#9: no issue Beta#9",
  );

  await refused(["issues", "link", "Beta#9", "001"], "issues link: no issue Beta#9");
  await refused(["issues", "link", "Beta#1", "009"], "issues link: Beta has no row 009");
  expect((await skills(["issues", "link", "Beta#1", "1"])).code).toBe(2);
  expect(await row("Beta", "003")).toBeUndefined();
});

test("linking a plan that is already DONE resolves the issue at once", async () => {
  await ok(["issues", "file", "Beta", "Already"]);
  await landed("Beta", "001-one");
  await ok(["plans", "close", "Beta", "001", "DONE", "shipped", "--sha", "0123abc"]);

  expect(await ok(["issues", "link", "Beta#1", "001"])).toBe("Beta#1\tclosed\tAlready\t-\n");
  expect(await ok(["issues", "show", "Beta#1"])).toContain("\nclosed: resolved by Beta/001\n");
});

test("the session brief names a non empty inbox", async () => {
  const repo = join(temporary, "alpha");
  await fixtureGit(temporary, ["init", "-q", "-b", "main", repo]);
  await fixtureGit(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);

  const brief = async () => {
    const result = await runCommand([bin, "hook", "session-start"], {
      cwd: repo,
      env: {
        ...suiteEnvironment(),
        PLANS_DIR: plans,
        SKILLS_CONF: join(temporary, "skills.conf"),
        SKILLS_AUTO_UPDATE: "0",
      },
      timeout: 60_000,
    });

    return JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string;
  };

  expect(await brief()).not.toContain("Inbox:");
  await ok(["issues", "file", "Alpha", "Brief check"]);
  expect(await brief()).toEndWith("\nInbox: 1 open, run skills issues list Alpha");
});

test("relinking a resolver that went DONE outside close resolves the issue", async () => {
  await ok(["issues", "file", "Beta", "Late"]);
  await ok(["issues", "link", "Beta#1", "001"]);
  await ok(["plans", "set-row", "Beta", "001", "DONE"]);

  expect(await ok(["issues", "link", "Beta#1", "001"])).toBe("Beta#1\tclosed\tLate\t-\n");
});

test("a release reaches a project whose name holds a space", async () => {
  await writeFixture(plans, "My Project/index.tsv", `${header}\n`);
  await ok(["issues", "file", "Beta", "Spaced"]);
  await ok(["plans", "add", "My Project", "one", "P2", "S", "Beta#1", "-"]);
  await ok(["plans", "set-row", "My Project", "001", "BLOCKED", "feat/one", "held"]);

  await ok(["issues", "close", "Beta#1", "done by hand"]);
  expect(await row("My Project", "001")).toMatchObject({
    status: "TODO",
    note: "unblocked by Beta#1",
  });
});

test("a DROPPED close unlinks its resolver from an issue closed by hand", async () => {
  await ok(["issues", "file", "Beta", "Hand"]);
  await ok(["issues", "link", "Beta#1", "002"]);
  await ok(["issues", "close", "Beta#1", "by hand"]);
  await landed("Beta", "002-two");
  await ok(["plans", "close", "Beta", "002", "DROPPED", "not needed"]);

  expect(await ok(["issues", "show", "Beta#1"])).toMatch(/\nclosed: by hand\n\n$/);
  await refused(
    ["plans", "add", "Beta", "two", "P2", "S", "-", "-", "--resolves", "Beta#1"],
    "--resolves Beta#1: Beta#1 is closed",
  );
});

test("a refusal inside the write leaves no issue, and a plain filing writes no view", async () => {
  const alpha = await storedRows(join(plans, "Alpha", "index.tsv"));
  const edited = alpha.map((entry) => ({ ...entry, note: "edited by hand" }));
  const lines = edited.map((entry) => COLUMNS.map((column) => entry[column]).join("\t"));
  writeFileSync(join(plans, "Alpha", "index.tsv"), `${[header, ...lines].join("\n")}\n`);

  const blocked = await skills(["issues", "file", "Beta", "Held", "--blocks", "Alpha/002"]);
  expect(blocked.code).toBe(1);
  expect(blocked.stderr).toContain("changed outside the store");
  expect(await ok(["issues", "list", "--all"])).toBe("");

  await rm(join(plans, "Beta", "index.tsv"), { force: true });
  expect(await ok(["issues", "file", "Beta", "Quiet"])).toBe("Beta#1\n");
  expect(existsSync(join(plans, "Beta", "index.tsv"))).toBe(false);
});
