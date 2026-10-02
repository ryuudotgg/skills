import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { suites } from "../cli.ts";
import { commitFixture, createRepo, fixtureGit, writeFixture } from "./fixtures.ts";
import { removeTemporary } from "./process.ts";
import { selectPaths, selectSuites } from "./selection.ts";

const repositories: string[] = [];

function typescriptFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.name === "node_modules") return [];
    if (entry.isDirectory()) return typescriptFiles(path);

    return entry.isFile() && /\.tsx?$/.test(path) ? [path] : [];
  });
}

function docsImportClosure(): string[] {
  const root = resolve(import.meta.dir, "../..");
  const pending = [
    ...typescriptFiles(join(root, "docs/lib")),
    ...typescriptFiles(join(root, "docs/scripts")),
  ];

  const visited = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;

    visited.add(file);

    for (const { path: specifier } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith(".")) continue;

      const base = resolve(dirname(file), specifier);
      const dependency = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
        (path) => /\.tsx?$/.test(path) && existsSync(path) && statSync(path).isFile(),
      );

      expect(dependency).toBeDefined();
      pending.push(dependency!);
    }
  }

  return [...visited].map((file) => relative(root, file)).filter((file) => !file.startsWith("docs/")).sort();
}

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

  test("src changes select code and style suites", async () => {
    const repo = await fixture();
    await writeFixture(repo, "src/new.ts");

    const expected = ["bun", "check", "format", "lint", "stanza", "typecheck"];
    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual(expected);
    expect(selectPaths(suites, ["src/plans/verbs.ts"]).map((suite) => suite.name).sort()).toEqual(expected);
  });

  test("each root tool change selects every row", () => {
    for (const path of [
      "package.json",
      "bun.lock",
      "bunfig.toml",
      "tsconfig.json",
      "skills/playbook/bin/skills",
    ])
      expect(selectPaths(suites, [path])).toEqual(suites);
  });

  test.each([
    "skills/coderabbit/reviewer.ts",
    "skills/greptile/reviewer.ts",
    "skills/macroscope/reviewer.ts",
    ".oxlintrc.json",
    ".oxfmtrc.json",
  ])("style suites watch %s", (path) => {
    expect(selectPaths(suites, [path]).map((suite) => suite.name)).toEqual([
      "check",
      "lint",
      "format",
      "stanza",
    ]);
  });

  test("docs code selects docs and style suites", () => {
    expect(selectPaths(suites, ["docs/lib/source.ts"]).map((suite) => suite.name)).toEqual([
      "check",
      "lint",
      "format",
      "stanza",
      "docs",
    ]);
  });

  test("docs src watch equals its transitive import closure", () => {
    const dependencies = docsImportClosure();
    const docs = suites.find((suite) => suite.name === "docs")!;

    expect(dependencies).toEqual([...new Set(docs.watch.filter((path) => path.startsWith("src/")))].sort());

    for (const path of dependencies)
      expect(selectPaths(suites, [path]).map((suite) => suite.name)).toContain("docs");
  });

  test(".py scripts select validation without the retired installer", async () => {
    const repo = await fixture();
    await writeFixture(repo, "scripts/x.py");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual([
      "check",
    ]);
  });

  test("a suite's own file selects its owner and validation", async () => {
    const repo = await fixture();
    await writeFixture(repo, "src/evals/gh-fake.test.ts", "before");
    await commitFixture(repo);
    await writeFixture(repo, "src/evals/gh-fake.test.ts", "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "check",
      "bun",
      "typecheck",
      "lint",
      "format",
      "stanza",
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
      "bun",
    );

    expect(
      selectPaths(suites, ["evals/cases/case.json"])
        .map((suite) => suite.name)
        .sort(),
    ).toEqual(["check"]);
  });
});
