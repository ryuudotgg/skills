import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const sourceSkills = resolve(import.meta.dir, "../../skills");
const stub = resolve(import.meta.dir, "../../scripts/stubs/gh");

const branch = "feat/scope";
const fresh = "feat: retitle open PRs";
const view = ["pr", "view", "7", "--json", "state,isCrossRepository,headRefName,title,commits"];

describe("pr retitle CLI", () => {
  let temporary: string;
  let repo: string;
  let fixtures: string;
  let log: string;
  let env: NodeJS.ProcessEnv;

  async function fixture(args: readonly string[], output = "", code = 0): Promise<void> {
    const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
    await writeFile(join(fixtures, key), output);
    await writeFile(join(fixtures, `${key}.exit`), `${code}\n`);
  }

  async function pr(fields: Record<string, unknown> = {}): Promise<void> {
    await fixture(
      view,
      JSON.stringify({
        state: "OPEN",
        isCrossRepository: false,
        headRefName: branch,
        title: "feat: old scope",
        commits: [{ messageHeadline: "feat: old scope" }, { messageHeadline: "fix: new scope" }],
        ...fields,
      }),
    );
  }

  async function edits(): Promise<string[]> {
    return (await readFile(log, "utf8")).split("\n").filter((call) => call.startsWith("pr edit "));
  }

  async function retitle(args: readonly string[] = ["7", fresh]) {
    return runCommand([bin, "--root", sourceSkills, "pr", "retitle", ...args], {
      cwd: repo,
      env,
      timeout: 60_000,
    });
  }

  async function refuse(reason: string, args?: readonly string[]): Promise<void> {
    const result = await retitle(args);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toEndWith(`pr retitle: ${reason}\n`);
    expect(await edits()).toEqual([]);
  }

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), "skills-retitle-")));
    repo = join(temporary, "repo");
    fixtures = join(temporary, "gh");
    log = join(temporary, "gh.log");

    const testBin = join(temporary, "bin");
    env = {
      ...suiteEnvironment(),
      PATH: `${testBin}:${process.env.PATH ?? ""}`,
      GH_STUB_DIR: fixtures,
      GH_STUB_LOG: log,
      PLANS_DIR: join(temporary, "plans"),
      SKILLS_CONF: join(temporary, "skills.conf"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
    };

    await mkdir(fixtures);
    await mkdir(testBin);
    await symlink(stub, join(testBin, "gh"));
    await writeFile(log, "");
    await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=prs\n");

    await fixtureGit(temporary, ["init", "--quiet", "-b", "main", repo]);
    await fixtureGit(repo, ["config", `branch.${branch}.skills-owned`, "true"]);
    await pr();
    await fixture(["pr", "edit", "7", "--title", fresh], "https://github.com/test/repo/pull/7\n");
  });

  afterEach(async () => {
    await removeTemporary(temporary);
  });

  test("retitles an owned open PR", async () => {
    const result = await retitle();
    expect([result.code, result.stdout]).toEqual([0, "#7 retitled\n"]);
    expect(await edits()).toEqual([`pr edit 7 --title ${fresh}`]);
  });

  test("a branch with a plans row is owned without the publish mark", async () => {
    await fixtureGit(repo, ["config", "--unset", `branch.${branch}.skills-owned`]);
    await mkdir(join(temporary, "plans", "repo"), { recursive: true });
    await writeFile(
      join(temporary, "plans", "repo", "index.tsv"),
      `id\ta\tb\tc\td\te\tf\tbranch\n1\t-\t-\t-\t-\t-\t-\t${branch}\n`,
    );

    const result = await retitle();
    expect([result.code, result.stdout]).toEqual([0, "#7 retitled\n"]);
  });

  test("leaves a PR that already has the title alone", async () => {
    await pr({ title: fresh });

    const result = await retitle();
    expect([result.code, result.stdout]).toEqual([0, "#7 unchanged\n"]);
    expect(await edits()).toEqual([]);
  });

  test("keeps a one commit PR on its commit message", async () => {
    await pr({ commits: [{ messageHeadline: "fix: only commit" }] });
    await refuse("#7 has one commit, so its title stays that commit's message: fix: only commit");

    await fixture(["pr", "edit", "7", "--title", "fix: only commit"]);

    const result = await retitle(["7", "fix: only commit"]);
    expect([result.code, result.stdout]).toEqual([0, "#7 retitled\n"]);
  });

  test("refuses a title the commit rules reject", async () => {
    await refuse("no Conventional prefix", ["7", "Retitle open PRs"]);
    await refuse("longer than 50 characters", ["7", `feat: ${"x".repeat(45)}`]);
  });

  test("refuses outside prs delivery", async () => {
    await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");
    await refuse("delivery mode is not prs");
  });

  test("refuses a branch that is not owned", async () => {
    await fixtureGit(repo, ["config", "--unset", `branch.${branch}.skills-owned`]);
    await refuse(`${branch} is not an owned branch`);
  });

  test("refuses a closed PR and a fork's PR", async () => {
    await pr({ state: "MERGED" });
    await refuse("#7 is merged");

    await pr({ isCrossRepository: true });
    await refuse("#7 comes from another repository");
  });

  test("refuses an unreadable PR", async () => {
    await fixture(view, "", 1);
    await refuse("cannot read PR #7");

    await fixture(view, "{}");
    await refuse("cannot read PR #7");
  });

  test("reports a failed edit", async () => {
    await fixture(["pr", "edit", "7", "--title", fresh], "", 1);

    const result = await retitle();
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toEndWith("pr retitle: gh pr edit failed\n");
  });

  test("rejects malformed arguments", async () => {
    for (const args of [[], ["7"], ["#7", fresh], ["7", fresh, "extra"]]) {
      const result = await retitle(args);
      expect([result.code, result.stdout]).toEqual([2, ""]);
      expect(result.stderr).toBe('usage: skills pr retitle <n> "<title>"\n');
    }
  });
});
