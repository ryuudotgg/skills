import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import {
  type Category,
  categories,
  changelogSection,
  firstHeading,
  parseChange,
  versionPrBody,
} from "./notes.ts";
import { addedNotes } from "./require-note.ts";
import { openVersionPr } from "./version-pr.ts";

const script = resolve(import.meta.dir, "tegami.ts");
const checkout = resolve(import.meta.dir, "../../../..");
const fileNames = /\.tegami\/\S+|\S+\.(?:md|yaml)\b/g;
let repo: string;

type Step = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
};

function note(bump: string, body: string): string {
  return `---\npackages:\n  skills-cli: ${bump}\n---\n\n${body}`;
}

async function commit(subject: string): Promise<void> {
  await fixtureGit(repo, ["add", "-A"]);
  await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", subject]);
}

function environment(): NodeJS.ProcessEnv {
  const env = suiteEnvironment();
  for (const name of ["CI", "GITHUB_ACTIONS", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_REPOSITORY"])
    delete env[name];

  return env;
}

async function tegami(...args: string[]) {
  return runCommand(["bun", script, ...args], { cwd: repo, env: environment(), timeout: 60_000 });
}

async function head(): Promise<string> {
  return (await fixtureGit(repo, ["rev-parse", "HEAD"])).trim();
}

async function requireNote(...args: string[]) {
  return runCommand(["bun", resolve(import.meta.dir, "require-note.ts"), ...args], {
    cwd: repo,
    env: environment(),
  });
}

type Workflow = {
  on: Record<string, { branches?: string[] } | null>;
  jobs: Record<string, { needs?: string; if?: string; steps: Step[] }>;
};

function readWorkflow(workflow: string): Workflow {
  const text = readFileSync(join(checkout, ".github/workflows", workflow), "utf8");
  return Bun.YAML.parse(text) as Workflow;
}

function workflowSteps(workflow: string, job: string): Step[] {
  return readWorkflow(workflow).jobs[job]?.steps ?? [];
}

function checkoutVersion(): string {
  return JSON.parse(readFileSync(join(checkout, "package.json"), "utf8")).version;
}

async function runStep(run: string, env: Record<string, string> = {}) {
  return runCommand(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", run], {
    cwd: checkout,
    env: { ...environment(), ...env, GIT_DIR: join(repo, ".git") },
  });
}

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "skills-release-"));
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await writeFixture(
    repo,
    "package.json",
    '{\n  "name": "skills",\n  "version": "0.0.0",\n  "private": true,\n  "workspaces": ["packages/*"]\n}\n',
  );

  await writeFixture(
    repo,
    "packages/cli/package.json",
    '{\n  "name": "skills-cli",\n  "version": "0.0.0"\n}\n',
  );

  await commit("init");
});

afterEach(async () => {
  await removeTemporary(repo);
});

describe("notes", () => {
  const section = (title: string, content = "Body.", depth = 3) => ({ title, content, depth });

  test("reads the category, title and one paragraph body", () => {
    expect(
      parseChange("a.md", section("✨ Versioned releases", "Each release\n  gets a tag.")),
    ).toEqual({
      category: { emoji: "✨", title: "New" },
      title: "Versioned releases",
      body: "Each release gets a tag.",
      reference: undefined,
    });
  });

  test.each([
    [section("✨ Title", "Body.", 2), "is not a ### heading"],
    [section("Title"), "with one of"],
    [section("✨"), "with one of"],
    [section("✨ Title", "One.\n\nTwo."), "one plain paragraph"],
    [section("✨ Title", "- a list"), "one plain paragraph"],
    [section("✨ Title", "```\ncode\n```"), "one plain paragraph"],
  ])("refuses %j", (input, message) => {
    expect(() => parseChange("a.md", input)).toThrow(message);
  });

  test("ignores headings inside fences", () => {
    expect(firstHeading("```\n### not a heading\n```\n")).toBe(-1);
    expect(firstHeading("text\n### heading\n")).toBe(1);
  });
});

