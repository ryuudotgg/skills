import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { today } from "./index-tsv.ts";
import { QUERY } from "./stack-verbs.ts";
import type { Io } from "../io.ts";
import { fakeReader, failedCheck, pendingCheck, type FakeReaderOptions } from "../pr/fakes.ts";
import { WatcherQueryError } from "../pr/github.ts";
import { readIndex } from "./index-tsv.ts";
import { setRowVerb } from "./verbs.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const sourceSkills = resolve(import.meta.dir, "../../skills");
const stubBin = resolve(import.meta.dir, "../../scripts/stubs");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";
const temporary: string[] = [];

const setRowUsage = "skills plans set-row <Project> <id> <STATUS> [branch|-] [note|-]";

async function handoffPr(tree: Fixture, state = "OPEN", branch = "feat/new"): Promise<void> {
  await ghFixture(
    tree,
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state"],
    JSON.stringify([{ number: 2, state }]),
  );
}

function setRowHarness(tree: Fixture, options: FakeReaderOptions = {}) {
  let now = 0;
  const sleeps: number[] = [];
  const clock = {
    now: () => now,
    observedAt: () => "2026-10-03T00:00:00Z",
    async sleep(seconds: number) {
      sleeps.push(seconds);
      now += seconds;
    },
  };

  const stdout: string[] = [];
  const stderr: string[] = [];
  const reader = fakeReader(options);
  const io: Io = {
    cwd: tree.repo,
    env: tree.env,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    capture: true,
  };

  const run = (args: readonly string[]) =>
    setRowVerb(args, setRowUsage, tree.root, io, () => reader, clock);

  return { run, reader, stdout, stderr, io, clock, sleeps };
}

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
      TZ: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
  await mkdir(join(root, "greptile"), { recursive: true });

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

