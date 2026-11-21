import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { suites } from "../cli.ts";
import { affectedTests, startsProcess } from "./affected.ts";
import { commitFixture, createRepo, fakeSuite, fixtureGit, writeFixture } from "./fixtures.ts";
import { worktreeFiles } from "./git.ts";
import { removeTemporary } from "./process.ts";
import { selectPaths, selectSuites } from "./selection.ts";

const root = resolve(import.meta.dir, "../../../..");
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
  const pending = [
    ...typescriptFiles(join(root, "apps/docs/lib")),
    ...typescriptFiles(join(root, "apps/docs/scripts")),
  ];

  const cli = join(root, "packages/cli");
  const exported: Record<string, string> = JSON.parse(
    readFileSync(join(cli, "package.json"), "utf8"),
  ).exports;

  const visited = new Set<string>();
  const subpaths = new Set<string>();
  const transpiler = new Bun.Transpiler({ loader: "tsx" });
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (visited.has(file)) continue;

    visited.add(file);

    for (const { path: specifier } of transpiler.scanImports(readFileSync(file, "utf8"))) {
      if (specifier === "skills-cli" || specifier.startsWith("skills-cli/")) {
        const subpath = `.${specifier.slice("skills-cli".length)}`;
        expect(exported[subpath]).toBeDefined();
        subpaths.add(subpath);
        pending.push(join(cli, exported[subpath]!));
        continue;
      }

      if (!specifier.startsWith(".")) continue;

      const base = resolve(dirname(file), specifier);
      const dependency = [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts")].find(
        (path) => /\.tsx?$/.test(path) && existsSync(path) && statSync(path).isFile(),
      );

      expect(dependency).toBeDefined();
      pending.push(dependency!);
    }
  }

  expect([...subpaths].sort()).toEqual(Object.keys(exported).sort());

  return [...visited]
    .map((file) => relative(root, file))
    .filter((file) => !file.startsWith("apps/docs/"))
    .sort();
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
    await writeFixture(repo, "apps/docs/content/docs/index.mdx", "before");

    await commitFixture(repo);
    await writeFixture(repo, "skills/plans/SKILL.md", "after");
    await writeFixture(repo, "apps/docs/content/docs/index.mdx", "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "check",
      "format",
      "docs",
    ]);

    expect(
      selectPaths(suites, ["packages/cli/src/notes.md", "skills/playbook/scripts/notes.mdx"]).map(
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

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual(["check"]);
  });

  test("rule groups markdown selects install and docs alongside validation", async () => {
    const repo = await fixture();
    const path = "skills/playbook/references/rule-groups.md";
    await writeFixture(repo, path, "before");
    await commitFixture(repo);
    await writeFixture(repo, path, "after");

    expect((await selectSuites(repo, suites)).map((suite) => suite.name)).toEqual([
      "check",
      "bun",
      "docs",
    ]);

    expect(selectPaths(suites, ["README.md"]).map((suite) => suite.name)).toEqual(["check", "bun"]);
  });

  test.each([
    "apps/docs/scripts/validate.ts",
    "apps/docs/content/docs/index.mdx",
    "apps/docs/content/docs/index.md",
    "packages/cli/src/hooks/guards.ts",
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
    await writeFixture(repo, "packages/cli/src/new.ts");

    const expected = ["bun", "check", "format", "lint", "stanza", "typecheck"];

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual(expected);
    expect(
      selectPaths(suites, ["packages/cli/src/plans/verbs.ts"])
        .map((suite) => suite.name)
        .sort(),
    ).toEqual([...expected, "dashboard"].sort());
  });

  test("an agent definition selects the Bun tests that install it and docs", () => {
    expect(selectPaths(suites, ["agents/sample.md"]).map((suite) => suite.name)).toEqual([
      "check",
      "bun",
      "docs",
    ]);
  });

  test.each([
    "skills/playbook/opencode/plugin.ts",
    "skills/coderabbit/reviewer.ts",
    "skills/greptile/reviewer.ts",
    "skills/macroscope/reviewer.ts",
  ])("%s selects its tests, typecheck and style suites", (path) => {
    expect(selectPaths(suites, [path]).map((suite) => suite.name)).toEqual([
      "check",
      "bun",
      "typecheck",
      "lint",
      "format",
      "stanza",
    ]);
  });

  test("the hub server selects the Bun and dashboard tests that boot it", () => {
    expect(selectPaths(suites, ["apps/hub/src/main.ts"]).map((suite) => suite.name)).toEqual(
      expect.arrayContaining(["bun", "dashboard"]),
    );
  });

  test.each([
    "packages/cli/src/hub/client.ts",
    "packages/cli/src/plans/verbs.ts",
    "packages/cli/src/test/hub-live.ts",
    "packages/cli/src/test/process.ts",
    "packages/cli/src/read.ts",
  ])("the dashboard tests watch the CLI code they run: %s", (path) => {
    expect(selectPaths(suites, [path]).map((suite) => suite.name)).toContain("dashboard");
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

  test.each([".oxlintrc.json", ".oxfmtrc.json"])("style suites watch %s", (path) => {
    expect(selectPaths(suites, [path]).map((suite) => suite.name)).toEqual([
      "check",
      "lint",
      "format",
      "stanza",
    ]);
  });

  test("docs code selects docs and style suites", () => {
    expect(selectPaths(suites, ["apps/docs/lib/source.ts"]).map((suite) => suite.name)).toEqual([
      "check",
      "lint",
      "format",
      "stanza",
      "docs",
    ]);
  });

  test.each(["apps/docs/content/docs/getting-started.mdx", "apps/docs/README.md"])(
    "docs markdown selects format, which oxfmt checks: %s",
    (path) => {
      expect(selectPaths(suites, [path]).map((suite) => suite.name)).toContain("format");
    },
  );

  test("docs src watch equals its transitive import closure", () => {
    const dependencies = docsImportClosure();
    const docs = suites.find((suite) => suite.name === "docs")!;

    expect(dependencies).toEqual(
      [...new Set(docs.watch.filter((path) => path.startsWith("packages/cli/src/")))].sort(),
    );

    for (const path of dependencies)
      expect(selectPaths(suites, [path]).map((suite) => suite.name)).toContain("docs");
  });

  test(".py scripts select validation without the retired installer", async () => {
    const repo = await fixture();
    await writeFixture(repo, "scripts/x.py");
    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual(["check"]);
  });

  test("a suite's own file selects its owner and validation", async () => {
    const repo = await fixture();
    await writeFixture(repo, "packages/cli/src/evals/gh-fake.test.ts", "before");
    await commitFixture(repo);
    await writeFixture(repo, "packages/cli/src/evals/gh-fake.test.ts", "after");

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

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual(["check"]);
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

    expect((await selectSuites(repo, suites)).map((suite) => suite.name).sort()).toEqual(["check"]);
  });

  test("a reviewer declaration selects the Bun tests that read it", () => {
    expect(selectPaths(suites, ["skills/new/reviewer.conf"]).map((suite) => suite.name)).toContain(
      "bun",
    );
  });

  test("stub and eval watch sets stay separate", () => {
    expect(selectPaths(suites, ["scripts/stubs/gh"]).map((suite) => suite.name)).toContain("bun");

    expect(
      selectPaths(suites, ["evals/cases/case.json"])
        .map((suite) => suite.name)
        .sort(),
    ).toEqual(["check"]);
  });
});

