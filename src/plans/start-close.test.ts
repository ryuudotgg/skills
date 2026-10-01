import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { today } from "./index-tsv.ts";
import { QUERY } from "./stack-verbs.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const sourceSkills = resolve(import.meta.dir, "../../skills");
const stubBin = resolve(import.meta.dir, "../../scripts/stubs");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
const temporary: string[] = [];

type Fixture = {
  directory: string;
  repo: string;
  root: string;
  index: string;
  plan: string;
  destination: string;
  log: string;
  env: NodeJS.ProcessEnv;
};

function row(id: string, slug: string, status: string, blockedBy: string, branch: string): string {
  return [id, slug, status, "P1", "S", blockedBy, "-", branch, "2026-09-26", "-"].join("\t");
}

function blockerArgs(branch: string): string[] {
  return [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--json",
    "state,mergeCommit",
    "--jq",
    '.[] | [.state, .mergeCommit.oid // "-"] | join(" ")',
  ];
}

function belowArgs(): string[] {
  return [
    "pr",
    "list",
    "--head",
    "feat/a",
    "--state",
    "all",
    "--json",
    "number,state",
    "--jq",
    '.[] | "\\(.state) \\(.number)"',
  ];
}

async function ghFixture(
  tree: Fixture,
  args: readonly string[],
  output: string,
  prefix = false,
): Promise<void> {
  const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
  const path = join(tree.directory, "gh", `${key}${prefix ? ".prefix" : ""}`);
  await writeFile(path, output);
  await writeFile(`${path}.exit`, "0\n");
}

async function reviewThreads(tree: Fixture, unresolved: boolean): Promise<void> {
  const nodes = unresolved
    ? [
        {
          isResolved: false,
          comments: {
            nodes: [
              {
                url: "https://github.com/o/r/pull/1#discussion_r11",
                author: { login: "greptile-apps" },
              },
            ],
          },
        },
      ]
    : [];

  const output = JSON.stringify({
    data: { repository: { pullRequest: { reviewThreads: { nodes } } } },
  });

  await ghFixture(
    tree,
    ["api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", "number=1", "-F"],
    output,
    true,
  );
}

async function createFixture(mode: "prs" | "hands-off" = "prs"): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), "skills-start-close-"));
  temporary.push(directory);

  const repo = join(directory, "fixture");
  const root = join(directory, "skills");
  const plans = join(directory, "plans");
  const tree: Fixture = {
    directory,
    repo,
    root,
    index: join(plans, "fixture/index.tsv"),
    plan: join(plans, "fixture/2-new.md"),
    destination: join(plans, "fixture/done/2-new.md"),
    log: join(plans, "log.tsv"),
    env: {
      ...suiteEnvironment(),
      PATH: `${stubBin}:${process.env.PATH ?? ""}`,
      PLANS_DIR: plans,
      SKILLS_CONF: join(directory, "skills.conf"),
      GH_STUB_DIR: join(directory, "gh"),
      GH_STUB_LOG: join(directory, "gh.log"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  };

  await mkdir(join(directory, "gh"));
  await mkdir(join(root, "playbook/scripts"), { recursive: true });
  await mkdir(join(root, "greptile"));

  await copyFile(
    join(sourceSkills, "playbook/scripts/reviewers.sh"),
    join(root, "playbook/scripts/reviewers.sh"),
  );

  await copyFile(
    join(sourceSkills, "greptile/reviewer.conf"),
    join(root, "greptile/reviewer.conf"),
  );

  await writeFile(tree.env.SKILLS_CONF ?? "", `DELIVERY=${mode}\n`);
  await writeFile(tree.env.GH_STUB_LOG ?? "", "");

  const origin = join(directory, "origin.git");
  await fixtureGit(directory, ["init", "--quiet", "--bare", "-b", "main", origin]);
  await fixtureGit(directory, ["init", "--quiet", "-b", "main", repo]);
  await fixtureGit(repo, ["remote", "add", "origin", origin]);

  await writeFixture(repo, "base", "base\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/a"]);
  await fixtureGit(repo, ["config", "branch.feat/a.skills-base", "origin/main"]);
  await writeFixture(repo, "a", "a\n");
  await commitFixture(repo);

  await fixtureGit(repo, ["checkout", "--quiet", "main"]);
  await fixtureGit(origin, ["fetch", "--quiet", repo, "+refs/heads/*:refs/heads/*"]);
  await fixtureGit(repo, ["fetch", "--quiet", "origin"]);

  await writeFixture(
    directory,
    "plans/fixture/index.tsv",
    `${[header, row("1", "a", "REVIEW", "-", "feat/a"), row("2", "new", "TODO", "1", "-")].join("\n")}\n`,
  );

  await ghFixture(tree, blockerArgs("feat/a"), "OPEN -");
  await ghFixture(tree, belowArgs(), "OPEN 1");
  await reviewThreads(tree, false);

  return tree;
}

