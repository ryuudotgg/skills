import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { logicalPath } from "./machine.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

const repo = resolve(import.meta.dir, "../../../..");
const cli = join(repo, "packages/cli/src/cli.ts");
const fixtureScript = join(repo, "packages/cli/src/test/machine-fixture.ts");

const STUBS: Record<string, string> = {
  scutil: 'echo "Stub Mac"',
  hostname: 'echo "Stub Mac"',
  sw_vers: "echo 99.0",
  xcodebuild:
    'if [ -n "${STUB_XCODE_SLEEP-}" ]; then exec sleep "$STUB_XCODE_SLEEP"; fi\necho "Xcode 99.1"\necho "Build version 99A1"',
  adb: 'echo "Android Debug Bridge version 9.9.9"',
  docker: 'echo "Cannot connect to the Docker daemon" >&2\nexit 1',
  node: "echo v99.0.0",
};

setDefaultTimeout(20_000);

let temporary: string;
let dir: string;
let env: NodeJS.ProcessEnv;

function link(target: string, name: string): void {
  const found = Bun.which(name);
  if (!found) throw new Error(`${name} is not on PATH`);
  symlinkSync(found, join(target, name));
}

beforeEach(async () => {
  temporary = realpathSync(await mkdtemp(join(tmpdir(), "skills-machine-")));
  dir = join(temporary, "fx");

  const stubs = join(temporary, "stubs");
  const links = join(temporary, "links");
  mkdirSync(stubs);
  mkdirSync(links);

  for (const [name, body] of Object.entries(STUBS))
    writeFileSync(join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });

  for (const name of ["git", "sh", "sleep", "bun"]) link(links, name);

  const built = await runCommand([process.execPath, fixtureScript, dir, "--rows", "record"], {
    cwd: temporary,
  });

  expect(built.code).toBe(0);
  expect(built.stdout).toContain(`export PLANS_DIR=${join(dir, "plans-a")}\n`);

  env = {
    ...suiteEnvironment(),
    PLANS_DIR: join(dir, "plans-a"),
    SKILLS_CONF: join(dir, "conf"),
    HOME: join(dir, "home"),
    PATH: `${stubs}:${links}`,
    ANDROID_HOME: undefined,
    ANDROID_SDK_ROOT: undefined,
    SKILLS_AUTO_UPDATE: "0",
    AGENT_HOOKS: "1",
    CI: undefined,
  };
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function skills(args: readonly string[], extra: NodeJS.ProcessEnv = {}, cwd = dir) {
  return runCommand([process.execPath, "--no-env-file", cli, ...args], {
    cwd,
    env: { ...env, ...extra },
    timeout: 30_000,
  });
}

async function shown(cwd = dir): Promise<string> {
  const show = await skills(["machine", "show"], {}, cwd);
  expect(show.code).toBe(0);
  return show.stdout;
}

function query<T>(sql: string): T[] {
  const db = new Database(join(dir, "plans-a/plans.db"), { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}

function machineEvents(): number {
  return query<{ n: number }>("SELECT count(*) AS n FROM events WHERE type = 'machine'")[0]!.n;
}

describe("skills machine", () => {
  test("show refuses before any refresh, naming the refresh", async () => {
    const show = await skills(["machine", "show"]);

    expect(show.code).toBe(1);
    expect(show.stderr).toBe(
      "machine show: no facts for this machine yet, run skills machine refresh\n",
    );
  });

  test("refresh records the probed facts in one store event and leaves both views alone", async () => {
    expect((await skills(["plans", "log", "Demo", "001", "start", "feat/record"])).code).toBe(0);

    const index = readFileSync(join(dir, "plans-a/Demo/index.tsv"));
    const log = readFileSync(join(dir, "plans-a/log.tsv"));
    const refresh = await skills(["machine", "refresh"], {}, join(dir, "a/Demo"));

    expect(refresh.code).toBe(0);
    expect(refresh.stderr).toBe("");
    expect(refresh.stdout).toBe(await shown());
    expect(refresh.stdout).toMatch(
      new RegExp(
        [
          "^label Stub Mac",
          "device -",
          "environment -",
          `os ${process.platform} ${process.platform === "darwin" ? "99\\.0" : ".+"}`,
          `arch ${process.arch}`,
          "tool xcode Xcode 99\\.1",
          "tool android Android Debug Bridge version 9\\.9\\.9",
          "tool docker absent: docker version --format \\{\\{\\.Server\\.Version\\}\\}: exit 1, Cannot connect to the Docker daemon",
          `tool bun ${Bun.version.replaceAll(".", "\\.")}`,
          "tool node v99\\.0\\.0",
          "tool gh absent: gh not found",
          `checkout Demo ${join(dir, "a/Demo")} ${join(dir, "origin.git")}`,
          "captured \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\n$",
        ].join("\n"),
      ),
    );

    expect(readFileSync(join(dir, "plans-a/Demo/index.tsv"))).toEqual(index);
    expect(readFileSync(join(dir, "plans-a/log.tsv"))).toEqual(log);
    expect((await skills(["plans", "import"])).code).toBe(0);
    expect(readFileSync(join(dir, "plans-a/log.tsv"))).toEqual(log);
    expect(query("SELECT project, plan, legacy FROM events WHERE type = 'machine'")).toEqual([
      { project: "-", plan: "-", legacy: 0 },
    ]);

    const json = await skills(["machine", "show", "--json"]);
    const facts = JSON.parse(json.stdout);
    expect(Object.keys(facts)).toEqual([
      "label",
      "device",
      "environment",
      "os",
      "arch",
      "tools",
      "checkouts",
      "captured",
    ]);

    expect(facts.tools.bun).toEqual({ version: Bun.version });
    expect(facts.tools.gh).toEqual({ absent: true, reason: "gh not found" });
  });

  test("a tool past its deadline reads absent and the refresh still exits 0", async () => {
    const started = Date.now();
    const refresh = await skills(["machine", "refresh", "--environment", "env-1"], {
      STUB_XCODE_SLEEP: "10",
    });

    expect(refresh.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(7000);
    expect(refresh.stdout).toContain(
      "\ntool xcode absent: xcodebuild -version: no exit within 5 s\n",
    );

    expect(refresh.stdout).toContain("\nenvironment env-1\n");
  });

  test("label keeps the rest, and a refresh keeps the label and the environment", async () => {
    expect((await skills(["machine", "refresh", "--environment", "env-1"])).code).toBe(0);

    const before = await shown();
    const label = await skills(["machine", "label", "Desk Mac"]);

    expect(label.code).toBe(0);
    expect(label.stdout).toBe(before.replace("label Stub Mac\n", "label Desk Mac\n"));
    expect((await skills(["machine", "refresh"])).code).toBe(0);

    const after = await shown();
    expect(after).toStartWith("label Desk Mac\n");
    expect(after).toContain("\nenvironment env-1\n");
    expect(machineEvents()).toBe(3);
  });

  test("label before any refresh probes first", async () => {
    const label = await skills(["machine", "label", "Desk Mac"]);

    expect(label.code).toBe(0);
    expect(label.stdout).toStartWith("label Desk Mac\ndevice -\n");
    expect(machineEvents()).toBe(1);
  });

  test("a refresh drops a checkout whose path is gone", async () => {
    expect((await skills(["machine", "refresh"], {}, join(dir, "a/Demo"))).code).toBe(0);
    expect(await shown()).toContain("\ncheckout Demo ");

    rmSync(join(dir, "a"), { recursive: true });

    expect((await skills(["machine", "refresh"])).code).toBe(0);
    expect(await shown()).not.toContain("\ncheckout ");
  });

  test("refresh refuses a missing plans directory", async () => {
    const missing = join(temporary, "nowhere");
    const refresh = await skills(["machine", "refresh"], { PLANS_DIR: missing });

    expect(refresh.code).toBe(1);
    expect(refresh.stderr).toBe(`machine refresh: no plans directory at ${missing}\n`);
  });

  test("plans start records the checkout it starts in", async () => {
    expect((await skills(["machine", "refresh"])).code).toBe(0);
    expect(await shown()).not.toContain("\ncheckout ");

    const start = await skills(["plans", "start", "Demo", "001"], {}, join(dir, "a/Demo"));

    expect(start.code).toBe(0);
    expect(await shown()).toContain(
      `\ncheckout Demo ${join(dir, "a/Demo")} ${join(dir, "origin.git")}\n`,
    );
  });

  test.each([
    [["machine", "show", "--yaml"]],
    [["machine", "label"]],
    [["machine", "label", "two\tparts"]],
    [["machine", "refresh", "--environment"]],
    [["machine", "refresh", "--environment", ""]],
    [["machine", "refresh", "env-1"]],
    [["machine", "refresh", "--environment", "--json"]],
    [["machine", "label", "--json"]],
  ])("%p is a usage error", async (args) => {
    const result = await skills(args);

    expect(result.code).toBe(2);
    expect(result.stderr).toStartWith("usage: skills machine ");
    expect(machineEvents()).toBe(0);
  });
});

describe("the session start hook", () => {
  async function hook(cwd: string, extra: NodeJS.ProcessEnv = {}) {
    const started = Date.now();
    const result = await skills(["hook", "session-start"], extra, cwd);
    expect(result.code).toBe(0);

    return {
      context: JSON.parse(result.stdout).hookSpecificOutput.additionalContext as string,
      took: Date.now() - started,
    };
  }

  async function settled(count: number): Promise<void> {
    for (let waited = 0; waited < 20_000 && machineEvents() < count; waited += 100)
      await Bun.sleep(100);

    for (let waited = 0; waited < 20_000; waited += 100) {
      const lock = Bun.spawnSync(["lsof", join(dir, "plans-a/.machine.lock")]);
      if (lock.exitCode !== 0) return;
      await Bun.sleep(100);
    }
  }

  test("prints the Machine line after Branch and records a new checkout", async () => {
    expect((await skills(["machine", "label", "Desk Mac"])).code).toBe(0);

    const { context } = await hook(join(dir, "b/Demo"), { SKILLS_MACHINE_REFRESH: "0" });
    const lines = context.split("\n");

    expect(lines[lines.findIndex((line) => line.startsWith("Branch: ")) + 1]).toBe(
      "Machine: Desk Mac",
    );

    expect(await shown()).toContain(
      `\ncheckout Demo ${join(dir, "b/Demo")} ${join(dir, "origin.git")}\n`,
    );

    expect(machineEvents()).toBe(2);
    await hook(join(dir, "b/Demo"), { SKILLS_MACHINE_REFRESH: "0" });
    expect(machineEvents()).toBe(2);
  });

  test("stale facts launch one refresh across two hooks and the hook never waits on it", async () => {
    expect((await skills(["machine", "refresh"], {}, join(dir, "a/Demo"))).code).toBe(0);

    const aged = await runCommand([process.execPath, fixtureScript, dir, "--age-facts", "25"], {
      cwd: temporary,
      env: { ...suiteEnvironment(), PLANS_DIR: join(dir, "plans-a") },
    });

    expect(aged.code).toBe(0);

    const first = await hook(join(dir, "a/Demo"), { STUB_XCODE_SLEEP: "3" });
    const second = await hook(join(dir, "a/Demo"), { STUB_XCODE_SLEEP: "3" });

    expect(first.took).toBeLessThan(2000);
    expect(second.took).toBeLessThan(2000);
    await settled(2);
    expect(machineEvents()).toBe(2);
    expect(await shown()).toContain("\ntool xcode absent: xcodebuild -version: printed nothing\n");
    expect(Date.parse((await shown()).match(/\ncaptured (\S+)\n/)![1]!)).toBeGreaterThan(
      Date.parse(aged.stdout.slice("captured ".length).trim()),
    );
  });

  test("a detached HEAD prints no Machine line but still records the checkout", async () => {
    expect((await skills(["machine", "label", "Desk Mac"])).code).toBe(0);

    const detach = await runCommand(["git", "checkout", "-q", "--detach"], {
      cwd: join(dir, "b/Demo"),
      env,
    });

    expect(detach.code).toBe(0);

    const { context } = await hook(join(dir, "b/Demo"), { SKILLS_MACHINE_REFRESH: "0" });

    expect(context).not.toContain("Machine:");
    expect(await shown()).toContain(`\ncheckout Demo ${join(dir, "b/Demo")} `);
  });

  test("a store it cannot read prints no Machine line and launches nothing", async () => {
    const db = new Database(join(dir, "plans-a/plans.db"));
    db.run("PRAGMA user_version = 99");
    db.close();

    const { context } = await hook(join(dir, "a/Demo"));
    await Bun.sleep(1500);

    expect(context).not.toContain("Machine:");
    expect(existsSync(join(dir, "plans-a/.machine-refresh.json"))).toBe(false);
  });

  test("SKILLS_MACHINE_REFRESH=0 launches nothing", async () => {
    await hook(join(dir, "a/Demo"), { SKILLS_MACHINE_REFRESH: "0" });
    await Bun.sleep(1500);
    expect(machineEvents()).toBe(0);
  });
});

test("a realpath maps back through the symlinked ancestor PWD spells", () => {
  const real = join(temporary, "real");
  mkdirSync(join(real, "a/Demo"), { recursive: true });
  symlinkSync(real, join(temporary, "spelled"));

  const cwd = join(temporary, "spelled/a/Demo");
  const env = { PWD: cwd };

  expect(logicalPath(join(real, "a/Demo"), env, cwd)).toBe(cwd);
  expect(logicalPath(join(real, "b/Demo"), env, cwd)).toBe(join(temporary, "spelled/b/Demo"));
  expect(logicalPath(join(real, "a/Demo"), { PWD: "/" }, cwd)).toBe(join(real, "a/Demo"));
  expect(logicalPath("/elsewhere/Demo", env, cwd)).toBe("/elsewhere/Demo");
});