describe("version PR body", () => {
  const [headsUp, , improved, fixed] = categories;
  const date = new Date("2026-11-20T12:00:00Z");
  const pull = (pr: number) => `[#${pr}](https://github.com/ryuudotgg/skills/pull/${pr})`;
  const change = (category: Category, title: string, body: string, pr: number) => ({
    category,
    title,
    body,
    reference: { label: `#${pr}`, url: `https://github.com/ryuudotgg/skills/pull/${pr}` },
  });

  test("is the release section with each change and its text", () => {
    expect(
      versionPrBody(
        [
          change(fixed, "Sync keeps the cursor", "It resumes.", 57),
          change(headsUp, "Reviewers renamed", "Rename them.", 58),
        ],
        date,
      ),
    ).toBe(
      [
        "*November 20, 2026*",
        "",
        "### 🚨 Heads up",
        "",
        `- **Reviewers renamed** (${pull(58)})\\`,
        "  Rename them.",
        "",
        "### 🐛 Fixed",
        "",
        `- **Sync keeps the cursor** (${pull(57)})\\`,
        "  It resumes.",
      ].join("\n"),
    );
  });

  test("past GitHub's limit keeps the text of its first categories", () => {
    const text = (word: string) => Array(5000).fill(word).join(" ");
    const body = versionPrBody(
      [
        change(headsUp, "Set the new key", text("alpha"), 5),
        change(improved, "Sync runs faster", text("bravo"), 6),
        change(fixed, "Sync keeps the cursor", text("delta"), 7),
      ],
      date,
    );

    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65_536);
    expect(body).toContain(`- **Set the new key** (${pull(5)})\\\n  alpha`);
    expect(body).toContain(`- **Sync runs faster** (${pull(6)})\\\n  bravo`);
    expect(body.endsWith(`### 🐛 Fixed\n\n- **Sync keeps the cursor** (${pull(7)})`)).toBe(true);
  });

  test("whose titles pass GitHub's limit counts the changes it leaves out", () => {
    const title = (index: number) => `Fix ${index} ${Array(400).fill("word").join(" ")}`;
    const changes = Array.from({ length: 40 }, (_, index) =>
      change(fixed, title(index + 10), "Notes.", index + 10),
    );

    const body = versionPrBody(changes, date);
    const shown = body.split("\n").filter((line) => line.startsWith("- **Fix ")).length;

    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(65_536);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(40);
    expect(body).toContain(`- **${title(10)}** (${pull(10)})\n`);
    expect(
      body.endsWith(`\n\nAnd ${40 - shown} more in the changelog this pull request writes.`),
    ).toBe(true);
  });
});