async function plans(tree: Fixture, args: readonly string[]) {
  return runCommand([bin, "--root", tree.root, "plans", ...args], {
    cwd: tree.repo,
    env: tree.env,
    timeout: 60_000,
  });
}

async function logLines(tree: Fixture): Promise<string[]> {
  return (await readFile(tree.log, "utf8"))
    .trimEnd()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t").slice(1).join("\t"));
}

async function startState(tree: Fixture) {
  return {
    branch: await fixtureGit(tree.repo, ["branch", "--show-current"]),
    base: await fixtureGit(tree.repo, ["config", "branch.feat/new.skills-base"]),
    index: await readFile(tree.index, "utf8"),
    log: await logLines(tree),
  };
}

async function refuseStart(tree: Fixture, reason: string) {
  const index = await readFile(tree.index);
  const branch = await fixtureGit(tree.repo, ["branch", "--show-current"]);

  const result = await plans(tree, ["start", "fixture", "2"]);
  expect([result.code, result.stdout, result.timedOut]).toEqual([1, "", false]);
  expect(result.stderr).toContain(reason);

  expect(await fixtureGit(tree.repo, ["for-each-ref", "refs/heads/feat/new"])).toBe("");
  expect(await fixtureGit(tree.repo, ["branch", "--show-current"])).toBe(branch);
  expect(await readFile(tree.index)).toEqual(index);
  expect(existsSync(tree.log)).toBe(false);

  return result;
}

async function closeState(tree: Fixture) {
  return {
    index: await readFile(tree.index),
    files: await readdir(join(tree.directory, "plans/fixture"), { recursive: true }),
    source: existsSync(tree.plan) ? await readFile(tree.plan) : null,
    destination: existsSync(tree.destination) ? await readFile(tree.destination) : null,
    log: existsSync(tree.log) ? await readFile(tree.log) : null,
  };
}

afterEach(async () => {
  for (const directory of temporary) await removeTemporary(directory);
  temporary.length = 0;
});

