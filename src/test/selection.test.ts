import { afterEach, describe, expect, test } from "bun:test";
import { suites } from "../cli.ts";
import { commitFixture, createRepo, fixtureGit, writeFixture } from "./fixtures.ts";
import { removeTemporary } from "./process.ts";
import { selectPaths, selectSuites } from "./selection.ts";

const repositories: string[] = [];

async function fixture(): Promise<string> {
  const repo = await createRepo();
  repositories.push(repo);
  await fixtureGit(repo, ["config", "branch.main.skills-base", "main"]);

  return repo;
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeTemporary));
});

describe("selection", () => {
  test("markdown and mdx select explicit markdown dependencies", async () => {
    const repo = await fixture();
    await writeFixture(repo, "skills/plans/SKILL.md", "before");
    await writeFixture(repo, "docs/content/docs/index.mdx", "before");

    await commitFixture(repo);
    await writeFixture(repo, "skills/plans/SKILL.md", "after");
    await writeFixture(repo, "docs/content/docs/index.mdx", "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "check",
      "docs",
    ]);

    expect(
      selectPaths(suites, ["src/notes.md", "skills/playbook/scripts/notes.mdx"]).map(
        (suite) => suite.name,
      ),
    ).toEqual(["check"]);
  });

  test("unnamed markdown selects only validation", async () => {
    const repo = await fixture();
    const path = "skills/playbook/references/reviewers.md";
    await writeFixture(repo, path, "before");
    await commitFixture(repo);
    await writeFixture(repo, path, "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "check",
    ]);
  });

  test("delivery markdown selects install and docs alongside validation", async () => {
    const repo = await fixture();
    const path = "skills/playbook/references/delivery.md";
    await writeFixture(repo, path, "before");
    await commitFixture(repo);
    await writeFixture(repo, path, "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "check",
      "bun",
      "docs",
    ]);

    expect(selectPaths(suites, ["README.md"]).map((suite) => suite.name)).toEqual([
      "check",
      "bun",
    ]);
  });

  test.each([
    "docs/scripts/validate.ts",
    "docs/content/docs/index.mdx",
    "docs/content/docs/index.md",
    "src/hooks/guards.ts",
    "agents/sample.md",
    "skills/plans/SKILL.md",
    "skills/playbook/playbooks/feature.md",
    "skills/playbook/references/codex-arms.md",
    "skills/greptile/reviewer.conf",
  ])("docs watches its input %s", (path) => {
    expect(selectPaths(suites, [path]).map((suite) => suite.name)).toContain("docs");
  });

  test("src and each root tool change select every row", async () => {
    const repo = await fixture();
    await writeFixture(repo, "src/new.ts");

    expect(await selectSuites(repo, suites)).toEqual(suites);

    for (const path of [
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.json",
      "skills/playbook/bin/skills",
    ])
      expect(selectPaths(suites, [path])).toEqual(suites);
  });

  test("python scripts select validation without the retired installer", async () => {
    const repo = await fixture();
    await writeFixture(repo, "scripts/x.py");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual([
      "check",
    ]);
  });

  test("a suite's own file selects its owner and validation", async () => {
    const repo = await fixture();
    await writeFixture(repo, "scripts/stubs/test-gh.sh", "before");
    await commitFixture(repo);
    await writeFixture(repo, "scripts/stubs/test-gh.sh", "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "test-reviewers",
      "check",
      "test-gh",
    ]);
  });

  test("an empty diff selects nothing and ignores untracked ignored files", async () => {
    const repo = await fixture();
    await writeFixture(repo, "ignored/src/new.ts");
    expect(await selectSuites(repo, suites)).toEqual([]);
  });

  test("uses origin/main when no skills-base is configured", async () => {
    const repo = await fixture();
    await fixtureGit(repo, ["config", "--unset", "branch.main.skills-base"]);
    await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await writeFixture(repo, "scripts/x.py");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual([
      "check",
    ]);
  });

  test("warns and uses origin/main when skills-base does not resolve", async () => {
    const repo = await fixture();
    await fixtureGit(repo, ["config", "branch.main.skills-base", "missing"]);
    await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await writeFixture(repo, "install.sh");
    let stderr = "";

    expect(
      (
        await selectSuites(repo, suites, (text) => {
          stderr += text;
        })
      ).map((suite) => suite.name),
    ).toEqual(["check", "bun"]);

    expect(stderr).toBe("test: skills-base missing does not resolve, using origin/main\n");
  });

  test("falls back with stderr when neither base resolves", async () => {
    const repo = await fixture();
    await fixtureGit(repo, ["config", "branch.main.skills-base", "missing"]);
    let stderr = "";

    expect(
      await selectSuites(repo, suites, (text) => {
        stderr += text;
      }),
    ).toEqual(suites);

    expect(stderr).toContain("selecting every suite");
  });

  test("falls back with stderr when histories have no merge base", async () => {
    const repo = await fixture();
    await fixtureGit(repo, ["checkout", "-q", "--orphan", "unrelated"]);
    await writeFixture(repo, "unrelated", "separate history");
    await commitFixture(repo);
    await fixtureGit(repo, ["config", "branch.unrelated.skills-base", "main"]);

    let stderr = "";

    expect(
      await selectSuites(repo, suites, (text) => {
        stderr += text;
      }),
    ).toEqual(suites);

    expect(stderr).toContain("merge base");
  });

  test("rename detection cannot hide a script renamed to markdown", async () => {
    const repo = await fixture();
    await writeFixture(repo, "scripts/original.py", "content");
    await commitFixture(repo);
    await fixtureGit(repo, ["mv", "scripts/original.py", "scripts/renamed.md"]);

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual([
      "check",
    ]);
  });

  test("a reviewer declaration selects the Bun tests that read it", () => {
    expect(selectPaths(suites, ["skills/new/reviewer.conf"]).map((suite) => suite.name)).toContain(
      "bun",
    );
  });

  test("stub and eval watch sets stay separate", () => {
    expect(selectPaths(suites, ["scripts/stubs/gh"]).map((suite) => suite.name)).toContain(
      "test-gh",
    );

    expect(
      selectPaths(suites, ["evals/cases/case.json"])
        .map((suite) => suite.name)
        .sort(),
    ).toEqual(["check"]);
  });
});