describe("version", () => {
  test("bumps the version, writes the changelog and consumes the notes", async () => {
    await runCommand(["bun", "install", "--lockfile-only"], { cwd: repo, env: environment() });
    expect(readFileSync(join(repo, "bun.lock"), "utf8")).toContain('"version": "0.0.0"');

    await writeFixture(
      repo,
      ".tegami/2026-10-30-releases.md",
      note(
        "major",
        "### ✨ Versioned releases\n\nEach release gets a tag.\n\n### 🧰 Notes in CI\n\nCI checks them.\n",
      ),
    );

    await commit("feat: releases (#12)");
    await writeFixture(
      repo,
      ".tegami/2026-10-30-fix.md",
      note("patch", "### 🐛 A fix\n\nIt works.\n"),
    );

    await commit("fix: a thing");

    const preview = await tegami("version", "--dry-run");
    expect(preview.stdout.trim()).toBe("0.0.0 -> 1.0.0");

    const result = await tegami("version");
    expect(result.code).toBe(0);

    for (const manifest of ["package.json", "packages/cli/package.json"])
      expect(JSON.parse(readFileSync(join(repo, manifest), "utf8")).version).toBe("1.0.0");

    const lock = readFileSync(join(repo, "bun.lock"), "utf8");
    expect(lock).toContain('"name": "skills-cli",\n      "version": "1.0.0"');
    expect(lock).not.toContain("0.0.0");

    expect(existsSync(join(repo, ".tegami/2026-10-30-releases.md"))).toBe(false);
    expect(existsSync(join(repo, ".tegami/publish-lock.yaml"))).toBe(true);

    const fix = (await fixtureGit(repo, ["log", "-1", "--format=%H", "HEAD"])).trim();
    expect(changelogSection(repo, "1.0.0").replace(/^\*.+\*$/m, "*date*")).toBe(
      [
        "*date*",
        "",
        "### ✨ New",
        "",
        "- **Versioned releases** ([#12](https://github.com/ryuudotgg/skills/pull/12))\\",
        "  Each release gets a tag.",
        "",
        "### 🐛 Fixed",
        "",
        `- **A fix** ([${fix.slice(0, 7)}](https://github.com/ryuudotgg/skills/commit/${fix}))\\`,
        "  It works.",
        "",
        "### 🧰 Internal",
        "",
        "- **Notes in CI** ([#12](https://github.com/ryuudotgg/skills/pull/12))\\",
        "  CI checks them.",
      ].join("\n"),
    );
  });

  test("refuses a run with no notes and leaves the version", async () => {
    for (const args of [["version", "--dry-run"], ["version"]]) {
      const result = await tegami(...args);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("No pending notes in .tegami/");
    }

    for (const manifest of ["package.json", "packages/cli/package.json"])
      expect(JSON.parse(readFileSync(join(repo, manifest), "utf8")).version).toBe("0.0.0");
  });

  test.each([
    ["fix.md", "### 🐛 A fix\n\nIt works.\n", "name the note <date>-<topic>.md"],
    ["2026-10-30-fix.md", "A fix with no heading.\n", "it has no heading"],
    ["2026-10-30-fix.md", "## 🐛 A fix\n\nIt works.\n", "is not a ### heading"],
    [
      "2026-10-30-fix.md",
      "Read this first.\n\n### 🐛 A fix\n\nIt works.\n",
      "text above the first heading",
    ],
  ])("refuses %s holding %j", async (name, body, message) => {
    await writeFixture(repo, `.tegami/${name}`, note("patch", body));

    const result = await tegami("version", "--dry-run");
    expect(result.code).not.toBe(0);
    expect((result.stdout + result.stderr).replace(/\s*│\s*/g, " ").replace(/\s+/g, " ")).toContain(
      message,
    );
  });

  test.each([
    ["---\npackages:\n  skills-cll: patch\n---\n\n### 🐛 Typo\n\nBody.\n", "name only skills-cli"],
    [
      "---\npackages:\n  skills-cli: patch\n  other: patch\n---\n\n### 🐛 Two\n\nBody.\n",
      "name only skills-cli",
    ],
    ["### 🐛 No frontmatter\n\nBody.\n", "Tegami cannot read"],
    ["---\npackages:\n  skills-cli: huge\n---\n\n### 🐛 Bump\n\nBody.\n", "Tegami cannot read"],
  ])("refuses a bad note beside a valid one: %j", async (content, message) => {
    await writeFixture(
      repo,
      ".tegami/2026-10-30-valid.md",
      note("patch", "### 🐛 A fix\n\nIt works.\n"),
    );

    await writeFixture(repo, ".tegami/2026-10-30-bad.md", content);

    for (const args of [["version", "--dry-run"], ["version"]]) {
      const result = await tegami(...args);
      expect(result.code).not.toBe(0);
      expect(
        (result.stdout + result.stderr).replace(/\s*│\s*/g, " ").replace(/\s+/g, " "),
      ).toContain(message);
    }

    expect(existsSync(join(repo, ".tegami/2026-10-30-bad.md"))).toBe(true);
  });

  test("publish refuses to run outside CI", async () => {
    const result = await tegami("publish");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Publish outside CI");
  });
});