describe("plans start", () => {
  test("test-start parity: matches the separate stack and row commands", async () => {
    const separate = await createFixture();
    const combined = await createFixture();

    const base = await plans(separate, ["stack-base", "fixture", "2"]);
    expect([base.code, base.stdout, base.stderr]).toEqual([0, "feat/a\n", ""]);

    const below = await plans(separate, ["below", "fixture", base.stdout.trimEnd()]);
    expect([below.code, below.stdout, below.stderr]).toEqual([0, "", ""]);

    const cut = await plans(separate, ["stack-base", "--cut", "fixture", "2"]);
    expect([cut.code, cut.stdout, cut.stderr]).toEqual([0, "feat/a\n", ""]);

    const updated = await plans(separate, ["set-row", "fixture", "2", "DOING", "feat/new"]);
    expect([updated.code, updated.stderr]).toEqual([0, ""]);

    const logged = await plans(separate, ["log", "fixture", "2", "start", "feat/new"]);
    expect([logged.code, logged.stdout, logged.stderr]).toEqual([0, "", ""]);

    const started = await plans(combined, ["start", "fixture", "2"]);
    expect([started.code, started.stdout, started.stderr]).toEqual([
      0,
      cut.stdout + updated.stdout,
      "",
    ]);

    expect(started.stdout.trimEnd().split("\n")).toHaveLength(2);

    const state = await startState(combined);
    expect(state).toEqual(await startState(separate));
    expect(state.branch).toBe("feat/new\n");
    expect(state.base).toBe("feat/a\n");
    expect(state.log).toEqual(["fixture\t2\tstart\tfeat/new"]);
  }, 20_000);

  test("test-start dirty: refuses an untracked file without changes", async () => {
    const tree = await createFixture();
    await writeFixture(tree.repo, "dirt");
    await refuseStart(tree, "working tree is dirty");
  });

  test("test-start two chains: refuses unrelated blockers without changes", async () => {
    const tree = await createFixture();
    await fixtureGit(tree.repo, ["checkout", "--quiet", "-b", "feat/b", "main"]);
    await writeFixture(tree.repo, "b", "b\n");
    await commitFixture(tree.repo);

    await fixtureGit(tree.repo, ["checkout", "--quiet", "main"]);

    await writeFile(
      tree.index,
      `${[header, row("1", "a", "REVIEW", "-", "feat/a"), row("2", "new", "TODO", "1,3", "-"), row("3", "b", "REVIEW", "-", "feat/b")].join("\n")}\n`,
    );

    await ghFixture(tree, blockerArgs("feat/b"), "OPEN -");

    await refuseStart(tree, "two chains");
  });

  test("test-start closed blocker: refuses a PR closed without merging", async () => {
    const tree = await createFixture();
    await ghFixture(tree, blockerArgs("feat/a"), "CLOSED -");
    await refuseStart(tree, "closed without merging");
  });

  test("test-start unresolved: prints the thread on stderr and refuses", async () => {
    const tree = await createFixture();
    await reviewThreads(tree, true);

    const result = await refuseStart(tree, "below: unresolved Greptile threads below the base");
    expect(result.stderr).toBe(
      "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r11\nbelow: unresolved Greptile threads below the base\n",
    );

    expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toContain(QUERY);
  });

  test("test-start raced blocker: refuses a blocker that turned DOING during the preflight", async () => {
    const tree = await createFixture();
    const wrapper = join(tree.directory, "racing");
    await mkdir(wrapper);
    await writeFile(
      join(wrapper, "gh"),
      `#!/bin/sh\ncase "$*" in\n  "api graphql"*) sed -i.bak 's/^1\\ta\\tREVIEW/1\\ta\\tDOING/' "${tree.index}" && rm -f "${tree.index}.bak" ;;\nesac\nexec "${stubBin}/gh" "$@"\n`,
    );

    await chmod(join(wrapper, "gh"), 0o755);
    tree.env = { ...tree.env, PATH: `${wrapper}:${tree.env.PATH ?? ""}` };

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("blocker 1 is DOING");

    expect(await fixtureGit(tree.repo, ["for-each-ref", "refs/heads/feat/new"])).toBe("");
    expect(await readFile(tree.index, "utf8")).toContain("2\tnew\tTODO\t");
    expect(existsSync(tree.log)).toBe(false);
  });

  test("test-start hands-off: skips the unresolved thread preflight", async () => {
    const tree = await createFixture("hands-off");
    await reviewThreads(tree, true);

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);

    const state = await startState(tree);
    expect(state.branch).toBe("feat/new\n");
    expect(state.base).toBe("feat/a\n");
    expect(state.index).toContain("2\tnew\tDOING\tP1\tS\t1\t-\tfeat/new\t");

    expect(result.stdout).toBe(`feat/a\n${state.index.trimEnd().split("\n")[2]}\n`);
    expect(state.log).toEqual(["fixture\t2\tstart\tfeat/new"]);
    expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toBe(
      `${blockerArgs("feat/a").join(" ")}\n`,
    );
  });
});

