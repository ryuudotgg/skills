import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { MESSAGE, messageProblem, run } from "./commit.ts";
import { asciiTrim, clearGeneratedBody, registered, stackLayers, stripFrontmatter, templateBody } from "./stack.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const sourceSkills = resolve(import.meta.dir, "../../skills");
const stub = resolve(import.meta.dir, "../../scripts/stubs/gh");
const branch = "feat/a.b+c";
const message = "feat: publish layer";
const url = "https://github.com/test/repo/pull/123";

function prArgs(name: string): string[] {
  return ["pr", "list", "--head", name, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"];
}

describe("publish CLI", () => {
  let temporary: string;
  let repo: string;
  let origin: string;

  let fixtures: string;
  let log: string;
  let testBin: string;
  let env: NodeJS.ProcessEnv;

  async function fixture(args: readonly string[], output = "", code = 0): Promise<void> {
    const key = args.join(" ").replace(/[^A-Za-z0-9._-]/gu, "_");
    await writeFile(join(fixtures, key), output);
    await writeFile(join(fixtures, `${key}.exit`), `${code}\n`);
  }

  async function calls(): Promise<string[]> {
    return (await readFile(log, "utf8")).split("\n").filter(Boolean);
  }

  async function publish(args: readonly string[] = ["-m", message, "a"]) {
    return runCommand([bin, "--root", sourceSkills, "publish", ...args], { cwd: repo, env, timeout: 60_000 });
  }

  async function refuse(reason: string, args?: readonly string[]): Promise<void> {
    const result = await publish(args);
    expect([result.code, result.stdout]).toEqual([1, ""]);
    expect(result.stderr).toEndWith(`publish: ${reason}\n`);
  }

  async function stackFixture(): Promise<void> {
    await fixture(prArgs("feat/parent"), "https://github.com/test/repo/pull/parent");
    await fixture(["stack", "--version"], "version");
    await fixture(["stack", "init", "--base", "main", "feat/parent", branch], "initialized\n");
    await fixture(["stack", "add", branch], "added\n");
    await fixture(["stack", "view", "--json"], JSON.stringify({ trunk: "main", currentBranch: branch, branches: [
      { name: "feat/parent", head: "parent-head", pr: { number: 1 } },
      { name: branch, head: "head", pr: null },
    ] }));

    await fixture(["stack", "submit", "--auto", "--open"], "submitted\n");
    await fixture(["pr", "edit", url, "--title", message, "--body", ""], "edited\n");
  }

  async function state(names: readonly string[], trunk = "main"): Promise<void> {
    await writeFile(join(repo, ".git/gh-stack"), JSON.stringify({ stacks: [{ trunk: { branch: trunk }, branches: names.map((name) => ({ branch: name })) }] }));
  }

  beforeEach(async () => {
    temporary = await realpath(await mkdtemp(join(tmpdir(), "skills-publish-")));
    repo = join(temporary, "repo");
    origin = join(temporary, "origin.git");

    fixtures = join(temporary, "gh");
    log = join(temporary, "gh.log");
    testBin = join(temporary, "bin");

    env = {
      ...suiteEnvironment(),
      PATH: `${testBin}:${process.env.PATH ?? ""}`,
      GH_STUB_DIR: fixtures,
      GH_STUB_LOG: log,
      SKILLS_CONF: join(temporary, "skills.conf"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "skills test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "skills test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    };

    await mkdir(fixtures);
    await mkdir(testBin);
    await writeFile(log, "");
    await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=prs\n");
    await writeFile(join(testBin, "gh"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
const result = Bun.spawnSync([${JSON.stringify(stub)}, ...args], { stdout: "inherit", stderr: "inherit" });
if (result.exitCode !== 0) process.exit(result.exitCode);
if (args[0] === "stack" && args[1] === "add") {
  const current = Bun.spawnSync(["git", "branch", "--show-current"], { stdout: "pipe", stderr: "inherit" });
  await Bun.write(process.env.GH_STUB_DIR + "/add.from", current.stdout);
  const checkout = Bun.spawnSync(["git", "checkout", "--quiet", args[2]], { stdout: "inherit", stderr: "inherit" });
  process.exit(checkout.exitCode);
}
if (args.join(" ") === "stack submit --auto --open") {
  const key = ${JSON.stringify(prArgs(branch).join(" ").replace(/[^A-Za-z0-9._-]/gu, "_"))};
  await Bun.write(process.env.GH_STUB_DIR + "/" + key, ${JSON.stringify(url)});
}
`);

    await chmod(join(testBin, "gh"), 0o755);

    await fixtureGit(temporary, ["init", "--quiet", "--bare", "-b", "main", origin]);
    await fixtureGit(temporary, ["init", "--quiet", "-b", "main", repo]);
    await fixtureGit(repo, ["config", "commit.gpgsign", "false"]);
    await fixtureGit(repo, ["config", "core.hooksPath", join(repo, ".git/hooks")]);
    await fixtureGit(repo, ["remote", "add", "origin", origin]);

    await writeFixture(repo, "a", "a\n");
    await writeFixture(repo, "unrelated", "unrelated\n");
    await commitFixture(repo);

    await fixtureGit(repo, ["push", "--quiet", "origin", "main"]);
    await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/parent"]);
    await fixtureGit(repo, ["config", "branch.feat/parent.skills-base", "origin/main"]);

    await writeFixture(repo, "parent", "parent\n");
    await commitFixture(repo);

    await fixtureGit(repo, ["checkout", "--quiet", "-b", branch]);
    await fixtureGit(repo, ["config", `branch.${branch}.skills-base`, "feat/parent"]);
    await writeFixture(repo, "a", "changed\n");
    await fixture(prArgs(branch));
    await stackFixture();
  });

  afterEach(async () => {
    await removeTemporary(temporary);
  });

  async function plainBranch(): Promise<string[]> {
    await fixtureGit(repo, ["checkout", "--quiet", "-b", "feat/plain", "main"]);
    await fixtureGit(repo, ["config", "branch.feat/plain.skills-base", "origin/main"]);
    await writeFixture(repo, "a", "plain\n");
    await fixture(prArgs("feat/plain"));

    return ["pr", "create", "--base", "main", "--head", "feat/plain", "--title", message, "--body", ""];
  }

  async function pushedHead(name: string): Promise<string> {
    return fixtureGit(origin, ["rev-parse", `refs/heads/${name}`]);
  }

  test("a branch on the trunk pushes and opens one PR without the stack path", async () => {
    const create = await plainBranch();
    await fixture(create, `progress\n${url}\n`);

    const result = await publish();
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
    expect(await pushedHead("feat/plain")).toBe(await fixtureGit(repo, ["rev-parse", "HEAD"]));

    const recorded = await calls();
    expect(recorded).toContain(create.join(" "));
    expect(recorded).toContain("stack --version");
    expect(recorded.some((call) => /^stack (init|add|view|submit)/.test(call))).toBe(false);
  });

  test("a failed PR creation reruns on the pushed commit and opens exactly one PR", async () => {
    const create = await plainBranch();
    await fixture(create, "", 1);
    await refuse("gh pr create failed");

    const head = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    expect(await pushedHead("feat/plain")).toBe(head);

    await fixture(create, `${url}\n`);
    await writeFile(log, "");

    const result = await publish();
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
    expect(await fixtureGit(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect((await calls()).filter((call) => call.startsWith("pr create "))).toHaveLength(1);
  });

  test("hands-off mode refuses before staging, committing or calling gh", async () => {
    await plainBranch();
    await writeFile(env.SKILLS_CONF ?? "", "DELIVERY=hands-off\n");

    const head = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await refuse("delivery mode is not prs");

    expect(await fixtureGit(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(await fixtureGit(repo, ["diff", "--cached", "--name-only"])).toBe("");
    expect(await calls()).toEqual([]);
    await expect(fixtureGit(origin, ["rev-parse", "--verify", "--quiet", "refs/heads/feat/plain"])).rejects.toThrow();
  });

  test("initializes the chain and emits only the URL", async () => {
    const result = await publish();
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
    expect(result.stderr).toContain("initialized\n");
    expect((await calls()).filter((call) => /^stack (init|view|submit) |^pr edit /.test(call))).toEqual([
      `stack init --base main feat/parent ${branch}`,
      "stack view --json",
      "stack submit --auto --open",
      `pr edit ${url} --title ${message} --body `,
    ]);

    expect(await fixtureGit(repo, ["log", "-1", "--format=%B"])).toBe(`${message}\n\n`);
    expect(await fixtureGit(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("a\n");
  });

  test.each([
    [["feat/aXb+c", "feat/parent"], true],
    [[branch, "feat/parent"], false],
  ] as const)("registration compares exact names: %j", async (names, adds) => {
    await state(names);

    const result = await publish();
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);

    const recorded = await calls();
    expect(recorded.some((call) => call.startsWith("stack init "))).toBe(false);
    expect(recorded.includes(`stack add ${branch}`)).toBe(adds);
    if (adds) expect(await readFile(join(fixtures, "add.from"), "utf8")).toBe("feat/parent\n");

    expect(await fixtureGit(repo, ["branch", "--show-current"])).toBe(`${branch}\n`);
  });

  test("real stack JSON refuses a remote layer ahead of local", async () => {
    await fixtureGit(repo, ["checkout", "--quiet", "feat/parent"]);
    const local = (await fixtureGit(repo, ["rev-parse", "HEAD"])).trimEnd();
    await fixtureGit(repo, ["commit", "--quiet", "--allow-empty", "-m", "feat: remote change"]);

    const remote = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await fixtureGit(repo, ["push", "--quiet", "origin", "feat/parent"]);
    await fixtureGit(repo, ["checkout", "--quiet", branch]);
    await fixtureGit(repo, ["branch", "--force", "feat/parent", local]);

    await refuse("origin/feat/parent has commits feat/parent lacks, rebase before publishing");
    expect(await fixtureGit(repo, ["rev-parse", "origin/feat/parent"])).toBe(remote);
    expect((await calls()).some((call) => /^stack submit |^pr edit /.test(call))).toBe(false);
  });

  test.each([
    ["feat: first\nsecond", "multi line message"],
    ["feat: carriage\rreturn", "multi line message"],
    [`feat: ${"a".repeat(45)}`, "longer than 50 characters"],
    ["missing prefix", "no Conventional prefix"],
    ["Co-authored-by: a <a@b>", "no Conventional prefix"],
  ])("invalid message and title refuse before git: %j", async (value, reason) => {
    const gitLog = join(temporary, "git.log");
    await writeFile(gitLog, "");
    await writeFile(join(testBin, "git"), `#!/usr/bin/env bun\nawait Bun.write(${JSON.stringify(gitLog)}, "called");\nprocess.exit(1);\n`);
    await chmod(join(testBin, "git"), 0o755);

    await refuse(reason, ["-m", value, "a"]);
    await refuse(reason, ["-m", message, "-t", value, "a"]);
    expect(await readFile(gitLog, "utf8")).toBe("");
    expect(await calls()).toEqual([]);
  });

  test.each([[], ["-m"], ["-m", message], ["-m", message, "-m", message, "a"], ["-x", "a"], ["-m", message, "-t", message, "-t", message, "a"]].map((args) => [args] as const))("usage: %j", async (args) => {
    const result = await publish(args);
    expect([result.code, result.stdout, result.stderr]).toEqual([2, "", 'usage: skills publish -m "<message>" [-t "<title>"] <file>...\n']);
    expect(await calls()).toEqual([]);
  });

  test("accepts attached options and stops parsing at --", async () => {
    const result = await publish([`-m${message}`, `-t${message}`, "--", "a"]);
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
  });

  test("staged outside paths refuse before reading an invalid recorded base", async () => {
    await fixtureGit(repo, ["config", `branch.${branch}.skills-base`, "missing"]);
    await writeFixture(repo, "unrelated", "changed\n");
    await fixtureGit(repo, ["add", "unrelated"]);

    await refuse("already staged outside the file list: unrelated");
    expect(await calls()).toEqual([]);
  });

  test("directory and glob pathspecs include only selected paths", async () => {
    await writeFixture(repo, "nested/first", "one\n");
    await writeFixture(repo, "nested/second", "two\n");
    await fixtureGit(repo, ["add", "nested"]);

    const result = await publish(["-m", message, "nested/*"]);
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
    expect(await fixtureGit(repo, ["show", "--name-only", "--format=", "HEAD"])).toBe("nested/first\nnested/second\n");
    expect(await fixtureGit(repo, ["diff", "--name-only"])).toBe("a\n");
  });

  test("altered messages reset only the new commit and retain the index", async () => {
    const before = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await writeFixture(repo, ".git/hooks/commit-msg", '#!/bin/sh\nprintf "\\nCo-authored-by: hook <hook@example.com>\\n" >> "$1"\n');
    await chmod(join(repo, ".git/hooks/commit-msg"), 0o755);

    await refuse("commit message was altered by a hook or template");
    expect(await fixtureGit(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await fixtureGit(repo, ["diff", "--cached", "--name-only", "-z"])).toBe("a\0");
    expect(await calls()).toEqual([]);
  });

  test("failed commits preserve HEAD and the index without resetting", async () => {
    const before = await fixtureGit(repo, ["rev-parse", "HEAD"]);
    await writeFixture(repo, ".git/hooks/pre-commit", "#!/bin/sh\nexit 1\n");
    await chmod(join(repo, ".git/hooks/pre-commit"), 0o755);

    await refuse("git commit failed");
    expect(await fixtureGit(repo, ["rev-parse", "HEAD"])).toBe(before);
    expect(await fixtureGit(repo, ["diff", "--cached", "--name-only", "-z"])).toBe("a\0");
    expect(await calls()).toEqual([]);
  });

  test.each(["not json", '{"stacks":{}}'])("malformed stack state refuses: %s", async (content) => {
    await writeFile(join(repo, ".git/gh-stack"), content);
    await refuse(`cannot read ${join(repo, ".git/gh-stack")}`);
    expect((await calls()).some((call) => /^stack (init|add|view|submit) /.test(call))).toBe(false);
  });

  test("trunk.branch never registers the current branch", async () => {
    await state([], branch);

    const result = await publish();
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
    expect(await calls()).toContain(`stack init --base main feat/parent ${branch}`);
  });

  test("template precedence and frontmatter clear a generated body", async () => {
    await fixture(prArgs(branch), url);
    await writeFixture(repo, ".github/pull-request-template.md", "---\r\nname: default\r\n---\r\n\n  Describe it.\n");
    await writeFixture(repo, "PULL_REQUEST_TEMPLATE.md", "other");
    await writeFixture(repo, "docs/pull_request_template.md", "another");
    await fixture(["pr", "view", url, "--json", "body", "--jq", ".body"], "\tDescribe it.\r\n");

    const result = await publish();
    expect([result.code, result.stdout]).toEqual([0, `${url}\n`]);
    expect(templateBody(repo)).toBe("Describe it.");
    expect(await calls()).toContain(`pr edit ${url} --title ${message} --body `);
  });
});

describe("publish message rule", () => {
  test.each(["feat: valid", "fix(scope)!: change", "chore: x", `feat: ${"😀".repeat(44)}`])("accepts %s", (value) => {
    expect(messageProblem(value)).toBeUndefined();
    expect(MESSAGE.test(value)).toBe(true);
  });

  test.each(["", "feat: ", "feat: trailing ", "feat(): empty", "feat(two words): spaced", "feat: \t"])("rejects %j", (value) => {
    expect(messageProblem(value)).toBe("no Conventional prefix");
  });

  test("length counts code points and multiline takes priority", () => {
    expect(messageProblem(`feat: ${"😀".repeat(45)}`)).toBe("longer than 50 characters");
    expect(messageProblem(`feat: ${"x".repeat(100)}\n`)).toBe("multi line message");
    expect(MESSAGE.test("feat: x\ry")).toBe(false);
    expect(messageProblem("feat: x\ry")).toBe("multi line message");
  });

  test("messages use <type>(<scope>): <summary> without scope or edge whitespace", () => {
    for (const scope of ["x y", "x\ty"]) expect(MESSAGE.test(`feat(${scope}): y`)).toBe(false);

    for (const whitespace of [" ", "\t", "\u00a0"]) {
      expect(MESSAGE.test(`feat(x): ${whitespace}y`)).toBe(false);
      expect(MESSAGE.test(`feat(x): y${whitespace}`)).toBe(false);
    }

    expect(MESSAGE.test("feat(x): y")).toBe(true);
  });

  test("Unicode line and paragraph separators count as a second line", () => {
    for (const separator of ["\u2028", "\u2029"]) expect(messageProblem(`feat: x${separator}y`)).toBe("multi line message");
  });

  test("control characters fail anywhere in the message", () => {
    for (const control of ["\x1c", "\x1f", "\x85", "\x07"]) {
      expect(MESSAGE.test(`feat(a${control}b): add x`)).toBe(false);
      expect(MESSAGE.test(`feat: ${control}add x`)).toBe(false);
      expect(MESSAGE.test(`feat: add${control}x`)).toBe(false);
      expect(MESSAGE.test(`feat: add x${control}`)).toBe(false);
    }
  });
});

describe("process runner", () => {
  test("a read deadline returns while a grandchild still holds the pipe", async () => {
    const started = performance.now();
    const result = await run(tmpdir(), ["sh", "-c", "sleep 5 & sleep 5"], { capture: true, timeout: 300 });

    expect(result.code).toBeUndefined();
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  test("a write has no deadline", async () => {
    const result = await run(tmpdir(), ["sh", "-c", "sleep 0.5; printf done"], { capture: true, write: true, timeout: 100 });
    expect(result).toEqual({ code: 0, output: "done" });
  });
});

describe("publish stack and template rules", () => {
  test("view uses branches[].name and rejects malformed JSON", () => {
    expect(stackLayers('{"trunk":"main","currentBranch":"feat/a","branches":[{"name":"feat/a","head":"oid","pr":{"number":1}}]}')).toEqual(["feat/a"]);

    for (const value of ["not json", "{}", '{"branches":{}}', '{"branches":[{}]}'])
      expect(stackLayers(value)).toBeUndefined();
  });

  test("missing stack state is unregistered", () => {
    expect(registered(join(tmpdir(), "skills-publish-no-such-directory"), branch)).toBe(false);
  });

  test("ASCII trim preserves non-ASCII whitespace", () => {
    expect(asciiTrim(" \t\n\r\f\vx \t\n\r\f\v")).toBe("x");
    expect(asciiTrim("\u00a0x\u00a0")).toBe("\u00a0x\u00a0");
  });

  test("frontmatter is stripped only at the start", () => {
    expect(stripFrontmatter("---\nname: x\n---\n\nbody\n")).toBe("body");
    expect(stripFrontmatter("---\nnever closed\n")).toBe("");
    expect(stripFrontmatter("\n---\nbody\n")).toBe("---\nbody");
  });

  test("only new, gh-stack and matching template bodies are cleared", () => {
    expect(clearGeneratedBody("", "anything", undefined)).toBe(true);
    expect(clearGeneratedBody(url, "Generated by https://github.com/github/gh-stack", undefined)).toBe(true);
    expect(clearGeneratedBody(url, " \tDescribe it.\r\n", "Describe it.")).toBe(true);

    expect(clearGeneratedBody(url, "Review bot summary", "Describe it.")).toBe(false);
    expect(clearGeneratedBody(url, "", undefined)).toBe(false);
    expect(clearGeneratedBody(url, "\u00a0Describe it.", "Describe it.")).toBe(false);
  });
});