describe("lockstep", () => {
  async function workspace(hub: string) {
    await writeFixture(
      repo,
      "packages/hub/package.json",
      `{\n  "name": "skills-hub",\n  "version": "${hub}"\n}\n`,
    );

    await writeFixture(
      repo,
      "packages/core/package.json",
      '{\n  "name": "skills-core",\n  "version": "0.0.0"\n}\n',
    );
  }

  const version = (manifest: string) =>
    JSON.parse(readFileSync(join(repo, manifest), "utf8")).version;

  test("a note naming skills-hub releases the set at one version and one tag", async () => {
    await workspace("0.0.0");
    await writeFixture(
      repo,
      ".tegami/2026-11-07-hub.md",
      "---\npackages:\n  skills-hub: minor\n---\n\n### ✨ Hub image\n\nEach release pushes it.\n",
    );

    await commit("feat: hub image (#3)");

    expect((await tegami("version", "--dry-run")).stdout.trim()).toBe("0.0.0 -> 0.1.0");
    expect((await tegami("version")).code).toBe(0);

    for (const manifest of [
      "package.json",
      "packages/cli/package.json",
      "packages/hub/package.json",
    ])
      expect(version(manifest)).toBe("0.1.0");

    expect(version("packages/core/package.json")).toBe("0.0.0");
    expect(existsSync(join(repo, "packages/hub/CHANGELOG.md"))).toBe(false);
    expect(changelogSection(repo, "0.1.0")).toContain("**Hub image** ([#3]");

    const publish = await tegami("publish", "--dry-run");
    expect(publish.code).toBe(0);
    expect(publish.stdout.match(/^git tag .+$/gm)).toEqual(["git tag v0.1.0"]);
  });

  test("a note naming two packages of the set lands in the changelog once", async () => {
    await workspace("0.0.0");
    await writeFixture(
      repo,
      ".tegami/2026-11-07-both.md",
      "---\npackages:\n  skills-cli: patch\n  skills-hub: minor\n---\n\n### 🐛 Both\n\nBody.\n",
    );

    expect((await tegami("version")).code).toBe(0);
    expect(version("packages/hub/package.json")).toBe("0.1.0");
    expect(changelogSection(repo, "0.1.0").match(/\*\*Both\*\*/g)).toHaveLength(1);
  });

  test("refuses a note outside the set, naming the packages present", async () => {
    await workspace("0.0.0");
    await writeFixture(
      repo,
      ".tegami/2026-11-07-core.md",
      "---\npackages:\n  skills-core: minor\n---\n\n### 🧰 Core\n\nBody.\n",
    );

    const result = await tegami("version", "--dry-run");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("name only skills-cli or skills-hub in its frontmatter");
  });

  test("refuses a set without skills-cli before writing any manifest", async () => {
    await workspace("0.0.0");
    rmSync(join(repo, "packages/cli"), { recursive: true });
    await writeFixture(
      repo,
      ".tegami/2026-11-07-hub.md",
      "---\npackages:\n  skills-hub: minor\n---\n\n### ✨ Hub\n\nBody.\n",
    );

    for (const args of [["version", "--dry-run"], ["version"]]) {
      const result = await tegami(...args);
      expect(result.code).not.toBe(0);
      expect(result.stdout + result.stderr).toContain("skills-cli is not a workspace package");
    }

    expect(version("packages/hub/package.json")).toBe("0.0.0");
  });

  test("refuses a set whose versions drifted apart", async () => {
    await workspace("0.1.0");
    await writeFixture(repo, ".tegami/2026-11-07-fix.md", note("patch", "### 🐛 A fix\n\nBody.\n"));

    const result = await tegami("version", "--dry-run");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("skills-cli 0.0.0, skills-hub 0.1.0");
  });
});

