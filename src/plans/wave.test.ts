import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, readdir, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { COLUMNS } from "./index-tsv.ts";
import {
  normalizeHits,
  probeCommands,
  selectWave,
  splitProbeWords,
  validateProbeCommand,
  waveVerb,
} from "./wave.ts";
import { waveSettingsFrom } from "./wave-settings.ts";
import type { DeliveryConfig } from "../delivery.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
let temporary: string;
let plans: string;
let repo: string;
let conf: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-wave-"));
  plans = join(temporary, "plans");
  repo = join(temporary, "fixture");
  conf = join(temporary, "skills.conf");

  await writeFixture(temporary, "skills.conf", "DELIVERY=hands-off\n");
  await fixtureGit(temporary, ["init", "-q", "-b", "main", repo]);
  await fixtureGit(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);

  await writeFixture(repo, "shared.ts", "first second\n");
  await writeFixture(repo, "other.ts", "third\n");
});

afterEach(async () => {
  await removeTemporary(temporary);
});

function row(id: string) {
  return {
    id,
    slug: `plan-${id}`,
    status: "TODO",
    pri: "P1",
    effort: "S",
    blocked_by: "-",
    ctx: "-",
    branch: "-",
    updated: "2026-10-24",
    note: "-",
  };
}

async function fixture(
  commands: readonly (string | undefined)[],
  statuses: readonly string[] = [],
): Promise<void> {
  const rows = commands.map((_, index) => ({
    ...row(String(index + 1).padStart(3, "0")),
    status: statuses[index] ?? "TODO",
  }));

  await writeFixture(
    plans,
    "fixture/index.tsv",
    [COLUMNS.join("\t"), ...rows.map((entry) => COLUMNS.map((key) => entry[key]).join("\t"))].join(
      "\n",
    ) + "\n",
  );

  for (const [index, command] of commands.entries()) {
    if (command === undefined) continue;

    const entry = rows[index]!;
    await writeFixture(
      plans,
      `fixture/${entry.id}-${entry.slug}.md`,
      `# Plan\n\n## Probe\n\n    ${command}\n\n## Outcome\n`,
    );
  }
}

function skills(args: readonly string[], cwd = repo, env: NodeJS.ProcessEnv = {}) {
  return runCommand([bin, "plans", "wave", ...args], {
    cwd,
    env: { ...suiteEnvironment(), PLANS_DIR: plans, SKILLS_CONF: conf, ...env },
    timeout: 60_000,
  });
}

async function snapshot(): Promise<Record<string, string>> {
  const names = (await readdir(join(plans, "fixture"))).sort();
  const entries = await Promise.all(
    names.map(async (name) => [name, await readFile(join(plans, "fixture", name), "utf8")]),
  );

  return Object.fromEntries(entries);
}

