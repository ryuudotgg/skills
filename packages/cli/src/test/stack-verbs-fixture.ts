import { expect } from "bun:test";
import { copyFile, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { appendGhLog, ghFixture } from "../evals/gh-fake.ts";
import { prListArgs } from "../plans/prs.ts";
import { checkBelow, QUERY, stackBaseVerb } from "../plans/stack-verbs.ts";
import { appendFixture, prList } from "./fixtures.ts";
import { stackRepo, type StackCase, type StackVerb } from "./stack-fixture.ts";

export const sourceSkills = resolve(import.meta.dir, "../../../../skills");
export const stackBaseUsage = "skills plans stack-base [--cut] <Project> <id>";
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote";

type Thread = {
  isResolved: boolean;
  comments: { nodes: { url: string; author: { login: string } | null }[] };
};

export function thread(number: number, isResolved: boolean, login: string | null): Thread {
  return {
    isResolved,
    comments: {
      nodes: [
        {
          url: `https://github.com/o/r/pull/1#discussion_r${number}`,
          author: login === null ? null : { login },
        },
      ],
    },
  };
}

export function page(
  nodes: readonly Thread[],
  pageInfo?: { hasNextPage: boolean; endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      repository: { pullRequest: { reviewThreads: { nodes, ...(pageInfo ? { pageInfo } : {}) } } },
    },
  });
}