describe("version PR", () => {
  type Call = { method: string; path: string; body?: Record<string, unknown> };

  function github(options: { branch?: boolean; open?: number; verified?: boolean } = {}) {
    const calls: Call[] = [];
    const fake = async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = String(url).replace("https://api.github.com/repos/ryuudotgg/skills", "");
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, path, body });

      const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
      if (path === "/git/blobs") return reply({ sha: `blob-${calls.length}` });
      if (path === "/git/trees") return reply({ sha: "tree" });
      if (path === "/git/commits") return reply({ sha: "signed" });
      if (path === "/commits/signed")
        return reply({ commit: { verification: { verified: options.verified ?? true } } });

      if (path.startsWith("/git/matching-refs/"))
        return reply(options.branch ? [{ ref: "refs/heads/tegami/version-packages" }] : []);

      if (path.startsWith("/pulls?")) return reply(options.open ? [{ number: options.open }] : []);
      return reply({ number: options.open ?? 7 });
    };

    return { calls, fetch: fake as typeof fetch };
  }

  async function prepare() {
    await writeFixture(repo, "CHANGELOG.md", "old\n");
    await writeFixture(repo, ".tegami/2026-10-30-fix.md", "note\n");
    await commit("notes");

    await writeFixture(repo, "CHANGELOG.md", "new\n");
    rmSync(join(repo, ".tegami/2026-10-30-fix.md"));
    await writeFixture(repo, ".tegami/publish-lock.yaml", "lock\n");
  }

  const options = (fake: typeof fetch) => ({
    cwd: repo,
    repo: "ryuudotgg/skills",
    token: "token",
    branch: "tegami/version-packages",
    base: "main",
    title: "chore: release 1.0.0",
    body: "notes",
    fetch: fake,
  });

  test("creates a signed commit, the branch and the PR", async () => {
    await prepare();

    const head = (await fixtureGit(repo, ["rev-parse", "HEAD"])).trim();
    const { calls, fetch } = github();
    expect(await openVersionPr(options(fetch))).toEqual({ commit: "signed", pr: 7 });

    const blobs = calls.filter((call) => call.path === "/git/blobs");
    expect(
      blobs.map((call) => Buffer.from(String(call.body?.content), "base64").toString()),
    ).toEqual(["lock\n", "new\n"]);

    const tree = calls.find((call) => call.path === "/git/trees")?.body;
    expect(tree?.tree).toEqual([
      { path: ".tegami/2026-10-30-fix.md", mode: "100644", type: "blob", sha: null },
      { path: ".tegami/publish-lock.yaml", mode: "100644", type: "blob", sha: "blob-1" },
      { path: "CHANGELOG.md", mode: "100644", type: "blob", sha: "blob-2" },
    ]);

    expect(calls.find((call) => call.path === "/git/commits")?.body).toEqual({
      message: "chore: release 1.0.0",
      tree: "tree",
      parents: [head],
    });

    expect(calls.slice(-4).map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /git/matching-refs/heads/tegami/version-packages",
      "POST /git/refs",
      "GET /pulls?head=ryuudotgg%3Ategami%2Fversion-packages&base=main&state=open",
      "POST /pulls",
    ]);
  });

  test("moves an existing branch and updates its open PR", async () => {
    await prepare();

    const { calls, fetch } = github({ branch: true, open: 41 });
    expect(await openVersionPr(options(fetch))).toEqual({ commit: "signed", pr: 41 });
    expect(
      calls.slice(-4).map(({ method, path, body }) => `${method} ${path} ${JSON.stringify(body)}`),
    ).toEqual([
      "GET /git/matching-refs/heads/tegami/version-packages undefined",
      'PATCH /git/refs/heads/tegami/version-packages {"sha":"signed","force":true}',
      "GET /pulls?head=ryuudotgg%3Ategami%2Fversion-packages&base=main&state=open undefined",
      'PATCH /pulls/41 {"title":"chore: release 1.0.0","body":"notes"}',
    ]);
  });

  test("sends an emptied file as an empty blob, not a deletion", async () => {
    await writeFixture(repo, "CHANGELOG.md", "old\n");
    await commit("changelog");

    await writeFixture(repo, "CHANGELOG.md", "");

    const { calls, fetch } = github();
    await openVersionPr(options(fetch));
    expect(calls.find((call) => call.path === "/git/blobs")?.body).toEqual({
      content: "",
      encoding: "base64",
    });

    expect(calls.find((call) => call.path === "/git/trees")?.body?.tree).toEqual([
      { path: "CHANGELOG.md", mode: "100644", type: "blob", sha: "blob-1" },
    ]);
  });

  test("refuses an unsigned commit before touching the branch", async () => {
    await prepare();

    const { calls, fetch } = github({ verified: false });
    await expect(openVersionPr(options(fetch))).rejects.toThrow("did not sign");
    expect(calls.some((call) => call.path.includes("refs"))).toBe(false);
  });
});