const source = "packages/cli/src";
const graphed = fakeSuite("bun", {
  argv: ["bun", "test"],
  files: [`${source}/**/*.test.ts`],
  watch: [`${source}/**`, "scripts/stubs/**"],
  graph: { sources: [`${source}/**/*.ts`], unimported: [`${source}/fake.ts`] },
});

async function graphFixture(helper = true): Promise<string> {
  const repo = await fixture();
  const files = {
    "used.test.ts": 'import { used } from "./used.ts";\nexport const seen = used;\n',
    "used.ts": 'import { helper } from "./helper.ts";\nexport const used = helper;\n',
    "other.test.ts": 'import { other } from "./other.ts";\nexport const seen = other;\n',
    "other.ts": "export const other = 1;\n",
    "cli.test.ts": 'export const bin = "skills/playbook/bin/skills";\n',
    "host.test.ts": 'import { host } from "./host.ts";\nexport const seen = host;\n',
    "host.ts": 'export const host = () => new Worker(new URL("./worker.ts", import.meta.url));\n',
    "worker.ts": "export const worker = 1;\n",
    "fake.ts": 'import { answer } from "./fake-answers.ts";\nexport const fake = answer;\n',
    "fake-answers.ts": "export const answer = 1;\n",
    "answers.test.ts": 'import { answer } from "./fake-answers.ts";\nexport const seen = answer;\n',
  };

  for (const [name, text] of Object.entries(files))
    await writeFixture(repo, join(source, name), text);

  if (helper) await writeFixture(repo, join(source, "helper.ts"), "export const helper = 1;\n");

  await commitFixture(repo);
  return repo;
}

