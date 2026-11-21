import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { takeoverVerb } from "../stack/takeover.ts";
import { writeFixture } from "./fixtures.ts";
import { runCommand } from "./process.ts";
import { stackCase, type StackVerb } from "./stack-fixture.ts";

export const root = resolve(import.meta.dir, "../../../../skills");
const usage = "skills takeover <pr> [<sha>...] | --continue | --abort";
const takeover: StackVerb = (args, io) => takeoverVerb(args, usage, root, io);

export const someone = {
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
export const SECOND =
  "feat(takeover-scope): write b so this carried subject runs past the caps\n\nThe body says why b changes.\n\nCo-Authored-By: Third Person <third@example.com>\n";

type Pull = {
  author: string;
  head: string;
  headOid: string;
  url?: string;
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
      ["pr", "view", String(number), "--json", "author,headRefName,headRefOid,commits,url"],
      JSON.stringify({
        author: { login: spec.author },
        headRefName: spec.head,
        headRefOid: spec.headOid,
        url: spec.url ?? `https://github.com/test/repo/pull/${number}`,
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

export async function within(
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

export function both(c: Case): string {
  return `carried ${c.first.slice(0, 7)} feat(theirs): write a\ncarried ${c.second.slice(0, 7)} ${SECOND.split("\n")[0]}\n`;
}

export async function carriedBoth(c: Case): Promise<void> {
  expect(await c.git(["rev-parse", "HEAD~2"], c.repo)).toBe(c.tip);
  await c.carried("HEAD~1", c.first);
  await c.carried("HEAD", c.second);

  expect(await c.git(["status", "--porcelain"], c.repo)).toBe("");
  expect(await c.state()).toBe(false);
  expect(existsSync(join(c.repo, ".git/MERGE_MSG"))).toBe(false);
  expect(existsSync(join(c.repo, ".git/AUTO_MERGE"))).toBe(false);
}