describe("note gate", () => {
  async function mergeChild(): Promise<void> {
    await fixtureGit(repo, ["checkout", "-q", "--detach", "main"]);
    await fixtureGit(repo, [
      "-c",
      "commit.gpgsign=false",
      "merge",
      "-q",
      "--no-ff",
      "--no-edit",
      "child",
    ]);
  }

  async function childOfSquashedParent(): Promise<void> {
    await fixtureGit(repo, ["checkout", "-q", "-b", "parent"]);
    await writeFixture(
      repo,
      ".tegami/2026-10-30-parent.md",
      note("patch", "### 🐛 Parent\n\nIt works.\n"),
    );

    await writeFixture(repo, "parent.txt", "parent\n");
    await commit("fix: parent");

    await fixtureGit(repo, ["checkout", "-q", "-b", "child"]);
    await writeFixture(repo, "child.txt", "child\n");
    await commit("fix: child");

    await fixtureGit(repo, ["checkout", "-q", "main"]);
    await fixtureGit(repo, ["merge", "-q", "--squash", "parent"]);
    await commit("fix: parent (#1)");

    await mergeChild();
  }

  async function addChildNote(): Promise<void> {
    await fixtureGit(repo, ["checkout", "-q", "child"]);
    await writeFixture(
      repo,
      ".tegami/2026-10-31-child.md",
      note("patch", "### 🐛 Child\n\nIt works.\n"),
    );

    await commit("chore: child note");
    await mergeChild();
  }

  test("counts no note of a squash merged parent", async () => {
    await childOfSquashedParent();
    expect(addedNotes(repo, "HEAD^1", "HEAD")).toEqual([]);

    await addChildNote();
    expect(addedNotes(repo, "HEAD^1", "HEAD")).toEqual([".tegami/2026-10-31-child.md"]);
  });

  test("the note step reads the merge result and its first parent", async () => {
    const steps = workflowSteps("pull-request.yml", "note");
    const gate = steps.filter(
      (step) => step.run?.includes("require-note.ts") && !step.run.includes("--pending"),
    );

    expect(gate).toHaveLength(1);
    expect(gate[0]?.run).toBe("bun packages/cli/src/release/require-note.ts HEAD^1 HEAD");
    expect(gate[0]?.if).toBe("env.VERSION_PR != 'true'");

    await childOfSquashedParent();
    const refused = await runStep(gate[0]?.run ?? "");
    expect(refused.code).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("adds no note");

    await addChildNote();
    expect(await runStep(gate[0]?.run ?? "")).toMatchObject({
      code: 0,
      stdout: ".tegami/2026-10-31-child.md\n",
    });
  });

  test("finds notes with a ### heading that the branch adds", async () => {
    const base = (await fixtureGit(repo, ["rev-parse", "HEAD"])).trim();
    await writeFixture(
      repo,
      ".tegami/2026-10-30-fix.md",
      note("patch", "### 🐛 A fix\n\nIt works.\n"),
    );

    await writeFixture(repo, ".tegami/2026-10-30-empty.md", note("patch", "No heading.\n"));
    await writeFixture(repo, "docs/note.md", "### Not a note\n");
    await commit("fix: a thing");

    expect(addedNotes(repo, base, "HEAD")).toEqual([".tegami/2026-10-30-fix.md"]);
    expect(addedNotes(repo, "HEAD", "HEAD")).toEqual([]);
  });

  test("--pending fails on pending notes and names each", async () => {
    await writeFixture(repo, ".tegami/publish-lock.yaml", "packages: {}\n");
    await writeFixture(
      repo,
      ".tegami/2026-10-30-late.md",
      note("patch", "### 🐛 A late fix\n\nIt works.\n"),
    );

    await commit("chore: release 0.0.1");

    const held = await requireNote("--pending", await head());
    expect(held.code).toBe(1);
    expect(held.stderr.match(fileNames)).toEqual([".tegami/2026-10-30-late.md"]);
    expect(held.stderr).toContain("Release workflow");

    await fixtureGit(repo, ["rm", "-q", ".tegami/2026-10-30-late.md"]);
    await commit("chore: drop the late note");

    expect(await requireNote("--pending", await head())).toMatchObject({ code: 0, stderr: "" });
  });

  test("--late warns on each pending note and passes", async () => {
    await writeFixture(repo, ".tegami/publish-lock.yaml", "packages: {}\n");
    await writeFixture(
      repo,
      ".tegami/2026-10-30-late.md",
      note("patch", "### 🐛 A late fix\n\nIt works.\n"),
    );

    await commit("chore: release 0.0.1");

    const warned = await requireNote("--late", await head());
    expect(warned.code).toBe(0);
    expect(warned.stderr).toBe("");
    expect(warned.stdout.trim().split("\n")).toHaveLength(1);
    expect(warned.stdout).toStartWith("::warning file=.tegami/2026-10-30-late.md::");

    await fixtureGit(repo, ["rm", "-q", ".tegami/2026-10-30-late.md"]);
    await commit("chore: drop the late note");

    expect(await requireNote("--late", await head())).toMatchObject({
      code: 0,
      stdout: "",
      stderr: "",
    });
  });

  test("Publish warns on late notes before the tag and the version PR refuses them", async () => {
    const publish = workflowSteps("publish.yml", "publish");
    const warn = publish.findIndex(
      (step) => step.run === "bun packages/cli/src/release/require-note.ts --late HEAD",
    );

    expect(warn).toBeGreaterThan(-1);
    expect(warn).toBeLessThan(publish.findIndex((step) => step.name === "Tag"));
    expect(publish[warn]?.if).toBeUndefined();
    expect(publish.some((step) => step.run?.includes("--pending"))).toBe(false);

    await writeFixture(repo, ".tegami/2026-10-30-late.md", note("patch", "### 🐛 Late\n\nOk.\n"));
    await commit("chore: release");

    const warned = await runStep(publish[warn]?.run ?? "");
    expect(warned.code).toBe(0);
    expect(warned.stdout).toContain("::warning file=.tegami/2026-10-30-late.md::");

    const gate = "bun packages/cli/src/release/require-note.ts --pending HEAD";
    const pullRequest = workflowSteps("pull-request.yml", "note");
    const pending = pullRequest.findIndex((step) => step.run === gate);
    expect(pullRequest[pending]?.if).toBe("env.VERSION_PR == 'true'");
    expect(pullRequest.slice(0, pending).filter((step) => step.if)).toEqual([]);

    const fetched = pullRequest.find((step) => step.uses?.startsWith("actions/checkout@"));
    expect(fetched?.with?.ref).toBeUndefined();
  });
});