describe("plans close", () => {
  test.each(["DONE", "DROPPED"])(
    "test-close %s: closes once and reruns without writes",
    async (status) => {
      const tree = await createFixture();
      const content = "# New\n\n## Landed\n\nShipped.\n";
      const note = "Shipped the new command";
      await writeFile(tree.plan, content);

      const result = await plans(tree, ["close", "fixture", "2", status, note]);
      expect([result.code, result.stderr]).toEqual([0, ""]);

      const index = await readFile(tree.index, "utf8");
      const updated = index.trimEnd().split("\n")[2] ?? "";
      expect(result.stdout).toBe(`${updated}\n`);
      expect(updated.split("\t")).toEqual([
        "2",
        "new",
        status,
        "P1",
        "S",
        "1",
        "-",
        "-",
        today(),
        note,
      ]);

      expect(existsSync(tree.plan)).toBe(false);
      expect(await readFile(tree.destination, "utf8")).toBe(content);
      expect(await logLines(tree)).toEqual([`fixture\t2\tdone\t${note}`]);

      const before = await closeState(tree);
      const repeated = await plans(tree, ["close", "fixture", "2", status, note]);
      expect([repeated.code, repeated.stdout, repeated.stderr]).toEqual([
        0,
        "2 is already closed\n",
        "",
      ]);

      expect(await closeState(tree)).toEqual(before);
    },
  );

  test("test-close no Landed: refuses without changing files or the log", async () => {
    const tree = await createFixture();
    await writeFile(tree.plan, "# New\n\nStill working.\n");
    const before = await closeState(tree);

    const result = await plans(tree, ["close", "fixture", "2", "DONE", "Shipped"]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("write the Landed section first (## Landed)");
    expect(await closeState(tree)).toEqual(before);
  });

  test("test-close partial: moves the remaining file and appends the missing log", async () => {
    const tree = await createFixture();
    const content = "# New\n\n## Landed\n\nShipped.\n";
    const note = "Shipped the new command";
    await writeFile(tree.plan, content);

    const updated = await plans(tree, ["set-row", "fixture", "2", "DONE", "-", note]);
    expect(updated.code).toBe(0);

    const index = await readFile(tree.index);

    const result = await plans(tree, ["close", "fixture", "2", "DONE", note]);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, updated.stdout, ""]);
    expect(await readFile(tree.index)).toEqual(index);

    expect(existsSync(tree.plan)).toBe(false);
    expect(await readFile(tree.destination, "utf8")).toBe(content);
    expect(await logLines(tree)).toEqual([`fixture\t2\tdone\t${note}`]);

    const before = await closeState(tree);
    const repeated = await plans(tree, ["close", "fixture", "2", "DONE", note]);
    expect([repeated.code, repeated.stdout, repeated.stderr]).toEqual([
      0,
      "2 is already closed\n",
      "",
    ]);

    expect(await closeState(tree)).toEqual(before);
  });

  test.each([{ args: ["fixture", "2", "TODO", "Shipped"] }, { args: ["fixture", "2", "DONE"] }])(
    "test-close bad args: %j",
    async ({ args }) => {
      const tree = await createFixture();
      await writeFile(tree.plan, "# New\n\n## Landed\n\nShipped.\n");
      const before = await closeState(tree);

      const result = await plans(tree, ["close", ...args]);
      expect([result.code, result.stdout, result.stderr]).toEqual([
        2,
        "",
        "usage: skills plans close <Project> <id> <DONE|DROPPED> <note>\n",
      ]);

      expect(await closeState(tree)).toEqual(before);
    },
  );
});