describe("plans wave", () => {
  test("in-flight rows hold paths without launching or reporting failed probes", async () => {
    await fixture(
      ["rg first .", "rg second .", "rg third .", "rg missing other.ts", "rg --pre cat first ."],
      ["TODO", "DOING", "TODO", "REVIEW", "DOING"],
    );

    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "model inherit\neffort inherit\nheld 001: shares shared.ts with 002\nheld 003: shares other.ts with 004\n",
    );

    expect(result.stderr).toBe("");
  });

  test("named files count without matches while directories only add matches", async () => {
    await fixture(["rg missing shared.ts", "rg first .", "rg missing .", "rg third ."]);
    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "model inherit\neffort inherit\nlaunch 001 plan-001\nlaunch 003 plan-003\nlaunch 004 plan-004\nheld 002: shares shared.ts with 001\n",
    );
  });

  test("rejects logical OR and runs a shell comment prefix", async () => {
    await fixture(["rg first . || echo fallback", "rg -n third .  # callers"]);
    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "model inherit\neffort inherit\nlaunch 002 plan-002\nunprobed 001: unquoted shell operator ||\n",
    );
  });

  test("canonicalizes symlinks and rejects operands outside the real repository", async () => {
    await writeFixture(temporary, "outside.ts", "first\n");
    await symlink(join(repo, "shared.ts"), join(repo, "alias.ts"));
    await symlink(join(temporary, "outside.ts"), join(repo, "outside.ts"));
    await symlink(repo, join(temporary, "checkout"));
    await fixture(["rg missing alias.ts", "rg first .", "rg first outside.ts"]);

    const result = await skills(["fixture"], join(temporary, "checkout"));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "model inherit\neffort inherit\nlaunch 001 plan-001\nheld 002: shares shared.ts with 001\nunprobed 003: unsafe path outside.ts\n",
    );

    expect(normalizeHits("alias.ts\nshared.ts\noutside.ts\n", realpathSync(repo))).toEqual([
      "shared.ts",
    ]);
  });

  test("launches a disjoint frontier and leaves plans unchanged", async () => {
    await fixture(["rg -n first .", "rg -n second .", "rg -n third ."]);
    const before = await snapshot();
    const expected =
      "model inherit\neffort inherit\nlaunch 001 plan-001\nlaunch 003 plan-003\nheld 002: shares shared.ts with 001\n";

    for (const args of [["fixture", "--dry-run"], ["--dry-run", "fixture"], ["fixture"]]) {
      const result = await skills(args);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe(expected);
      expect(result.stderr).toBe("");
    }

    expect(await snapshot()).toEqual(before);
  });

  test("resolves valid model and effort settings", async () => {
    await fixture([]);
    await writeFixture(
      temporary,
      "skills.conf",
      "PLANS_WAVE_MODEL=claudeAgent/claude-opus-5-5\nPLANS_WAVE_EFFORT=medium\n",
    );

    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("model claudeAgent/claude-opus-5-5\neffort medium\n");
    expect(result.stderr).toBe("");
  });

  test("malformed and duplicate settings inherit with notes", async () => {
    await fixture([]);

    for (const content of [
      "PLANS_WAVE_MODEL=bad\nPLANS_WAVE_EFFORT=two words\n",
      "PLANS_WAVE_MODEL=a/b\nPLANS_WAVE_MODEL=c/d\nPLANS_WAVE_EFFORT=low\nPLANS_WAVE_EFFORT=high\n",
    ]) {
      await writeFixture(temporary, "skills.conf", content);
      const result = await skills(["fixture"]);
      expect(result.stdout).toBe("model inherit\neffort inherit\n");
      expect(result.stderr).toContain(`${conf}: PLANS_WAVE_MODEL`);
      expect(result.stderr).toContain(`${conf}: PLANS_WAVE_EFFORT`);
    }
  });

  test("holds unsafe or missing probes but runs a pipeline prefix", async () => {
    await fixture([
      "rg --pre cat first .",
      "rg first .; touch bad",
      "rg first /tmp",
      "rg first *.ts",
      undefined,
      "rg third . | head -1",
      "echo nope",
      "rg -e '[' .",
    ]);

    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("launch 006 plan-006\n");
    expect(result.stdout.match(/^launch /gm)).toHaveLength(1);

    for (const id of ["001", "002", "003", "004", "005", "007", "008"])
      expect(result.stdout).toContain(`unprobed ${id}:`);

    expect(result.stdout).toContain("unprobed 008: rg exited 2");
  });

  test("uses repository toplevel from a nested directory", async () => {
    await fixture(["rg third other.ts"]);
    await writeFixture(repo, "nested/empty", "");
    const result = await skills(["fixture"], join(repo, "nested"));
    expect(result.stdout).toContain("launch 001 plan-001");
  });

  test("warns when origin default is not contained in HEAD", async () => {
    await fixture([]);
    await fixtureGit(repo, ["branch", "remote-main"]);
    await fixtureGit(repo, ["switch", "-q", "remote-main"]);
    await fixtureGit(repo, [
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "next",
    ]);

    await fixtureGit(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    await fixtureGit(repo, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    ]);

    await fixtureGit(repo, ["switch", "-q", "main"]);
    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toContain("overlap was measured on a tree behind the default branch");
  });

  test("requires exactly one project and refuses a different checkout", async () => {
    for (const args of [[], ["fixture", "extra"], ["--unknown"]])
      expect((await skills(args)).code).toBe(2);

    await fixture([]);
    const result = await skills(["other"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("not a checkout of other");
  });

  test("skips the default branch check without a local symbolic ref", async () => {
    await fixture([]);
    await fixtureGit(repo, ["remote", "add", "origin", join(temporary, "missing-remote")]);
    const result = await skills(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("refuses missing indexes and missing ripgrep", async () => {
    const missing = await skills(["fixture"]);
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain("no index.tsv for fixture");

    await fixture([]);
    await writeFixture(temporary, "bin/placeholder");
    await symlink(Bun.which("git")!, join(temporary, "bin/git"));
    const errors: string[] = [];
    const code = await waveVerb(["fixture"], "skills plans wave <Project> [--dry-run]", {
      cwd: repo,
      env: {
        ...suiteEnvironment(),
        PATH: join(temporary, "bin"),
        CLAUDE_CODE_EXECPATH: undefined,
        HOME: temporary,
        PLANS_DIR: plans,
        SKILLS_CONF: conf,
      },
      capture: true,
      out: () => {},
      err: (text) => {
        errors.push(text);
      },
    });

    expect(code).toBe(1);
    expect(errors.join("")).toBe(
      "wave: rg is not on PATH and no Claude Code executable was found\n",
    );
  });

  test("uses the Claude Code executable when ripgrep is absent from PATH", async () => {
    await fixture(["rg -n first .", "rg -n second .", "rg -n third ."]);
    await writeFixture(temporary, "bin/placeholder");
    await symlink(Bun.which("git")!, join(temporary, "bin/git"));
    const output: string[] = [];
    const errors: string[] = [];
    const code = await waveVerb(["fixture"], "skills plans wave <Project> [--dry-run]", {
      cwd: repo,
      env: {
        ...suiteEnvironment(),
        PATH: join(temporary, "bin"),
        CLAUDE_CODE_EXECPATH: process.env.CLAUDE_CODE_EXECPATH ?? Bun.which("rg")!,
        PLANS_DIR: plans,
        SKILLS_CONF: conf,
      },
      capture: true,
      out: (text) => {
        output.push(text);
      },
      err: (text) => {
        errors.push(text);
      },
    });

    expect(code).toBe(0);
    expect(output.join("")).toBe(
      "model inherit\neffort inherit\nlaunch 001 plan-001\nlaunch 003 plan-003\nheld 002: shares shared.ts with 001\n",
    );

    expect(errors.join("")).toBe("");
  });

  test("tries the default Claude path after invalid explicit fallbacks", async () => {
    await fixture(["rg first ."]);
    await writeFixture(temporary, "bin/placeholder");
    await symlink(Bun.which("git")!, join(temporary, "bin/git"));
    await symlink(process.execPath, join(temporary, "bin/bun"));
    await writeFixture(temporary, ".local/bin/placeholder");
    await symlink(
      process.env.CLAUDE_CODE_EXECPATH ?? Bun.which("rg")!,
      join(temporary, ".local/bin/claude"),
    );

    await writeFixture(temporary, "not-executable", "not executable\n");
    await chmod(join(temporary, "not-executable"), 0o600);

    for (const fallback of [undefined, join(temporary, "not-executable"), temporary]) {
      const result = await skills(["fixture"], repo, {
        PATH: join(temporary, "bin"),
        HOME: temporary,
        CLAUDE_CODE_EXECPATH: fallback,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("launch 001 plan-001\n");
      expect(result.stderr).toBe("");
    }
  });

  test("ignores inherited ripgrep config", async () => {
    await fixture(["rg first .", "rg second ."]);
    await writeFixture(temporary, "ripgrep.conf", "--glob=!shared.ts\n");
    const result = await skills(["fixture"], repo, {
      RIPGREP_CONFIG_PATH: join(temporary, "ripgrep.conf"),
    });

    expect(result.stdout).toContain("launch 001 plan-001");
    expect(result.stdout).toContain("held 002: shares shared.ts with 001");
    expect(result.stdout).not.toContain("unprobed");
  });
});

describe("wave pure parts", () => {
  test("comments only start at an unquoted word boundary", () => {
    for (const command of ["rg word . # comment", "rg word . # || unsafe"])
      expect(validateProbeCommand(command)).toEqual(validateProbeCommand("rg word ."));

    for (const pattern of ["word#suffix", "'#quoted'", '"#quoted"', String.raw`\#escaped`])
      expect(validateProbeCommand(`rg ${pattern} .`).ok).toBe(true);

    expect(splitProbeWords("rg word . || echo fallback")).toEqual({
      ok: false,
      reason: "unquoted shell operator ||",
    });
  });

  test("rejects stdin as a probe path", () => {
    for (const command of ["rg word -", "rg -e word -", "rg word -- -"])
      expect(validateProbeCommand(command)).toEqual({ ok: false, reason: "unsafe path -" });
  });

  test("splits quotes and escapes and cuts at an unquoted pipe", () => {
    expect(splitProbeWords(String.raw`rg -n 'first|second' "a b" escaped\ path | head`)).toEqual({
      ok: true,
      value: [
        { value: "rg", unquotedGlob: false },
        { value: "-n", unquotedGlob: false },
        { value: "first|second", unquotedGlob: false },
        { value: "a b", unquotedGlob: false },
        { value: "escaped path", unquotedGlob: false },
      ],
    });

    expect(splitProbeWords(String.raw`rg "\bword\b" .`)).toEqual({
      ok: true,
      value: [
        { value: "rg", unquotedGlob: false },
        { value: String.raw`\bword\b`, unquotedGlob: false },
        { value: ".", unquotedGlob: false },
      ],
    });

    for (const command of [
      "rg 'oops",
      "rg x \\",
      "rg x $HOME",
      "rg x `pwd`",
      "rg x && echo",
      "rg x > out",
      "rg x < in",
      "rg x $(pwd)",
    ])
      expect(splitProbeWords(command).ok).toBe(false);
  });

  test("allows only listed rg flags and their values", () => {
    for (const flags of [
      "-in",
      "-nS",
      "-s -w -x -F -P -U -l",
      "--line-number --ignore-case --smart-case --case-sensitive --word-regexp --line-regexp --fixed-strings --pcre2 --multiline --multiline-dotall --hidden --files-with-matches",
      "-tts -Tjs -g='*.ts' --iglob '*.TS'",
      "--type=ts --type-not js --glob '*.ts'",
      "-e word",
      "--regexp=word",
      "-ne word",
    ])
      expect(validateProbeCommand(`rg ${flags} pattern .`).ok).toBe(true);

    for (const flag of [
      "--pre",
      "--hostname-bin",
      "-z",
      "-c",
      "--json",
      "--files",
      "-0",
      "--vimgrep",
      "-nc",
      "--line-number=yes",
    ])
      expect(validateProbeCommand(`rg ${flag} pattern .`).ok).toBe(false);

    for (const command of [
      "rg -e",
      "rg --type",
      "rg",
      "rg x ../out",
      "rg x a/../out",
      "rg x ~/out",
      "rg x /out",
      "rg x dir/*",
      "rg x a?",
      "rg x [ab]",
    ])
      expect(validateProbeCommand(command).ok).toBe(false);

    expect(validateProbeCommand("rg -n word")).toEqual({
      ok: true,
      value: { argv: ["rg", "--no-config", "-l", "-n", "word", "."], paths: ["."] },
    });

    expect(validateProbeCommand("rg -e word")).toEqual({
      ok: true,
      value: { argv: ["rg", "--no-config", "-l", "-e", "word", "."], paths: ["."] },
    });

    expect(validateProbeCommand("rg -- -word .").ok).toBe(true);
    expect(validateProbeCommand("rg word '*.ts'").ok).toBe(true);
  });

  test("extracts only Probe commands and normalizes contained hits", () => {
    expect(
      probeCommands(
        "## Before\n    rg no\n## Probe\n    rg yes\n```sh\nrg fenced\n```\n## After\n    rg no",
      ),
    ).toEqual(["rg yes", "rg fenced"]);

    expect(
      normalizeHits("./a.ts\nb.ts\na.ts\n../outside\n/repo/c.ts\n/elsewhere/file\n", "/repo"),
    ).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  test("held rows claim no paths and earliest launches own shared hits", () => {
    const result = selectWave([
      { row: row("001"), kind: "probed", hits: ["a", "b"] },
      { row: row("002"), kind: "probed", hits: ["a", "c"] },
      { row: row("003"), kind: "probed", hits: ["c"] },
      { row: row("004"), kind: "probed", hits: ["a", "b", "c"] },
    ]);

    expect(result.launch.map((entry) => entry.id)).toEqual(["001", "003"]);
    expect(result.held.map((entry) => [entry.row.id, entry.path, entry.owner.id])).toEqual([
      ["002", "a", "001"],
      ["004", "a", "001"],
    ]);
  });

  test("invalid or absent config inherits and invalid emits one note", () => {
    const config: DeliveryConfig = {
      mode: "hands-off",
      names: [],
      notes: ["bad config", "another problem"],
      content: "PLANS_WAVE_MODEL=a/b\nPLANS_WAVE_EFFORT=low",
      path: "/config",
      invalid: true,
    };

    expect(waveSettingsFrom(config)).toEqual({
      model: "inherit",
      effort: "inherit",
      notes: ["bad config"],
    });

    expect(waveSettingsFrom({ ...config, invalid: false, path: "" })).toEqual({
      model: "inherit",
      effort: "inherit",
      notes: [],
    });
  });
});