export function threadArgs(number: string, cursor?: string): string[] {
  return [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${number}`,
    ...(cursor ? ["-f", `after=${cursor}`] : []),
    "-F",
    `query=${QUERY}`,
  ];
}

export function row(
  id: string,
  slug: string,
  status: string,
  blockedBy: string,
  branch: string,
): string {
  return [id, slug, status, "P1", "S", blockedBy, "-", branch, "2026-09-26", "-"].join("\t");
}

export async function verbCase(testCase: StackCase) {
  const { temporary, env } = testCase;
  const root = join(temporary, "skills");
  const fixtures = env.GH_STUB_DIR!;
  const log = env.GH_STUB_LOG!;

  env.GIT_AUTHOR_NAME = "skills test";
  env.GIT_COMMITTER_NAME = "skills test";

  await mkdir(join(root, "greptile"), { recursive: true });
  await copyFile(
    join(sourceSkills, "greptile/reviewer.conf"),
    join(root, "greptile/reviewer.conf"),
  );

  async function fixture(
    args: readonly string[],
    output: string,
    code = 0,
    prefix = false,
  ): Promise<void> {
    const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
    const path = join(fixtures, `${key}${prefix ? ".prefix" : ""}`);
    await writeFile(path, output);
    await writeFile(`${path}.exit`, `${code}\n`);
  }

  async function threads(number: string, output: string, code = 0, cursor?: string): Promise<void> {
    await fixture(threadArgs(number, cursor).slice(0, -1), output, code, true);
  }

  async function calls(): Promise<string[]> {
    return (await readFile(log, "utf8")).trimEnd().split("\n").filter(Boolean);
  }

  async function rawGit(cwd: string, args: readonly string[]): Promise<string> {
    const result = await testCase.command(["git", ...args], cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  }

  return { temporary, env, root, fixtures, log, fixture, threads, calls, rawGit };
}

export async function belowCase(testCase: StackCase) {
  const common = await verbCase(testCase);
  const { root, fixtures, log } = common;
  const repository = await stackRepo(testCase, {
    name: "fixture",
    mode: "init",
    publish: "fetch",
    commits: [
      { branch: "main", message: "fixture", files: { base: "base\n" } },
      {
        branch: "feat/a",
        from: "main",
        base: "origin/main",
        message: "fixture",
        files: { a: "a\n" },
      },
      { branch: "feat/b", from: "feat/a", base: "feat/a", message: "fixture", files: { b: "b\n" } },
    ],
    checkout: "main",
    index: {
      project: "fixture",
      text: `${header}\n1\ta\tREVIEW\tP1\tS\t-\t-\tfeat/a\t2026-09-26\t-\n2\tb\tREVIEW\tP1\tS\t1\t-\tfeat/b\t2026-09-26\t-\n3\tnew\tTODO\tP1\tS\t2\t-\t-\t2026-09-26\t-\n`,
    },
  });

  const { repo, origin, run, command } = repository;

  await testCase.executable(
    join(origin, "hooks/post-receive"),
    '#!/bin/sh\nwhile read -r old new refname; do\n  printf "push %s\\n" "$refname" >> "$GH_STUB_LOG"\ndone\n',
  );

  const preflight: StackVerb = (args, io) =>
    checkBelow("fixture", args[0]!, root, io, async (args) => {
      appendGhLog(log, args);

      const result = ghFixture(fixtures, args);
      io.err(result.stderr.toString());

      return result.code === 0 ? result.stdout.toString() : undefined;
    });

  async function below(base = "feat/b", cwd = repo) {
    const { code, stdout, stderr } = await run(preflight, [base], cwd);
    return { code, stdout, stderr };
  }

  async function refusal(base: string, reason: string): Promise<void> {
    const result = await below(base);
    expect([result.code, result.stdout, result.stderr]).toEqual([1, "", `below: ${reason}\n`]);
  }

  return { ...common, repo, repository, command, run, below, refusal };
}

export async function baseCase(testCase: StackCase) {
  const common = await verbCase(testCase);
  const { temporary, env, root, fixture } = common;
  const rows = [
    row("100", "merged", "REVIEW", "-", "feat/merged"),
    row("101", "open", "REVIEW", "-", "feat/open"),
    row("102", "child", "REVIEW", "101", "feat/child"),
    row("103", "other", "REVIEW", "-", "feat/other"),
    row("104", "unstarted", "TODO", "-", "-"),
    row("105", "closed", "REVIEW", "-", "feat/closed"),
    row("106", "no-pr", "REVIEW", "-", "feat/nopr"),
    row("107", "dropped", "DROPPED", "-", "-"),
    row("108", "into-layer", "REVIEW", "-", "feat/into-layer"),
    row("109", "rebased", "REVIEW", "-", "feat/rebased"),
    row("110", "after-merged", "TODO", "100,107", "-"),
    row("111", "after-open", "TODO", "101", "-"),
    row("112", "after-child", "TODO", "101,102", "-"),
    row("113", "two-chains", "TODO", "101,103", "-"),
    row("114", "after-unstarted", "TODO", "104", "-"),
    row("115", "after-closed", "TODO", "105", "-"),
    row("116", "after-no-pr", "TODO", "106", "-"),
    row("117", "cut-me", "TODO", "101", "-"),
    row("118", "unblocked", "TODO", "-", "-"),
    row("119", "merged-and-stale", "TODO", "100,101", "-"),
    row("121", "merged-and-rebased", "TODO", "100,109", "-"),
    row("122", "after-layer-merge", "TODO", "108", "-"),
    row("123", "already-open", "REVIEW", "-", "feat/already-open"),
    row("124", "reused", "REVIEW", "-", "feat/reused"),
    row("125", "after-reused", "TODO", "124", "-"),
    row("126", "squashed-bottom", "REVIEW", "-", "feat/squashed-bottom"),
    row("127", "on-squashed", "REVIEW", "126", "feat/on-squashed"),
    row("128", "after-squash-stack", "TODO", "126,127", "-"),
    row("129", "after-layer-and-parent", "TODO", "101,102,108", "-"),
    row("132", "linked", "TODO", "-", "-"),
    row("133", "stacked-child", "REVIEW", "-", "feat/stacked-child"),
    row("134", "after-stacked-merge", "TODO", "133", "-"),
    row("135", "unread-child", "REVIEW", "-", "feat/unread-child"),
    row("136", "after-unread-parent", "TODO", "135", "-"),
    row("137", "unfetched-child", "REVIEW", "-", "feat/unfetched-child"),
    row("138", "after-unfetched-parent", "TODO", "137", "-"),
  ];

  const repository = await stackRepo(testCase, {
    name: "fixture",
    mode: "init",
    publish: "fetch",
    commits: [
      { branch: "main", message: "fixture" },
      { branch: "feat/open", from: "main", message: "feat/open" },
      { branch: "feat/child", from: "feat/open", message: "feat/child" },
      { branch: "feat/other", from: "main", message: "feat/other" },
      { branch: "main", message: "squash of feat/merged" },
      { branch: "feat/rebased", from: "main", message: "feat/rebased" },
      { branch: "feat/squashed-bottom", from: "main", message: "feat/squashed-bottom" },
      { branch: "feat/on-squashed", from: "feat/squashed-bottom", message: "feat/on-squashed" },
      { branch: "feat/reused", from: "main", message: "feat/reused" },
    ],
    checkout: "main",
    index: { project: "fixture", text: `${[header, ...rows].join("\n")}\n` },
  });

  const { repo, command, run } = repository;
  const mergeOid = repository.tips.main!;
  const childOid = repository.tips["feat/child"]!;
  for (const [branch, entries] of [
    ["feat/merged", [{ number: 1, state: "MERGED", oid: mergeOid }]],
    ["feat/into-layer", [{ number: 2, state: "MERGED", oid: childOid, base: "feat/child" }]],
    ["feat/open", [{ number: 3, state: "OPEN" }]],
    ["feat/child", [{ number: 4, state: "OPEN" }]],
    ["feat/other", [{ number: 5, state: "OPEN" }]],
    ["feat/rebased", [{ number: 6, state: "OPEN" }]],
    ["feat/closed", [{ number: 7, state: "CLOSED" }]],
    [
      "feat/reused",
      [
        { number: 8, state: "MERGED", oid: mergeOid },
        { number: 9, state: "OPEN" },
      ],
    ],
    ["feat/squashed-bottom", [{ number: 10, state: "MERGED", oid: mergeOid }]],
    ["feat/nopr", []],
    ["feat/on-squashed", [{ number: 11, state: "OPEN" }]],
    [
      "feat/stacked-child",
      [{ number: 12, state: "MERGED", oid: childOid, base: "feat/stacked-parent" }],
    ],
    [
      "feat/stacked-parent",
      [{ number: 13, state: "MERGED", oid: mergeOid, ended: "2026-10-03T00:00:00Z" }],
    ],
    [
      "feat/unread-child",
      [{ number: 14, state: "MERGED", oid: childOid, base: "feat/unread-parent" }],
    ],
    [
      "feat/unfetched-child",
      [{ number: 15, state: "MERGED", oid: childOid, base: "feat/unfetched-parent" }],
    ],
    [
      "feat/unfetched-parent",
      [{ number: 16, state: "MERGED", oid: childOid, ended: "2026-10-03T00:00:00Z" }],
    ],
  ] as const)
    await fixture(prListArgs(branch), prList(entries));

  await fixture(["api", "repos/{owner}/{repo}/compare/"], "ahead\n", 0, true);

  const verb: StackVerb = (args, io) => stackBaseVerb(args, stackBaseUsage, root, io);
  async function stackBase(id: string, cut = false, cwd = repo) {
    return run(verb, [...(cut ? ["--cut"] : []), "fixture", id], cwd);
  }

  async function refuseBase(id: string, reason: string): Promise<void> {
    const result = await stackBase(id);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toContain(reason);
  }

  async function doingRows(): Promise<void> {
    await appendFixture(
      temporary,
      "plans/fixture/index.tsv",
      `${[
        row("120", "busy", "DOING", "-", "feat/busy"),
        row("130", "held", "DOING", "-", "feat/held"),
        row("131", "after-held", "TODO", "130", "-"),
      ].join("\n")}\n`,
      testCase.views,
    );
  }

  async function withoutGh(): Promise<void> {
    const path = join(temporary, "nogh");
    await mkdir(path);

    for (const tool of [
      "sh",
      "git",
      "awk",
      "sed",
      "cut",
      "tr",
      "dirname",
      "basename",
      "cat",
      "bun",
    ]) {
      const executable = Bun.which(tool);
      if (!executable) throw new Error(`fixture tool not found: ${tool}`);
      await symlink(executable, join(path, tool));
    }

    env.PATH = path;
    expect(Bun.which("gh", { PATH: env.PATH })).toBeNull();
  }

  return { ...common, repo, repository, command, stackBase, refuseBase, doingRows, withoutGh };
}
