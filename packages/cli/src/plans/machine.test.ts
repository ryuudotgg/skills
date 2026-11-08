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

describe("plan needs", () => {
  const demo = () => join(dir, "a/Demo");
  const plan = () => join(dir, "plans-a/Demo/001-needs-check.md");
  function needs(line: string | undefined): void {
    const text = readFileSync(plan(), "utf8").replace(/^needs:.*\n/m, "");
    const added = line === undefined ? "" : `${line}\n`;
    writeFileSync(plan(), text.replace("critical: false\n", `critical: false\n${added}`));
  }

  async function device(label: string, caps: string) {
    const added = await runCommand(
      [process.execPath, fixtureScript, dir, "--device", label, "--caps", caps],
      { cwd: temporary, env: { ...process.env, PLANS_DIR: join(dir, "plans-a") } },
    );

    expect(added.code).toBe(0);
    return added.stdout;
  }

  async function branches(): Promise<string> {
    return (await runCommand(["git", "branch", "--list"], { cwd: demo(), env })).stdout;
  }

  beforeEach(async () => {
    const rebuilt = await runCommand(
      [process.execPath, fixtureScript, dir, "--rows", "needs-check,plain"],
      { cwd: temporary },
    );

    expect(rebuilt.code).toBe(0);
    link(join(temporary, "links"), "rg");
  });

  test("lint names an unknown capability and accepts the set", async () => {
    needs("needs: docker, xcode");
    expect(await skills(["plans", "lint", "Demo", "001"])).toMatchObject({
      code: 0,
      stdout: "ok\n",
    });

    needs("needs: docker, teapot, kettle");
    const lint = await skills(["plans", "lint", "Demo", "001"]);

    expect(lint.code).toBe(1);
    expect(lint.stdout).toBe(
      [
        '001-needs-check.md: needs: unknown capability "teapot", one of macos, linux, xcode, android, docker, node',
        '001-needs-check.md: needs: unknown capability "kettle", one of macos, linux, xcode, android, docker, node',
        "2 error(s)\n",
      ].join("\n"),
    );
  });

  test("a plan this machine does not meet shows its needs, is skipped by --next and refused by start and wave", async () => {
    expect((await skills(["machine", "refresh"], {}, demo())).code).toBe(0);
    needs("needs: docker,xcode, docker");

    const frontier = await skills(["plans", "frontier", "Demo"]);
    expect(frontier.stdout).toBe(
      [
        "READY 2",
        "001  P2  S   needs-check                        -  needs docker,xcode",
        "002  P2  S   plain                              -",
        "",
      ].join("\n"),
    );

    expect((await skills(["plans", "frontier", "--next", "Demo"])).stdout).toBe("002\n");

    const start = await skills(["plans", "start", "Demo", "001"], {}, demo());
    expect(start.code).toBe(1);
    expect(start.stderr).toBe(
      "stack-base: 001 needs docker, this machine lacks it; no known machine has it\n",
    );

    expect(await branches()).toBe("* main\n");
    expect((await skills(["plans", "frontier", "Demo"])).stdout).toBe(frontier.stdout);

    const wave = await skills(["plans", "wave", "Demo", "--dry-run"], {}, demo());
    expect(wave.code).toBe(0);
    expect(wave.stdout).toBe(
      [
        "model inherit",
        "effort inherit",
        "launch 002 plain",
        "held 001: needs docker, no known machine has it",
        "",
      ].join("\n"),
    );
  });

  test("run on names each other machine that meets the needs, and a rerun keeps one device", async () => {
    expect((await skills(["machine", "refresh"], {}, demo())).code).toBe(0);
    needs("needs: docker");

    const first = await device("Other", "docker,node");
    expect(await device("Other", "docker")).toBe(first);
    expect(await device("Spare", "macos,docker")).not.toBe(first);
    await device("Linux Box", "linux");

    await device("Retired", "docker");
    await device("Retired", "node");

    const start = await skills(["plans", "start", "Demo", "001"], {}, demo());
    expect(start.stderr).toBe(
      "stack-base: 001 needs docker, this machine lacks it; run on Other, Spare\n",
    );

    const wave = await skills(["plans", "wave", "Demo", "--dry-run"], {}, demo());
    expect(wave.stdout).toContain("\nheld 001: needs docker, run on Other, Spare\n");
    expect((await skills(["plans", "start", "Demo", "002"], {}, demo())).code).toBe(0);
  });

  test("a plan this machine meets starts, and a hand edit counts on the next verb", async () => {
    expect((await skills(["machine", "refresh"], {}, demo())).code).toBe(0);
    needs("needs: docker");
    expect((await skills(["plans", "start", "Demo", "001"], {}, demo())).code).toBe(1);

    needs("needs: xcode, node");
    const start = await skills(["plans", "start", "Demo", "001"], {}, demo());

    expect(start.code).toBe(0);
    expect(start.stdout).toContain("\n001\tneeds-check\tDOING\t");
  });

  test("a TODO row resumed on its cut branch is still held to its needs", async () => {
    expect((await skills(["machine", "refresh"], {}, demo())).code).toBe(0);
    needs("needs: xcode");

    const started = await skills(["plans", "start", "Demo", "001"], {}, demo());
    expect(started.code).toBe(0);
    expect((await skills(["plans", "set-row", "Demo", "001", "TODO"])).code).toBe(0);

    needs("needs: docker");
    const resumed = await skills(["plans", "start", "Demo", "001"], {}, demo());

    expect(resumed.code).toBe(1);
    expect(resumed.stderr).toBe(
      "stack-base: 001 needs docker, this machine lacks it; no known machine has it\n",
    );
  });

  test("start before any refresh names the refresh", async () => {
    needs("needs: xcode");
    const start = await skills(["plans", "start", "Demo", "001"], {}, demo());

    expect(start.code).toBe(1);
    expect(start.stderr).toBe(
      "stack-base: 001 needs xcode, this machine has no facts yet, run skills machine refresh; no known machine has it\n",
    );
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

  test("a linked worktree named after its own project records itself, not the main checkout", async () => {
    expect((await skills(["machine", "refresh"])).code).toBe(0);
    mkdirSync(join(dir, "plans-a/Linked"));
    writeFileSync(
      join(dir, "plans-a/Linked/index.tsv"),
      readFileSync(join(dir, "plans-a/Demo/index.tsv"), "utf8").split("\n")[0] + "\n",
    );

    const linked = join(dir, "wt/Linked");
    const added = await runCommand(["git", "worktree", "add", "-q", "-b", "linked", linked], {
      cwd: join(dir, "a/Demo"),
      env,
    });

    expect(added.code).toBe(0);
    await hook(linked, { SKILLS_MACHINE_REFRESH: "0" });

    const facts = await shown();
    expect(facts).toContain(`\ncheckout Linked ${linked} ${join(dir, "origin.git")}\n`);
    expect(facts).not.toContain(`\ncheckout Demo ${linked} `);
  });

  test("a linked worktree with no project of its own records the main checkout", async () => {
    expect((await skills(["machine", "refresh"])).code).toBe(0);

    const linked = join(dir, "wt/t3-plans-001");
    const added = await runCommand(["git", "worktree", "add", "-q", "-b", "other", linked], {
      cwd: join(dir, "a/Demo"),
      env,
    });

    expect(added.code).toBe(0);
    await hook(linked, { SKILLS_MACHINE_REFRESH: "0" });
    expect(await shown()).toContain(`\ncheckout Demo ${join(dir, "a/Demo")} `);
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
