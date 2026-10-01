import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { suites } from "./cli.ts";
import { commitFixture, createRepo, fixtureGit, writeFixture } from "./test/fixtures.ts";
import { removeTemporary, runCommand } from "./test/process.ts";
import { parseTestOptions } from "./test/command.ts";

const repositories: string[] = [];
const checkout = resolve(import.meta.dir, "..");
const bin = join(checkout, "skills/playbook/bin/skills");

async function fixture(): Promise<string> {
  const repo = await createRepo();
  repositories.push(repo);
  return repo;
}

async function cli(repo: string, args: readonly string[]) {
  return runCommand([bin, "--root", join(repo, "skills"), ...args], { cwd: repo });
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeTemporary));
});

const fallbackBun = ["/opt/homebrew/bin/bun", "/usr/local/bin/bun"].some((path) => existsSync(path));

describe("cli", () => {
  test.skipIf(fallbackBun)("missing Bun denies pre-tool-use on stdout and exits zero", async () => {
    const home = await mkdtemp(join(tmpdir(), "skills-wrapper-"));
    repositories.push(home);

    for (const args of [
      ["hook", "pre-tool-use"],
      ["hook", "pre-tool-use", "extra"],
      ["--root", home, "hook", "pre-tool-use"],
    ]) {
      const result = await runCommand([bin, ...args], {
        cwd: home,
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin", AGENT_HOOKS: "0" },
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe(
        '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Blocked: bun was not found, so the commit guard cannot run and every shell command stays blocked. Install Bun 1.4.0 or newer outside this session and put bun on PATH or in ~/.bun/bin."}}\n',
      );
    }
  });

  test("a crashing guard denies while other verbs keep their exit code", async () => {
    const checkout = await mkdtemp(join(tmpdir(), "skills-crash-"));
    repositories.push(checkout);

    await mkdir(join(checkout, "skills/playbook/bin"), { recursive: true });
    await mkdir(join(checkout, "src"));
    await cp(bin, join(checkout, "skills/playbook/bin/skills"));
    await Bun.write(join(checkout, "bunfig.toml"), "");
    await Bun.write(join(checkout, "src/cli.ts"), "process.exit(3);\n");

    const wrapper = join(checkout, "skills/playbook/bin/skills");
    for (const args of [["hook", "pre-tool-use"], ["--root", checkout, "hook", "pre-tool-use"]]) {
      const result = await runCommand([wrapper, ...args], { cwd: checkout, env: process.env });

      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason).toStartWith(
        "Blocked: the commit guard exited with an error",
      );
    }

    const other = await runCommand([wrapper, "hook", "post-tool-use"], { cwd: checkout, env: process.env });
    expect(other.code).toBe(3);
    expect(other.stdout).toBe("");
  });

  test.skipIf(fallbackBun)("missing Bun and an unset HOME still deny pre-tool-use", async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: "/usr/bin:/bin" };
    delete env.HOME;
    const result = await runCommand([bin, "hook", "pre-tool-use"], { cwd: tmpdir(), env });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  test.skipIf(fallbackBun)("missing Bun keeps other verbs on stderr with exit 127", async () => {
    const home = await mkdtemp(join(tmpdir(), "skills-wrapper-"));
    repositories.push(home);

    for (const args of [[], ["hook"], ["hook", "post-tool-use"], ["test", "--all"]]) {
      const result = await runCommand([bin, ...args], {
        cwd: home,
        env: { ...process.env, HOME: home, PATH: "/usr/bin:/bin" },
      });

      expect(result.code).toBe(127);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe(
        "skills: install Bun 1.4.0 or newer and put bun on PATH or in ~/.bun/bin.\n",
      );
    }
  });

  test("help exits zero and lists the test usage without reading repo state", async () => {
    const repo = await fixture();
    const result = await cli(repo, ["--help"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toContain("skills test [--all | --list | --parity <suite>");
    expect(result.stderr).toBe("");
  });

  test("unknown verbs and invalid flags exit two with usage on stderr", async () => {
    const repo = await fixture();
    for (const args of [
      ["unknown"],
      ["test", "--jobs", "0"],
      ["test", "--all", "--list"],
      ["test", "--stub", "x=false"],
    ]) {
      const result = await cli(repo, args);

      expect(result.code).toBe(2);
      expect(result.stderr).toContain("skills");
      expect(result.stdout).toBe("");
    }
  });

  test("list follows a temporary repo's markdown diff", async () => {
    const repo = await fixture();
    await fixtureGit(repo, ["config", "branch.main.skills-base", "main"]);
    await writeFixture(repo, "skills/plans/SKILL.md");
    await writeFixture(repo, "docs/content/docs/index.mdx");
    const result = await cli(repo, ["test", "--list"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("check\ndocs\n");
  });

  test("contributing documents explicit markdown watch selection", async () => {
    const contributing = await readFile(join(checkout, "CONTRIBUTING.md"), "utf8");

    expect(contributing).toContain(
      "Markdown changes select `check` and suites with explicit markdown watch patterns, including `bun` for README, installer inputs and the delivery reference, and `docs` for its pages and inputs.",
    );

    expect(contributing).not.toContain("Markdown changes select only");
  });

  test("all refuses an unlisted file before running any suite", async () => {
    const repo = await fixture();
    await writeFixture(repo, "test-unlisted.sh");
    const result = await cli(repo, ["test", "--all"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unlisted test file: test-unlisted.sh");
    expect(result.stderr).toContain("missing test file: scripts/stubs/test-gh.sh");
  });

  test("an empty diff prints ok zero suites after checking the manifest", async () => {
    const repo = await fixture();
    for (const suite of suites)
      for (const pattern of suite.files)
        await writeFixture(repo, pattern.replaceAll("**/", "").replaceAll("*", "sample"));

    await commitFixture(repo);
    await fixtureGit(repo, ["config", "branch.main.skills-base", "main"]);
    const result = await cli(repo, ["test"]);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("ok 0 suites\n");
    expect(result.stderr).toBe("");
  });

  test("a clean copy runs help through both directory and file symlinks", async () => {
    const repo = await fixture();
    for (const path of [
      "src",
      "skills/playbook/bin",
      "package.json",
      "bunfig.toml",
      "tsconfig.json",
    ])
      await cp(join(checkout, path), join(repo, path), { recursive: true });

    await mkdir(join(repo, "links"));
    await symlink(join(repo, "skills/playbook"), join(repo, "links/playbook"));
    await symlink("playbook/bin/skills", join(repo, "links/skills"));

    for (const entry of ["links/playbook/bin/skills", "links/skills"]) {
      const result = await runCommand([join(repo, entry), "--help"], { cwd: repo });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("skills test");
      expect(result.stderr).toBe("");
    }
  });

  test("argument parsing keeps parity stubs, suite names and worker counts typed", () => {
    expect(parseTestOptions(["test-frontier", "--jobs", "3"]).mode).toEqual({
      kind: "named",
      names: ["test-frontier"],
    });

    expect(
      parseTestOptions(["--parity", "test.sh", "--stub", "x.sh=printf value=1", "--jobs", "2"]),
    ).toEqual({
      mode: {
        kind: "parity",
        suite: "test.sh",
        stubs: [{ legacy: "x.sh", command: "printf value=1" }],
      },
      jobs: 2,
    });

    for (const args of [
      ["--jobs"],
      ["--jobs", "1.5"],
      ["--parity"],
      ["--all", "name"],
      ["--parity", "test.sh", "--stub", "x"],
    ])
      expect(() => parseTestOptions(args)).toThrow();
  });
});