describe("release workflow", () => {
  test("runs for each push to main and by hand, versioning only after the check", () => {
    const release = readWorkflow("release.yml");
    expect(release.on.push?.branches).toEqual(["main"]);
    expect(Object.keys(release.on)).toContain("workflow_dispatch");
    expect(release.jobs.version?.needs).toBe("pending");
    expect(release.jobs.version?.if).toBe(
      "github.ref == 'refs/heads/main' && needs.pending.outputs.version == 'true'",
    );
  });

  test("a push versions only a pending note on a tagged version", async () => {
    const check = workflowSteps("release.yml", "pending").find(
      (step) => step.name === "Check Notes",
    );

    const output = join(repo, ".git", "github-output");
    async function decide(event: string): Promise<string | undefined> {
      rmSync(output, { force: true });
      const result = await runStep(check?.run ?? "", {
        GITHUB_EVENT_NAME: event,
        GITHUB_OUTPUT: output,
      });

      expect(result.code).toBe(0);
      return readFileSync(output, "utf8").match(/^version=(.*)$/m)?.[1];
    }

    await writeFixture(repo, ".tegami/2026-10-30-fix.md", note("patch", "### 🐛 Fix\n\nOk.\n"));
    await commit("fix: a thing");
    expect(await decide("push")).toBe("false");
    expect(await decide("workflow_dispatch")).toBe("true");

    await fixtureGit(repo, ["tag", `v${checkoutVersion()}`]);
    expect(await decide("push")).toBe("true");

    await fixtureGit(repo, ["rm", "-q", ".tegami/2026-10-30-fix.md"]);
    await writeFixture(repo, ".tegami/publish-lock.yaml", "packages: {}\n");
    await commit("chore: release");
    expect(await decide("push")).toBe("false");
  });
});

test("the checkout's root and lockstep versions match", () => {
  const [root, ...members] = [
    "package.json",
    "packages/cli/package.json",
    "apps/hub/package.json",
    "apps/dashboard/package.json",
  ].map((manifest) => JSON.parse(readFileSync(join(checkout, manifest), "utf8")).version);

  expect(members).toEqual([root, root, root]);
});