describe("set-row REVIEW gate", () => {
  test("hands-off REVIEW and prs TODO or DOING make no gh call", async () => {
    for (const [mode, status] of [
      ["hands-off", "REVIEW"],
      ["prs", "TODO"],
      ["prs", "DOING"],
    ] as const) {
      const tree = await createFixture(mode);
      const run = setRowHarness(tree);

      expect(await run.run(["fixture", "2", status])).toBe(0);
      expect(readIndex(tree.index).find((entry) => entry.id === "2")?.status).toBe(status);
      expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toBe("");
      expect(run.reader.calls).toEqual([]);
    }
  });

  test("failing, conflicting and pending PRs leave the index bytes unchanged", async () => {
    for (const [options, finding] of [
      [
        { checks: [{ ...failedCheck("Test"), link: "https://ci.test/2" }] },
        "#2 failing Test https://ci.test/2",
      ],
      [{ facts: { mergeable: "CONFLICTING" } }, "#2 conflicting CONFLICTING CLEAN"],
      [{ facts: { mergeStateStatus: "BEHIND" } }, "#2 conflicting MERGEABLE BEHIND"],
      [{ checks: [pendingCheck("Test")] }, "#2 pending Test"],
    ] as const) {
      const tree = await createFixture();
      await handoffPr(tree);

      const before = await readFile(tree.index);
      const run = setRowHarness(tree, options);
      expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(1);
      expect(await readFile(tree.index)).toEqual(before);
      expect(run.stdout).toEqual([]);
      expect(run.stderr.join("")).toBe(
        `${finding}\nset-row: 2 stays TODO: #2 is not green and mergeable. Wait with skills pr green 2, fix what it names, then set REVIEW again.\n`,
      );

      expect(run.reader.calls).toEqual([
        "currentPr",
        ...Array(options.checks?.[0]?.kind === "pending" ? 7 : 1).fill("read"),
      ]);

      expect(existsSync(join(tree.directory, "plans/fixture/.index.tsv.lock"))).toBe(false);
    }
  });

  test("a green PR writes REVIEW and uses the supplied branch", async () => {
    const tree = await createFixture();
    await handoffPr(tree);

    const run = setRowHarness(tree);
    expect(await run.run(["fixture", "2", "REVIEW", "feat/new", "ready"])).toBe(0);
    expect(readIndex(tree.index).find((entry) => entry.id === "2")).toMatchObject({
      status: "REVIEW",
      branch: "feat/new",
      note: "ready",
    });

    expect(run.reader.calls).toEqual(["currentPr", "read", "read"]);
    expect(run.sleeps).toEqual([30]);
    expect(run.stderr.join("")).toBe("");
  });

  test("omitted or dash branch checks the row's current branch", async () => {
    for (const branch of [[], ["-"]] as const) {
      const tree = await createFixture();
      await handoffPr(tree, "OPEN", "feat/a");

      const run = setRowHarness(tree);
      expect(await run.run(["fixture", "1", "REVIEW", ...branch])).toBe(0);
      expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toContain(
        "pr list --head feat/a --state all --json number,state",
      );

      expect(readIndex(tree.index).find((entry) => entry.id === "1")?.branch).toBe("feat/a");
    }
  });

  test("merged list entries pass without reading and an open read can report merged", async () => {
    for (const state of ["MERGED", "OPEN"] as const) {
      const tree = await createFixture();
      await handoffPr(tree, state);

      const run = setRowHarness(tree, { facts: { state: "MERGED" } });
      expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(0);
      expect(readIndex(tree.index).find((entry) => entry.id === "2")?.status).toBe("REVIEW");
      expect(run.reader.calls).toEqual(state === "MERGED" ? [] : ["currentPr", "read", "read"]);
    }
  });

  test("an open PR is checked even when a merged PR also exists", async () => {
    const tree = await createFixture();
    await ghFixture(
      tree,
      ["pr", "list", "--head", "feat/new", "--state", "all", "--json", "number,state"],
      JSON.stringify([
        { number: 1, state: "MERGED" },
        { number: 2, state: "OPEN" },
      ]),
    );

    const before = await readFile(tree.index);
    const run = setRowHarness(tree, { checks: [failedCheck()] });
    expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(1);
    expect(await readFile(tree.index)).toEqual(before);
  });

  test("no PR or only closed PRs refuse without writing", async () => {
    for (const output of ["[]", '[{"number":2,"state":"CLOSED"}]']) {
      const tree = await createFixture();
      await ghFixture(
        tree,
        ["pr", "list", "--head", "feat/new", "--state", "all", "--json", "number,state"],
        output,
      );

      const before = await readFile(tree.index);
      const run = setRowHarness(tree);

      expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(1);
      expect(run.stderr.join("")).toContain("no open or merged PR for feat/new");
      expect(await readFile(tree.index)).toEqual(before);
      expect(run.reader.calls).toEqual([]);
    }
  });

  test("missing branches and unknown ids refuse before gh or locking", async () => {
    const tree = await createFixture();
    const before = await readFile(tree.index);
    const run = setRowHarness(tree);

    expect(await run.run(["fixture", "2", "REVIEW"])).toBe(1);
    expect(run.stderr.join("")).toContain("row 2 has no branch, so no PR to check");

    expect(await run.run(["fixture", "missing", "REVIEW", "feat/new"])).toBe(1);
    expect(run.stderr.join("")).toContain("id not found: missing");
    expect(await readFile(tree.index)).toEqual(before);
    expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toBe("");
  });

  test("a checkout mismatch refuses without a gh call", async () => {
    const tree = await createFixture();
    const before = await readFile(tree.index);
    const run = setRowHarness(tree);
    run.io.cwd = tree.directory;

    expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(1);
    expect(run.stderr.join("")).toContain("not a checkout of fixture");
    expect(await readFile(tree.index)).toEqual(before);
    expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toBe("");
  });

  test("failed and malformed gh responses fail closed", async () => {
    for (const output of [undefined, "not json", "{}", '[{"number":"2","state":"OPEN"}]']) {
      const tree = await createFixture();
      if (output !== undefined)
        await ghFixture(
          tree,
          ["pr", "list", "--head", "feat/new", "--state", "all", "--json", "number,state"],
          output,
        );

      const before = await readFile(tree.index);
      const run = setRowHarness(tree);

      expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(1);
      expect(run.stderr.join("")).toContain("cannot");
      expect(await readFile(tree.index)).toEqual(before);
      expect(run.reader.calls).toEqual([]);
    }
  });

  test("missing gh refuses without writing", async () => {
    const tree = await createFixture();
    const path = join(tree.directory, "only-git");
    await mkdir(path);
    await symlink(Bun.which("git")!, join(path, "git"));

    const before = await readFile(tree.index);
    const run = setRowHarness(tree);
    run.io.env = { ...tree.env, PATH: path };

    expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(1);
    expect(run.stderr.join("")).toContain("gh not found, cannot check PR");
    expect(await readFile(tree.index)).toEqual(before);
    expect(run.reader.calls).toEqual([]);
  });

  test("an unreadable open PR refuses with the green command's lines", async () => {
    const tree = await createFixture();
    await handoffPr(tree);

    const before = await readFile(tree.index);
    const run = setRowHarness(tree);
    const reader = {
      ...run.reader,
      async read() {
        throw new WatcherQueryError({
          kind: "checks-unavailable",
          retryable: true,
          detail: "offline",
        });
      },
    };

    expect(
      await setRowVerb(
        ["fixture", "2", "REVIEW", "feat/new"],
        setRowUsage,
        tree.root,
        run.io,
        () => reader,
        run.clock,
      ),
    ).toBe(1);

    expect(run.stderr.join("")).toContain("#2 unreadable offline\nset-row: 2 stays TODO:");
    expect(await readFile(tree.index)).toEqual(before);
  });

  test("an unchecked head passes only after its 120 second window and confirmation", async () => {
    const tree = await createFixture();
    await handoffPr(tree);
    const run = setRowHarness(tree, { checks: [] });

    expect(await run.run(["fixture", "2", "REVIEW", "feat/new"])).toBe(0);
    expect(run.sleeps).toEqual([30, 30, 30, 30, 30]);
    expect(readIndex(tree.index).find((entry) => entry.id === "2")?.status).toBe("REVIEW");
  });

  test("a late unchecked head is refused before its 120 second window", async () => {
    const tree = await createFixture();
    await handoffPr(tree);
    const before = await readFile(tree.index);
    const run = setRowHarness(tree);
    const base = fakeReader({ checks: [] });
    const reader = {
      ...base,
      async read(context: Parameters<typeof base.read>[0]) {
        const result = await base.read(context);
        return {
          ...result,
          facts: { ...result.facts, headRefOid: run.clock.now() < 90 ? "head" : "newhead" },
        };
      },
    };

    expect(
      await setRowVerb(
        ["fixture", "2", "REVIEW", "feat/new"],
        setRowUsage,
        tree.root,
        run.io,
        () => reader,
        run.clock,
      ),
    ).toBe(1);

    expect(run.stderr.join("")).toContain("#2 no checks yet on newhead\nset-row: 2 stays TODO:");
    expect(await readFile(tree.index)).toEqual(before);
  });

  test("a failing confirmation leaves REVIEW unwritten", async () => {
    const tree = await createFixture();
    await handoffPr(tree);
    const run = setRowHarness(tree);
    const before = await readFile(tree.index);
    let reads = 0;
    const reader = {
      ...run.reader,
      async read(context: Parameters<typeof run.reader.read>[0]) {
        return fakeReader({ checks: reads++ === 0 ? undefined : [failedCheck("Test")] }).read(
          context,
        );
      },
    };

    expect(
      await setRowVerb(
        ["fixture", "2", "REVIEW", "feat/new"],
        setRowUsage,
        tree.root,
        run.io,
        () => reader,
        run.clock,
      ),
    ).toBe(1);

    expect(run.sleeps).toEqual([30]);
    expect(run.stderr.join("")).toContain("#2 failing Test -");
    expect(await readFile(tree.index)).toEqual(before);
  });

  test("the registered verb uses its root, checkout and environment for the reader", async () => {
    const tree = await createFixture();
    await handoffPr(tree);
    await ghFixture(
      tree,
      ["pr", "view", "2", "--json", "number,url"],
      JSON.stringify({ number: 2, url: "https://github.com/owner/repo/pull/2" }),
    );

    await ghFixture(
      tree,
      ["api", "graphql"],
      JSON.stringify({
        data: {
          repository: {
            pullRequest: {
              state: "OPEN",
              mergedAt: null,
              isDraft: false,
              mergeable: "MERGEABLE",
              mergeStateStatus: "CLEAN",
              reviewDecision: "APPROVED",
              headRefOid: "head",
              headRefName: "feat/new",
              baseRefName: "main",
              commits: {
                nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS" } } }],
              },
              head: {
                nodes: [
                  {
                    commit: {
                      oid: "head",
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: "StatusContext",
                              context: "ci",
                              state: "SUCCESS",
                              description: "",
                              targetUrl: "",
                            },
                          ],
                          pageInfo: { hasNextPage: false, endCursor: null },
                        },
                      },
                    },
                  },
                ],
              },
              reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
            },
          },
        },
      }),
      true,
    );

    const result = await plans(tree, ["set-row", "fixture", "2", "REVIEW", "feat/new"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(readIndex(tree.index).find((entry) => entry.id === "2")?.status).toBe("REVIEW");
    expect(await readFile(tree.env.GH_STUB_LOG ?? "", "utf8")).toContain("api graphql");
  }, 60_000);
});

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
    files: (await readdir(join(tree.directory, "plans/fixture"), { recursive: true })).sort(),
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

  test("test-start raced row: refuses a row closed between its checks and its write", async () => {
    const tree = await createFixture("hands-off");
    const wrapper = join(tree.directory, "closing");
    await mkdir(wrapper);
    await writeFile(
      join(wrapper, "gh"),
      `#!/bin/sh\ncase "$*" in\n  "pr list"*) sed -i.bak 's/^2\\tnew\\tTODO/2\\tnew\\tDONE/' "${tree.index}" && rm -f "${tree.index}.bak" ;;\nesac\nexec "${stubBin}/gh" "$@"\n`,
    );

    await chmod(join(wrapper, "gh"), 0o755);
    tree.env = { ...tree.env, PATH: `${wrapper}:${tree.env.PATH ?? ""}` };

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toBe(
      "start: row 2 changed since its checks (status TODO -> DONE), start again\n",
    );

    expect(await readFile(tree.index, "utf8")).toContain(`${row("2", "new", "DONE", "1", "-")}\n`);
    expect(existsSync(tree.log)).toBe(false);
  });

  test("test-start resume: finishes a start whose row and log writes never landed", async () => {
    const tree = await createFixture();
    const cut = await plans(tree, ["stack-base", "--cut", "fixture", "2"]);
    expect(cut.code).toBe(0);

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);

    const state = await startState(tree);
    expect(state.index).toContain("2\tnew\tDOING\tP1\tS\t1\t-\tfeat/new\t");
    expect(result.stdout).toBe(`feat/a\n${state.index.trimEnd().split("\n")[2]}\n`);
    expect(state.log).toEqual(["fixture\t2\tstart\tfeat/new"]);

    const again = await plans(tree, ["start", "fixture", "2"]);
    expect([again.code, again.stdout]).toEqual([0, result.stdout]);
    expect((await startState(tree)).log).toEqual(["fixture\t2\tstart\tfeat/new"]);
  });

  test("test-start resume preflight: refuses to adopt a cut branch over an unresolved thread", async () => {
    const tree = await createFixture();
    const cut = await plans(tree, ["stack-base", "--cut", "fixture", "2"]);
    expect(cut.code).toBe(0);

    await reviewThreads(tree, true);
    const index = await readFile(tree.index);

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("below: unresolved Greptile threads below the base");
    expect(await readFile(tree.index)).toEqual(index);
    expect(existsSync(tree.log)).toBe(false);
  });

  test("test-start resume dirty: refuses to adopt a cut branch holding uncommitted work", async () => {
    const tree = await createFixture();
    const cut = await plans(tree, ["stack-base", "--cut", "fixture", "2"]);
    expect(cut.code).toBe(0);

    await writeFixture(tree.repo, "dirt");
    const index = await readFile(tree.index);

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain("working tree is dirty");
    expect(await readFile(tree.index)).toEqual(index);
    expect(existsSync(tree.log)).toBe(false);
  });

  test("test-start resume moved base: names the recovery when the blocker merged before the retry", async () => {
    const tree = await createFixture();
    const cut = await plans(tree, ["stack-base", "--cut", "fixture", "2"]);
    expect(cut.code).toBe(0);

    const merged = (await fixtureGit(tree.repo, ["rev-parse", "origin/main"])).trimEnd();
    await ghFixture(tree, blockerArgs("feat/a"), `MERGED ${merged}`);
    const index = await readFile(tree.index);

    const result = await plans(tree, ["start", "fixture", "2"]);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain(
      "feat/new was cut from feat/a, but the base is now origin/main; delete feat/new and run plans start again",
    );

    expect(await readFile(tree.index)).toEqual(index);
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

  test("test-close retry: a corrected status and note replace a partial close", async () => {
    const tree = await createFixture();
    await writeFile(tree.plan, "# New\n\n## Landed\n\nShipped.\n");
    await plans(tree, ["set-row", "fixture", "2", "DONE", "-", "first note"]);

    const result = await plans(tree, ["close", "fixture", "2", "DROPPED", "second note"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout.split("\t").slice(2, 3)).toEqual(["DROPPED"]);
    expect(result.stdout.trimEnd().split("\t").at(-1)).toBe("second note");
    expect(await logLines(tree)).toEqual(["fixture\t2\tdone\tsecond note"]);
  });

  test("test-close reopened: a second close after a new start logs done again", async () => {
    const tree = await createFixture();
    await writeFile(tree.plan, "# New\n\n## Landed\n\nShipped.\n");
    await plans(tree, ["close", "fixture", "2", "DONE", "first"]);

    await plans(tree, ["set-row", "fixture", "2", "DOING"]);
    await plans(tree, ["log", "fixture", "2", "start", "feat/new"]);

    const result = await plans(tree, ["close", "fixture", "2", "DONE", "second"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(await logLines(tree)).toEqual([
      "fixture\t2\tdone\tfirst",
      "fixture\t2\tstart\tfeat/new",
      "fixture\t2\tdone\tsecond",
    ]);
  });

  test("test-close heading: accepts a Landed heading with trailing whitespace", async () => {
    const tree = await createFixture();
    await writeFile(tree.plan, "# New\n\n## Landed  \n\nShipped.\n");

    const result = await plans(tree, ["close", "fixture", "2", "DONE", "Shipped"]);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(existsSync(tree.destination)).toBe(true);
  });

  test("test-close long note: the row and the log keep the same 100 characters", async () => {
    const tree = await createFixture();
    await writeFile(tree.plan, "# New\n\n## Landed\n\nShipped.\n");
    const note = "x".repeat(130);

    const result = await plans(tree, ["close", "fixture", "2", "DONE", note]);
    expect(result.code).toBe(0);
    expect(result.stdout.trimEnd().split("\t").at(-1)).toBe("x".repeat(100));
    expect(await logLines(tree)).toEqual([`fixture\t2\tdone\t${"x".repeat(100)}`]);
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
