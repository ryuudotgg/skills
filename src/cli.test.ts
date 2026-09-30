import { afterEach, describe, expect, test } from "bun:test";
import { cp, mkdir, symlink } from "node:fs/promises";
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

describe("cli", () => {
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
    expect(result.stdout).toBe("validate\ntest-validate\n");
  });

  test("all refuses an unlisted file before running any suite", async () => {
    const repo = await fixture();
    await writeFixture(repo, "test-unlisted.sh");
    const result = await cli(repo, ["test", "--all"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("unlisted test file: test-unlisted.sh");
    expect(result.stderr).toContain("missing test file: scripts/validate.py");
  });

  test("an empty diff prints ok zero suites after checking the manifest", async () => {
    const repo = await fixture();
    for (const suite of suites) {
      for (const pattern of suite.files) {
        await writeFixture(repo, pattern.replaceAll("**/", "").replaceAll("*", "sample"));
      }
    }

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
    ]) {
      await cp(join(checkout, path), join(repo, path), { recursive: true });
    }

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
    ]) {
      expect(() => parseTestOptions(args)).toThrow();
    }
  });
});
