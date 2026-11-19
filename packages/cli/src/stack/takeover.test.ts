import { expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tryLock } from "../lock.ts";
import { writeFixture } from "../test/fixtures.ts";
import { runCommand } from "../test/process.ts";
import { faultGit, stackCase, type StackVerb } from "../test/stack-fixture.ts";
import { takeoverVerb } from "./takeover.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "../../../../skills");
const bin = join(root, "playbook/bin/skills");
const usage = "skills takeover <pr> [<sha>...] | --continue | --abort";
const takeover: StackVerb = (args, io) => takeoverVerb(args, usage, root, io);

const someone = {
  GIT_AUTHOR_NAME: "Someone Else",
  GIT_AUTHOR_EMAIL: "else@example.com",
  GIT_AUTHOR_DATE: "2026-11-16T10:00:00Z",
  GIT_COMMITTER_NAME: "Someone Else",
  GIT_COMMITTER_EMAIL: "else@example.com",
  GIT_COMMITTER_DATE: "2026-11-16T10:00:00Z",
};

const operator = {
  GIT_AUTHOR_NAME: "Operator",
  GIT_AUTHOR_EMAIL: "op@example.com",
  GIT_COMMITTER_NAME: "Operator",
  GIT_COMMITTER_EMAIL: "op@example.com",
};

const FIRST = "feat(theirs): write a\n";
const SECOND =
  "feat(takeover-scope): write b so this carried subject runs past the caps\n\nThe body says why b changes.\n\nCo-Authored-By: Third Person <third@example.com>\n";

type Pull = {
  author: string;
  head: string;
  headOid: string;
  commits: readonly string[];
  logins?: readonly (readonly string[])[];
};

