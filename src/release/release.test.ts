import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { changelogSection, hasHeading, parseChange } from "./notes.ts";
import { addedNotes } from "./require-note.ts";
import { openVersionPr } from "./version-pr.ts";

const script = resolve(import.meta.dir, "tegami.ts");
let repo: string;

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

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), "skills-release-"));
  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await writeFixture(repo, "package.json", '{\n  "name": "skills-cli",\n  "version": "0.0.0"\n}\n');
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
    expect(hasHeading("```\n### not a heading\n```\n")).toBe(false);
    expect(hasHeading("text\n### heading\n")).toBe(true);
  });
});

describe("version", () => {
  test("bumps the version, writes the changelog and consumes the notes", async () => {
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
    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version).toBe("1.0.0");
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

    expect(JSON.parse(readFileSync(join(repo, "package.json"), "utf8")).version).toBe("0.0.0");
  });

  test.each([
    ["fix.md", "### 🐛 A fix\n\nIt works.\n", "name the note <date>-<topic>.md"],
    ["2026-10-30-fix.md", "A fix with no heading.\n", "it has no heading"],
    ["2026-10-30-fix.md", "## 🐛 A fix\n\nIt works.\n", "is not a ### heading"],
  ])("refuses %s holding %j", async (name, body, message) => {
    await writeFixture(repo, `.tegami/${name}`, note("patch", body));

    const result = await tegami("version", "--dry-run");
    expect(result.code).not.toBe(0);
    expect((result.stdout + result.stderr).replace(/\s*│\s*/g, " ").replace(/\s+/g, " ")).toContain(
      message,
    );
  });

  test("publish refuses to run outside CI", async () => {
    const result = await tegami("publish");
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Publish outside CI");
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

  test("refuses an unsigned commit before touching the branch", async () => {
    await prepare();

    const { calls, fetch } = github({ verified: false });
    await expect(openVersionPr(options(fetch))).rejects.toThrow("did not sign");
    expect(calls.some((call) => call.path.includes("refs"))).toBe(false);
  });
});

describe("note gate", () => {
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
});
