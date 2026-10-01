import { afterEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { suites } from "../cli.ts";
import { checkManifest } from "./manifest.ts";
import { commitFixture, createRepo, fakeSuite, fixtureGit, writeFixture } from "./fixtures.ts";
import { removeTemporary } from "./process.ts";

const repositories: string[] = [];

async function fixture(): Promise<string> {
  const repo = await createRepo();
  repositories.push(repo);
  return repo;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeTemporary));
});

describe("manifest", () => {
  test("docs validates its package without owning tests", () => {
    expect(suites.find((suite) => suite.name === "docs")).toEqual({
      name: "docs",
      cwd: "docs",
      argv: [
        "sh",
        "-c",
        "bun install --frozen-lockfile --silent && bun --preload ./scripts/preload.ts scripts/validate.ts",
      ],
      files: [],
      seconds: 3,
      watch: [
        "docs/**",
        "docs/content/**/*.mdx",
        "docs/content/**/*.md",
        "hooks/*.sh",
        "agents/*.md",
        "skills/*/SKILL.md",
        "skills/playbook/playbooks/*.md",
        "skills/playbook/references/codex-arms.md",
        "skills/playbook/references/delivery.md",
        "skills/playbook/scripts/reviewers.sh",
        "skills/playbook/scripts/deny-set.sh",
        "skills/*/reviewer.conf",
      ],
    });
  });

  test("watch-pr tests and typechecks its package", () => {
    expect(suites.find((suite) => suite.name === "watch-pr")?.argv).toEqual([
      "sh",
      "-c",
      "bun install --frozen-lockfile --silent && bun test watch-pr && bun run typecheck",
    ]);
  });

  test("a deleted row names the tracked test it no longer owns", async () => {
    const repo = await fixture();
    await writeFixture(repo, "test-owned.sh");
    await commitFixture(repo);

    expect(await checkManifest(repo, [fakeSuite("test-owned")])).toEqual([]);
    expect(await checkManifest(repo, [])).toEqual(["unlisted test file: test-owned.sh"]);
  });

  test("names every added unlisted test basename and validate", async () => {
    const repo = await fixture();
    const paths = ["nested/test-x.sh", "test_x.py", "src/x.test.ts", "scripts/validate.py"];
    for (const path of paths)
      await writeFixture(repo, path);

    const problems = await checkManifest(repo, []);

    expect(problems.sort()).toEqual(paths.map((path) => `unlisted test file: ${path}`).sort());
  });

  test("names missing explicit files and unmatched globs", async () => {
    const repo = await fixture();
    const suites = [fakeSuite("test-missing"), fakeSuite("bun", { files: ["src/**/*.test.ts"] })];

    expect(await checkManifest(repo, suites)).toEqual([
      "missing test file: test-missing.sh",
      "missing test file: src/**/*.test.ts",
    ]);
  });

  test("drops tracked deletions, ignored untracked files and node_modules", async () => {
    const repo = await fixture();
    await writeFixture(repo, "test-deleted.sh");
    await writeFixture(repo, "node_modules/tracked.test.ts");
    await fixtureGit(repo, ["add", "-f", "node_modules/tracked.test.ts"]);
    await commitFixture(repo);

    await rm(join(repo, "test-deleted.sh"));
    await writeFixture(repo, "ignored/test-ignore.sh");
    await writeFixture(repo, "node_modules/test_untracked.py");

    expect(await checkManifest(repo, [])).toEqual([]);
    expect(await checkManifest(repo, [fakeSuite("test-deleted")])).toEqual([
      "missing test file: test-deleted.sh",
    ]);
  });

  test("reports duplicate owners and permits multiple files in one row", async () => {
    const repo = await fixture();
    await writeFixture(repo, "src/x.test.ts");
    await writeFixture(repo, "src/nested/y.test.ts");
    const owner = fakeSuite("bun", { files: ["src/**/*.test.ts", "src/x.test.ts"] });

    expect(await checkManifest(repo, [owner])).toEqual([]);
    expect(
      await checkManifest(repo, [owner, fakeSuite("duplicate", { files: ["src/x.test.ts"] })]),
    ).toEqual(["test file owned twice: src/x.test.ts"]);
  });

  test("preserves whitespace and newlines in git paths", async () => {
    const repo = await fixture();
    await writeFixture(repo, "space directory/line\nbreak.test.ts");

    expect(await checkManifest(repo, [])).toEqual([
      "unlisted test file: space directory/line\nbreak.test.ts",
    ]);
  });
});