async function takeoverCase(name: string, mine: Readonly<Record<string, string>> = { c: "c\n" }) {
  const fixture = await stackCase(`skills-takeover-${name}-`);
  Object.assign(fixture.env, operator);

  const origin = join(fixture.temporary, "origin.git");
  const seed = join(fixture.temporary, "seed");
  const repo = join(fixture.temporary, "repo");

  async function raw(args: readonly string[], cwd: string, env: object = {}): Promise<string> {
    const result = await runCommand(["git", ...args], {
      cwd,
      env: { ...fixture.env, ...env },
      timeout: 60_000,
    });

    expect(result.code, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result.stdout;
  }

  async function git(args: readonly string[], cwd: string, env: object = {}): Promise<string> {
    return (await raw(args, cwd, env)).trimEnd();
  }

  async function commit(
    cwd: string,
    files: Readonly<Record<string, string>>,
    message: string,
    env: object = {},
    options: readonly string[] = [],
  ) {
    for (const [path, content] of Object.entries(files)) await writeFixture(cwd, path, content);
    await git(["add", "--", ...Object.keys(files)], cwd);
    await writeFile(join(fixture.temporary, "message"), message);

    await git(
      [
        ...options,
        "commit",
        "--quiet",
        "--cleanup=verbatim",
        "-F",
        join(fixture.temporary, "message"),
      ],
      cwd,
      env,
    );

    return git(["rev-parse", "HEAD"], cwd);
  }

  await git(["init", "--quiet", "--bare", "-b", "main", origin], fixture.temporary);
  await git(["clone", "--quiet", origin, seed], fixture.temporary);
  await git(["config", "commit.gpgsign", "false"], seed);
  await commit(seed, { a: "base\n", b: "base\n" }, "chore: initial\n");
  await git(["push", "--quiet", "origin", "main"], seed);

  await git(["clone", "--quiet", origin, repo], fixture.temporary);
  await git(["config", "commit.gpgsign", "false"], repo);
  await git(["config", "user.name", "Operator"], repo);
  await git(["config", "user.email", "op@example.com"], repo);

  await git(["switch", "--quiet", "--no-track", "-c", "feat/mine", "origin/main"], repo);
  const tip = await commit(repo, mine, "feat: mine\n");

  await git(["switch", "--quiet", "-c", "feat/theirs"], seed);
  const first = await commit(seed, { a: "one\n" }, FIRST, someone);
  const second = await commit(seed, { b: "two\n" }, SECOND, someone);
  await git(["push", "--quiet", "origin", "feat/theirs", "feat/theirs:refs/pull/7/head"], seed);

  await git(["switch", "--quiet", "-c", "side", "main"], seed);
  await commit(seed, { e: "e\n" }, "feat(side): write e\n", someone);

  await git(["switch", "--quiet", "feat/theirs"], seed);
  await git(["merge", "--quiet", "--no-ff", "-m", "Merge side", "side"], seed, someone);
  const merge = await git(["rev-parse", "HEAD"], seed);
  await git(["push", "--quiet", "origin", "HEAD:refs/heads/feat/merged"], seed);

  await git(["switch", "--quiet", "-c", "feat/self", "main"], seed);
  const self = await commit(seed, { d: "d\n" }, "feat(self): write d\n", operator);
  await git(["tag", "v-self"], seed);
  await git(["push", "--quiet", "origin", "feat/self", "v-self"], seed);

  await git(["switch", "--quiet", "-c", "feat/empty", "main"], seed);
  await writeFixture(seed, "g", "g\n");
  await git(["add", "g"], seed);

  await git(["commit", "--quiet", "--allow-empty-message", "-m", ""], seed, someone);
  const empty = await git(["rev-parse", "HEAD"], seed);
  await git(["push", "--quiet", "origin", "feat/empty"], seed);

  await git(["switch", "--quiet", "-c", "feat/encoded", "main"], seed);
  const encoded = await commit(seed, { f: "f\n" }, "feat(enc): write f\n", someone, [
    "-c",
    "i18n.commitEncoding=ISO-8859-1",
  ]);

  await git(["push", "--quiet", "origin", "feat/encoded"], seed);

  async function answer(args: readonly string[], output: string): Promise<void> {
    const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
    await writeFile(join(fixture.temporary, "gh", key), output);
  }

  async function pull(number: number, spec: Pull): Promise<void> {
    await answer(
      ["pr", "view", String(number), "--json", "author,headRefName,headRefOid,commits"],
      JSON.stringify({
        author: { login: spec.author },
        headRefName: spec.head,
        headRefOid: spec.headOid,
        commits: spec.commits.map((oid, index) => ({
          oid,
          authors: (spec.logins?.[index] ?? ["someone-else"]).map((login) => ({
            login,
            email: `${login}@example.com`,
          })),
        })),
      }),
    );
  }

  await answer(["api", "user", "--jq", ".login"], "operator\n");
  await pull(7, {
    author: "someone-else",
    head: "feat/theirs",
    headOid: second,
    commits: [first, second],
  });

  async function refs(): Promise<string> {
    const listed = await git(["for-each-ref", "--format=%(refname) %(objectname)"], repo);
    return `${listed}\nHEAD ${await git(["symbolic-ref", "HEAD"], repo)} ${await git(["rev-parse", "HEAD"], repo)}`;
  }

  async function carried(sha: string, source: string): Promise<void> {
    const [mineText, sourceText] = await Promise.all([
      raw(["cat-file", "commit", sha], repo),
      raw(["cat-file", "commit", source], seed),
    ]);

    const shape = (text: string) => ({
      author: text.split("\n").find((line) => line.startsWith("author ")),
      message: text.slice(text.indexOf("\n\n") + 2),
    });

    expect(shape(mineText)).toEqual(shape(sourceText));
    expect(mineText).toContain("\ncommitter Operator <op@example.com> ");
  }

  const run = (args: readonly string[]) => fixture.run(takeover, args, repo);
  const statePath = async () =>
    join(repo, await git(["rev-parse", "--git-path", "skills-takeover"], repo));

  const state = async () => existsSync(await statePath());
  const stop = async (fields: object) =>
    writeFile(
      await statePath(),
      JSON.stringify({
        pr: 7,
        branch: "feat/mine",
        tip,
        head: tip,
        remaining: [first, second],
        ...fields,
      }),
    );

  return {
    fixture,
    origin,
    seed,
    repo,
    tip,
    first,
    second,
    merge,
    self,
    encoded,
    empty,
    git,
    pull,
    refs,
    carried,
    run,
    state,
    stop,
    dispose: () => fixture.dispose(),
  };
}

type Case = Awaited<ReturnType<typeof takeoverCase>>;

async function within(
  name: string,
  mine: Readonly<Record<string, string>> | undefined,
  body: (c: Case) => Promise<void>,
) {
  const c = await takeoverCase(name, mine);
  try {
    await body(c);
  } finally {
    await c.dispose();
  }
}

function both(c: Case): string {
  return `carried ${c.first.slice(0, 7)} feat(theirs): write a\ncarried ${c.second.slice(0, 7)} ${SECOND.split("\n")[0]}\n`;
}

async function carriedBoth(c: Case): Promise<void> {
  expect(await c.git(["rev-parse", "HEAD~2"], c.repo)).toBe(c.tip);
  await c.carried("HEAD~1", c.first);
  await c.carried("HEAD", c.second);

  expect(await c.git(["status", "--porcelain"], c.repo)).toBe("");
  expect(await c.state()).toBe(false);
  expect(existsSync(join(c.repo, ".git/MERGE_MSG"))).toBe(false);
  expect(existsSync(join(c.repo, ".git/AUTO_MERGE"))).toBe(false);
}

test.concurrent("takeover carries a PR's commits keeping author line and message", () =>
  within("carries", undefined, async (c) => {
    const hooks = join(c.fixture.temporary, "hooks");
    await mkdir(hooks);

    for (const [hook, body] of [
      ["prepare-commit-msg", 'printf "[hook ran]\\n" >> "$1"'],
      ["commit-msg", "exit 1"],
    ] as const) {
      await writeFile(join(hooks, hook), `#!/bin/sh\n${body}\n`);
      await chmod(join(hooks, hook), 0o755);
    }

    await c.git(["config", "core.hooksPath", hooks], c.repo);

    const result = await c.fixture.command([bin, "--root", root, "takeover", "7"], c.repo);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(both(c));

    await carriedBoth(c);
    expect(await c.git(["rev-parse", "feat/theirs"], c.origin)).toBe(c.second);
    expect(await c.git(["show", "HEAD:c"], c.repo)).toBe("c");
  }));

test.concurrent("takeover stops on a conflict and --continue carries the rest", () =>
  within("continue", { a: "mine\n" }, async (c) => {
    const stopped = await c.run(["7"]);
    expect(stopped.code).toBe(1);
    expect(stopped.stderr).toContain(
      `stopped at ${c.first.slice(0, 7)} feat(theirs): write a: conflict in a,`,
    );

    expect(await c.state()).toBe(true);
    expect((await c.run(["7"])).stderr).toContain(
      "is stopped on feat/mine, run skills takeover --continue",
    );

    await writeFixture(c.repo, "a", "one\n");
    expect((await c.run(["--continue"])).stderr).toContain("unmerged paths: a, resolve them");

    await c.git(["add", "a"], c.repo);
    await writeFixture(c.repo, "b", "changed\n");
    expect((await c.run(["--continue"])).stderr).toContain("unstaged changes, git add them");

    await c.git(["checkout", "--", "b"], c.repo);
    await writeFile(join(c.repo, ".git/MERGE_HEAD"), `${c.tip}\n`);
    expect((await c.run(["--continue"])).stderr).toContain("MERGE_HEAD in progress on feat/mine");

    rmSync(join(c.repo, ".git/MERGE_HEAD"));
    await writeFixture(c.repo, "x", "mine\n");
    await c.git(["add", "x"], c.repo);
    expect((await c.run(["--continue"])).stderr).toContain(
      `x is staged but ${c.first.slice(0, 7)} does not touch it`,
    );

    await c.git(["rm", "--quiet", "--cached", "x"], c.repo);
    rmSync(join(c.repo, "x"));
    const resumed = await c.run(["--continue"]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stdout).toBe(both(c));

    await carriedBoth(c);
  }));

test.concurrent("takeover --abort puts the branch back at its tip", () =>
  within("abort", { a: "mine\n" }, async (c) => {
    expect((await c.run(["7"])).code).toBe(1);

    const aborted = await c.run(["--abort"]);
    expect([aborted.code, aborted.stdout]).toEqual([0, `feat/mine back at ${c.tip.slice(0, 7)}\n`]);
    expect(await c.git(["rev-parse", "HEAD"], c.repo)).toBe(c.tip);
    expect(await c.git(["symbolic-ref", "HEAD"], c.repo)).toBe("refs/heads/feat/mine");
    expect(await c.git(["status", "--porcelain"], c.repo)).toBe("");

    expect(await c.state()).toBe(false);
    expect(existsSync(join(c.repo, ".git/MERGE_MSG"))).toBe(false);
    expect((await c.run(["--continue"])).stderr).toContain("no takeover is stopped");
  }));

test.concurrent("takeover --abort drops a carried commit and names edits it discards", () =>
  within("abort-carried", { b: "mine\n" }, async (c) => {
    const stopped = await c.run(["7"]);
    expect(stopped.stdout).toBe(`carried ${c.first.slice(0, 7)} feat(theirs): write a\n`);
    expect(stopped.stderr).toContain(`stopped at ${c.second.slice(0, 7)}`);

    const carried = await c.git(["rev-parse", "HEAD"], c.repo);
    await writeFixture(c.repo, "a", "edited\n");

    const aborted = await c.run(["--abort"]);
    expect([aborted.code, aborted.stdout]).toEqual([
      0,
      `dropped ${carried.slice(0, 7)} feat(theirs): write a\ndiscarded a\nfeat/mine back at ${c.tip.slice(0, 7)}\n`,
    ]);

    expect(await c.git(["rev-parse", "HEAD"], c.repo)).toBe(c.tip);
    expect(await c.git(["status", "--porcelain"], c.repo)).toBe("");
  }));

test.concurrent("--continue recovers a run that died mid pick or before its state write", () =>
  within("crash", undefined, async (c) => {
    await c.git(["fetch", "--quiet", "origin", "feat/theirs"], c.repo);
    await c.git(["cherry-pick", "-n", c.first], c.repo);
    await c.stop({ stop: { sha: c.first, kind: "picking" } });

    const picked = await c.run(["--continue"]);
    expect([picked.code, picked.stdout]).toEqual([0, both(c)]);
    await carriedBoth(c);

    await c.git(["reset", "--quiet", "--hard", c.tip], c.repo);
    await c.git(["cherry-pick", "-n", c.first], c.repo);
    await c.git(
      ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--cleanup=verbatim", "-C", c.first],
      c.repo,
    );

    await c.stop({ stop: { sha: c.first, kind: "picking" } });

    const committed = await c.run(["--continue"]);
    expect([committed.code, committed.stdout]).toEqual([
      0,
      `carried ${c.second.slice(0, 7)} ${SECOND.split("\n")[0]}\n`,
    ]);

    await carriedBoth(c);
  }));

test.concurrent("a conflict resolved to no change is skipped", () =>
  within("no-change", { a: "mine\n" }, async (c) => {
    expect((await c.run(["7"])).code).toBe(1);

    await writeFixture(c.repo, "a", "mine\n");
    await c.git(["add", "a"], c.repo);

    const resumed = await c.run(["--continue"]);
    expect([resumed.code, resumed.stdout]).toEqual([
      0,
      `skipped ${c.first.slice(0, 7)} feat(theirs): write a, resolved to no change\ncarried ${c.second.slice(0, 7)} ${SECOND.split("\n")[0]}\n`,
    ]);

    expect(await c.git(["rev-parse", "HEAD~1"], c.repo)).toBe(c.tip);
    expect(existsSync(join(c.repo, ".git/MERGE_MSG"))).toBe(false);
    expect(existsSync(join(c.repo, ".git/AUTO_MERGE"))).toBe(false);
  }));

test.concurrent("a commit made during a stop blocks --continue and --abort drops it", () =>
  within("gained", { a: "mine\n" }, async (c) => {
    expect((await c.run(["7"])).code).toBe(1);

    await writeFixture(c.repo, "a", "one\n");
    await c.git(["add", "a"], c.repo);
    await c.git(["commit", "--quiet", "-m", "fix: resolve"], c.repo);
    const gained = await c.git(["rev-parse", "HEAD"], c.repo);

    expect((await c.run(["--continue"])).stderr).toContain(
      `feat/mine gained ${gained.slice(0, 7)} since the takeover stopped, run git reset --soft ${c.tip.slice(0, 7)}`,
    );

    expect((await c.run(["7"])).stderr).toContain("is stopped on feat/mine");

    const aborted = await c.run(["--abort"]);
    expect([aborted.code, aborted.stdout]).toEqual([
      0,
      `dropped ${gained.slice(0, 7)} fix: resolve\nfeat/mine back at ${c.tip.slice(0, 7)}\n`,
    ]);

    expect(await c.git(["rev-parse", "HEAD"], c.repo)).toBe(c.tip);
    expect(await c.state()).toBe(false);
  }));

test.concurrent("takeover skips a commit whose patch is already on the branch", () =>
  within("skips", { a: "one\n" }, async (c) => {
    const alone = await c.run(["7", c.first]);
    expect([alone.code, alone.stdout]).toEqual([
      0,
      `skipped ${c.first.slice(0, 7)} feat(theirs): write a, already on feat/mine\n`,
    ]);

    expect(await c.git(["rev-parse", "HEAD"], c.repo)).toBe(c.tip);
    expect(existsSync(join(c.repo, ".git/MERGE_MSG"))).toBe(false);
    expect(await c.state()).toBe(false);

    const result = await c.run(["7"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      `skipped ${c.first.slice(0, 7)} feat(theirs): write a, already on feat/mine\ncarried ${c.second.slice(0, 7)} ${SECOND.split("\n")[0]}\n`,
    );

    expect(await c.git(["rev-parse", "HEAD~1"], c.repo)).toBe(c.tip);
    await c.carried("HEAD", c.second);
  }));

test.concurrent("takeover carries only the named shas, once each", () =>
  within("named", undefined, async (c) => {
    const result = await c.run(["7", c.second.slice(0, 7), c.second]);
    expect(result.code, result.stderr).toBe(0);
    expect(await c.git(["rev-parse", "HEAD~1"], c.repo)).toBe(c.tip);
    await c.carried("HEAD", c.second);
  }));

test.concurrent("takeover names the commits it leaves and carries an empty message", () =>
  within("left", undefined, async (c) => {
    await c.pull(16, {
      author: "someone-else",
      head: "feat/theirs",
      headOid: c.second,
      commits: [c.first, c.second],
      logins: [[""], ["someone-else"]],
    });

    const left = await c.run(["16"]);
    expect([left.code, left.stdout]).toEqual([
      0,
      `left ${c.first.slice(0, 7)} feat(theirs): write a, by an author GitHub cannot link\ncarried ${c.second.slice(0, 7)} ${SECOND.split("\n")[0]}\n`,
    ]);

    await c.pull(15, {
      author: "someone-else",
      head: "feat/empty",
      headOid: c.empty,
      commits: [c.empty],
    });

    const empty = await c.run(["15"]);
    expect([empty.code, empty.stdout]).toEqual([0, `carried ${c.empty.slice(0, 7)} \n`]);
    await c.carried("HEAD", c.empty);
  }));

test.concurrent("takeover carries in history order whatever order gh lists", () =>
  within("order", undefined, async (c) => {
    await c.pull(13, {
      author: "someone-else",
      head: "feat/theirs",
      headOid: c.second,
      commits: [c.second, c.first],
    });

    const result = await c.run(["13"]);
    expect([result.code, result.stdout]).toEqual([0, both(c)]);
    await carriedBoth(c);
  }));

test.concurrent("takeover refuses and moves no ref", () =>
  within("refuses", undefined, async (c) => {
    const theirs = { author: "someone-else", head: "feat/theirs", headOid: c.second };
    await c.pull(8, {
      author: "someone-else",
      head: "feat/merged",
      headOid: c.merge,
      commits: [c.first, c.second, c.merge],
    });

    await c.pull(9, { ...theirs, head: "feat/self", headOid: c.self, commits: [c.self] });
    await c.pull(10, { ...theirs, author: "operator", commits: [c.first, c.second] });
    await c.pull(11, {
      ...theirs,
      commits: [c.first, c.second],
      logins: [["someone-else"], ["someone-else", "operator"]],
    });

    await c.pull(12, { ...theirs, headOid: c.first, commits: [c.first, c.second] });
    await c.pull(14, { ...theirs, head: "feat/encoded", headOid: c.encoded, commits: [c.encoded] });

    const before = await c.refs();
    const refusals: [readonly string[], string][] = [
      [["10"], "PR 10 is yours"],
      [["7", c.tip], `${c.tip} is not a commit of PR 7`],
      [["8"], `${c.merge.slice(0, 7)} is a merge commit`],
      [["9"], `${c.self.slice(0, 7)} is authored as op@example.com`],
      [["11"], `${c.second.slice(0, 7)} names you, operator, among its authors`],
      [["12"], `${c.second.slice(0, 7)} is not in the history of PR 12's head`],
      [["14"], `${c.encoded.slice(0, 7)} has an encoding header`],
      [["7", "--continue"], "usage"],
    ];

    for (const [args, reason] of refusals) {
      const result = await c.run(args);
      expect(result.code, args.join(" ")).not.toBe(0);
      expect(result.stderr).toContain(reason);
      expect(await c.refs()).toBe(before);
      expect(await c.state()).toBe(false);
    }

    Object.assign(c.fixture.env, {
      GIT_AUTHOR_EMAIL: "forged@example.com",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "user.email",
      GIT_CONFIG_VALUE_0: "forged@example.com",
    });

    expect((await c.run(["9"])).stderr).toContain("is authored as op@example.com");
    Object.assign(c.fixture.env, { GIT_AUTHOR_EMAIL: "op@example.com", GIT_CONFIG_COUNT: "0" });

    await c.git(["config", "--unset", "user.email"], c.repo);
    expect((await c.run(["9"])).stderr).toContain("no user.email is set");
    await c.git(["config", "user.email", "op@example.com"], c.repo);

    await writeFile(c.fixture.env.SKILLS_CONF!, "DELIVERY=hands-off\n");
    const handsOff = await c.run(["7"]);
    expect([handsOff.code, handsOff.stderr]).toEqual([1, "takeover: delivery mode is not prs\n"]);
    expect(await c.refs()).toBe(before);
  }));

test.concurrent("takeover refuses tracked changes and a git operation in progress", () =>
  within("dirty", undefined, async (c) => {
    await writeFixture(c.repo, "c", "changed\n");
    expect((await c.run(["7"])).stderr).toBe("takeover: tracked changes\n");

    await c.git(["checkout", "--", "c"], c.repo);
    await writeFile(join(c.repo, ".git/MERGE_HEAD"), `${c.tip}\n`);
    expect((await c.run(["7"])).stderr).toBe("takeover: MERGE_HEAD in progress on feat/mine\n");

    rmSync(join(c.repo, ".git/MERGE_HEAD"));
    const held = await tryLock(join(c.repo, ".git/skills-takeover.lock"), () => c.run(["7"]));
    expect(held.held ? "" : held.value.stderr).toBe(
      "takeover: another skills takeover runs in this checkout\n",
    );

    await c.git(["switch", "--quiet", "main"], c.repo);
    expect((await c.run(["7"])).stderr).toBe(
      "takeover: main is the default branch, take over on a branch of your own\n",
    );

    await c.git(["remote", "set-url", "origin", join(c.fixture.temporary, "missing.git")], c.repo);
    expect((await c.run(["7"])).stderr).toContain("cannot read the default branch of origin");
  }));

test.concurrent("a run that dies after a pick onto a renamed path recovers", () =>
  within("renamed", undefined, async (c) => {
    await c.git(["mv", "a", "renamed"], c.repo);
    await c.git(["commit", "--quiet", "-m", "feat: rename a"], c.repo);
    const renamed = await c.git(["rev-parse", "HEAD"], c.repo);

    await faultGit(c.fixture);
    c.fixture.env.FAULT_PATTERN = "*core.hooksPath=/dev/null*";
    const stopped = await c.run(["7"]);
    expect(stopped.stderr).toContain(`cannot commit ${c.first.slice(0, 7)} feat(theirs): write a`);

    const path = join(c.repo, ".git/skills-takeover");
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.stop).toEqual({ sha: c.first, kind: "conflict", paths: ["renamed"] });
    await writeFile(path, JSON.stringify({ ...saved, stop: { ...saved.stop, kind: "picked" } }));

    delete c.fixture.env.FAULT_PATTERN;
    const resumed = await c.run(["--continue"]);
    expect([resumed.code, resumed.stdout]).toEqual([0, both(c)]);

    expect(await c.git(["rev-parse", "HEAD~2"], c.repo)).toBe(renamed);
    expect(await c.git(["show", "HEAD~1:renamed"], c.repo)).toBe("one");
    await c.carried("HEAD~1", c.first);
    await c.carried("HEAD", c.second);
  }));