async function narrowedTo(repo: string): Promise<string[] | "every test file"> {
  const [suite] = await selectSuites(repo, [graphed]);
  const files = suite!.argv.slice(graphed.argv.length);
  return files.length > 0
    ? files.map((file) => file.replace(`./${source}/`, ""))
    : "every test file";
}

function bunSuite() {
  return suites.find((suite) => suite.name === "bun")!;
}

describe("affected tests", () => {
  test("a change to one module runs the tests that import it and every process test", async () => {
    const files = await affectedTests(root, bunSuite(), [
      { path: `${source}/hub/run.ts`, deleted: false },
    ]);

    const listed = await worktreeFiles(root);
    const started = listed.filter(
      (file) =>
        file.startsWith(`${source}/`) &&
        file.endsWith(".test.ts") &&
        startsProcess(readFileSync(join(root, file), "utf8")),
    );

    expect(started.length).toBeGreaterThan(40);
    expect(files).toContain(`${source}/hub/run.test.ts`);
    expect(files).toContain(`${source}/stack/wrappers.test.ts`);
    expect(files).toEqual(expect.arrayContaining(started));
    expect(files).not.toContain(`${source}/stack/lease-rebase.test.ts`);
  });

  test("a core change reaches the CLI tests that import skills-core", async () => {
    const files = await affectedTests(root, bunSuite(), [
      { path: "packages/core/src/leases.ts", deleted: false },
    ]);

    expect(files).toContain(`${source}/hub/leases.test.ts`);
    expect(files).not.toContain(`${source}/terminal.test.ts`);
  });

  test.each([`${source}/evals/gh-fake.ts`, `${source}/evals/gh.ts`, "scripts/stubs/gh"])(
    "a change to the fake gh selects every bun test file: %s",
    async (path) => {
      expect(await affectedTests(root, bunSuite(), [{ path, deleted: false }])).toBeNull();
    },
  );

  test.each([`${source}/test/preload.ts`, `${source}/round/timestamp.ts`])(
    "a module tests load without importing it selects every bun test file: %s",
    async (path) => {
      expect(await affectedTests(root, bunSuite(), [{ path, deleted: false }])).toBeNull();
    },
  );

  test("a missing unimported module selects every test file", async () => {
    const repo = await graphFixture();
    const graph = { ...graphed.graph!, unimported: [`${source}/missing.ts`] };
    const change = { path: `${source}/other.ts`, deleted: false };

    expect(await affectedTests(repo, { ...graphed, graph }, [change])).toBeNull();
    expect(await affectedTests(repo, graphed, [change])).toEqual([
      `${source}/cli.test.ts`,
      `${source}/other.test.ts`,
    ]);
  });

  test("a root config file selects every test file", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "other.ts"), "export const other = 2;\n");
    await writeFixture(repo, "bunfig.toml", "[test]\n");

    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("an untracked new module counts as changed", async () => {
    const repo = await graphFixture(false);
    await writeFixture(repo, join(source, "helper.ts"), "export const helper = 1;\n");
    expect(await narrowedTo(repo)).toEqual(["cli.test.ts", "used.test.ts"]);
  });

  test("a changed test file runs beside the process tests", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "other.test.ts"), "export const seen = 2;\n");
    expect(await narrowedTo(repo)).toEqual(["cli.test.ts", "other.test.ts"]);
  });

  test("a module started as a worker counts as imported", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "worker.ts"), "export const worker = 2;\n");
    expect(await narrowedTo(repo)).toEqual(["cli.test.ts", "host.test.ts"]);
  });

  test("a change the fake gh imports selects every test file", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "fake-answers.ts"), "export const answer = 2;\n");
    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("a watched path outside the sources selects every test file", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "other.ts"), "export const other = 2;\n");
    await writeFixture(repo, "scripts/stubs/gh", "#!/bin/sh\n");

    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("a fixture under a watched folder selects every test file", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "other.ts"), "export const other = 2;\n");
    await writeFixture(repo, join(source, "fixture/notes.md"), "notes\n");

    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("a file a module imports from outside the watch list selects every test file", async () => {
    const repo = await graphFixture();
    const rules = 'import rules from "../../../third-party/rules.toml";\n';
    await writeFixture(repo, "third-party/rules.toml", "limit = 1\n");
    await writeFixture(repo, join(source, "other.ts"), `${rules}export const other = rules;\n`);
    await commitFixture(repo);

    await writeFixture(repo, "third-party/rules.toml", "limit = 2\n");
    await writeFixture(repo, join(source, "worker.ts"), "export const worker = 2;\n");

    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("a path no test reads does not widen the run", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "other.ts"), "export const other = 2;\n");
    await writeFixture(repo, ".tegami/2026-11-21-note.md", "note\n");
    await writeFixture(repo, "CONTRIBUTING.md", "checks\n");

    expect(await narrowedTo(repo)).toEqual(["cli.test.ts", "other.test.ts"]);
  });

  test("a deleted or renamed file selects every test file", async () => {
    const deleted = await graphFixture();
    await fixtureGit(deleted, ["rm", "-q", join(source, "other.ts")]);

    const renamed = await graphFixture();
    await fixtureGit(renamed, ["mv", join(source, "other.test.ts"), join(source, "moved.test.ts")]);

    expect(await narrowedTo(deleted)).toBe("every test file");
    expect(await narrowedTo(renamed)).toBe("every test file");
  });

  test("a changed source no test imports selects every test file", async () => {
    const repo = await graphFixture();
    await writeFixture(repo, join(source, "fixture/blob.ts"), "export const blob = 1;\n");
    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("an import that does not resolve selects every test file", async () => {
    const repo = await graphFixture(false);
    await writeFixture(repo, join(source, "other.ts"), "export const other = 2;\n");
    expect(await narrowedTo(repo)).toBe("every test file");
  });

  test("a diff with no resolved base selects every bun test file", async () => {
    const repo = await graphFixture();
    await fixtureGit(repo, ["config", "branch.main.skills-base", "missing"]);
    await writeFixture(repo, join(source, "other.ts"), "export const other = 2;\n");

    expect(await selectSuites(repo, [graphed], () => {})).toEqual([graphed]);
  });

  test("the bun row names every preload and every module a PATH stub runs", () => {
    const { test: runner } = Bun.TOML.parse(readFileSync(join(root, "bunfig.toml"), "utf8")) as {
      test: { preload: string[] };
    };

    const stubs = join(root, "scripts/stubs");
    const started = readdirSync(stubs).flatMap((name) =>
      [...readFileSync(join(stubs, name), "utf8").matchAll(/packages\/[\w/.-]+\.ts/g)].map(
        ([path]) => path,
      ),
    );

    expect(started).toContain(`${source}/evals/gh.ts`);
    expect(bunSuite().graph!.unimported).toEqual(
      expect.arrayContaining([
        ...started,
        ...runner.preload.map((path) => relative(root, resolve(root, path))),
      ]),
    );
  });
});

describe("process tests", () => {
  test.each([
    "arms.test.ts",
    "hub/enroll.test.ts",
    "release/release.test.ts",
    "evals/gh-fake.test.ts",
    "publish/publish.test.ts",
    "stack/wrappers.test.ts",
  ])("%s may start repository code as a process", (file) => {
    expect(startsProcess(readFileSync(join(root, source, file), "utf8"))).toBe(true);
  });

  test.each([
    "stack/lease-rebase.test.ts",
    "stack/restack-layer.test.ts",
    "stack/fix-round.test.ts",
    "stack/takeover.test.ts",
    "plans/stack-verbs.test.ts",
  ])("%s runs its verbs in process", (file) => {
    expect(startsProcess(readFileSync(join(root, source, file), "utf8"))).toBe(false);
  });

  test.each([
    'const bin = join(root, "playbook/bin/skills");',
    "await run(['sh', 'hooks/reply-guard.sh']);",
    "const entry = `${directory}/cli.ts`;",
    '  import { withLock } from "./lock.ts";',
    'export enum Hook {\n  Guard = "reply-guard.sh",\n}\nimport { run } from "./run.ts";',
  ])("a string that ends in a script path counts: %s", (text) => {
    expect(startsProcess(text)).toBe(true);
  });

  test.each([
    'import { stackCase } from "../test/stack-fixture.ts";',
    'import {\n  gitShim,\n  stackCase,\n} from "../test/stack-fixture.ts";',
    'import "./preload.ts";',
    'export { helper } from "./helper.ts";',
    'const hook = "#!/bin/sh\\nexit 1\\n";',
    'const notes = "packages/cli/src/notes.txt";',
  ])("import lines and other strings do not: %s", (text) => {
    expect(startsProcess(text)).toBe(false);
  });

  test("no helper exports a script path, so a test that starts one names it", () => {
    const exporting = typescriptFiles(join(root, source))
      .filter((file) => !file.endsWith(".test.ts"))
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.startsWith("export const ") && startsProcess(line))
          .map((line) => `${relative(root, file)}: ${line}`),
      );

    expect(exporting).toEqual([]);
  });
});
