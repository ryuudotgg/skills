import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { areas } from "./cli.ts";
import * as read from "./read.ts";
import { fixture as roundFixture } from "./round/fixtures.ts";
import { readFixes } from "./round/fixes.ts";
import type { ReadRunner } from "./round/types.ts";
import { commitFixture, fixtureGit, writeFixture } from "./test/fixtures.ts";
import { runCommand, startCommand, suiteEnvironment, type CommandResult } from "./test/process.ts";

const checkout = resolve(import.meta.dir, "../../..");
const bin = join(checkout, "skills/playbook/bin/skills");
const directories: string[] = [];

afterEach(() => {
  mock.restore();

  for (const directory of directories.splice(0)) {
    try {
      for (const pid of readFileSync(join(directory, "holders"), "utf8").trim().split("\n"))
        try {
          process.kill(Number(pid), "SIGKILL");
        } catch {}
    } catch {}

    rmSync(directory, { recursive: true, force: true });
  }
});

function setup() {
  const value = roundFixture(["greptile"]);
  directories.push(value.temporary);

  const shim = join(value.temporary, "bin");
  const stubs = join(value.temporary, "gh");
  mkdirSync(shim);
  mkdirSync(stubs);
  writeFileSync(join(stubs, "api_graphql.prefix"), '{"data":{}}\n');

  const originalPath = `${checkout}/scripts/stubs:${process.env.PATH ?? ""}`;
  for (const name of ["git", "gh", "codex"]) {
    const real = Bun.which(name, { PATH: originalPath });
    const script = join(shim, name);
    writeFileSync(
      script,
      `#!/bin/sh\nsleep 60 &\necho $! >> "$READ_HOLDERS"\n${real ? `exec "${real}" "$@"` : "exit 0"}\n`,
    );

    chmodSync(script, 0o755);
  }

  return {
    ...value,
    env: {
      ...suiteEnvironment(),
      PATH: `${shim}:${originalPath}`,
      SKILLS_CONF: value.conf,
      PLANS_DIR: join(value.temporary, "plans"),
      GH_STUB_DIR: stubs,
      READ_HOLDERS: join(value.temporary, "holders"),
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      AGENT_HOOKS: "1",
    },
  };
}

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "read-faults-"));
  directories.push(directory);
  return directory;
}

function holdReads() {
  return spyOn(read, "readSync").mockImplementation((argv) => ({
    ok: false,
    failure: { kind: "held", read: argv.join(" ") },
    stderr: "",
  }));
}

function freshModule<Module>(path: string): Promise<Module> {
  return import(`${path}?${crypto.randomUUID()}`);
}

function bounded(result: CommandResult, started: number, label: string): void {
  expect(result.timedOut).toBe(false);
  expect(performance.now() - started).toBeLessThan(15_000);
  expect(result.stdout + result.stderr).toContain(label + ": a child process kept its output open");
}

for (const [args, label] of [
  [["round", "gate", "18"], "gh api graphql -F"],
  [["review", "read", "18"], "gh api repos/{owner}/{repo}/pulls/18/comments?p --paginate"],
  [
    ["pr", "watch", "--status-only", "--owner", "o", "--repo", "r", "--pr", "1"],
    "gh api graphql -f",
  ],
] as const)
  test(`${args.join(" ")} refuses a held read before 15 seconds`, async () => {
    const value = setup();
    const started = performance.now();
    const result = await runCommand([bin, "--root", value.root, ...args], {
      cwd: value.temporary,
      env: value.env,
      timeout: 15_000,
    });

    bounded(result, started, label);

    expect(result.code).not.toBe(0);
    if (args[0] === "round") expect(result.stdout).toBe("");
  }, 20_000);

test("plans below names the failed checkout read before 15 seconds", async () => {
  const value = setup();
  const cwd = join(value.temporary, "fixture");
  mkdirSync(cwd);
  await fixtureGit(cwd, ["init", "-q", "-b", "main"]);
  await commitFixture(cwd);

  await fixtureGit(cwd, ["branch", "feat/a"]);
  await fixtureGit(cwd, ["config", "branch.feat/a.skills-base", "main"]);
  await writeFixture(
    value.temporary,
    "plans/fixture/index.tsv",
    "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n1\ta\tREVIEW\tP1\tS\t-\t-\tfeat/a\t2026-09-26\t-\n",
  );

  const started = performance.now();
  const result = await runCommand(
    [bin, "--root", value.root, "plans", "below", "fixture", "feat/a"],
    {
      cwd,
      env: value.env,
      timeout: 15_000,
    },
  );

  bounded(result, started, "git rev-parse --path-format=absolute --show-toplevel");
  expect(result.code).not.toBe(0);
}, 20_000);

test("Stop stops tree reads at the first failure and still checks the reply", async () => {
  const value = setup();
  await fixtureGit(value.temporary, ["init", "-q"]);
  await commitFixture(value.temporary);
  const started = performance.now();
  const running = startCommand([bin, "hook", "stop"], {
    cwd: value.temporary,
    env: value.env,
    input: true,
    timeout: 15_000,
  });

  running.child.stdin!.end(
    JSON.stringify({
      cwd: value.temporary,
      scratchpad_dir: value.temporary,
      session_id: "fault",
      last_assistant_message: "Certainly!",
    }),
  );

  const result = await running.result;
  bounded(result, started, "git rev-parse --show-toplevel");
  expect(result.stdout).toContain("chatbot filler");
  expect(readFileSync(value.env.READ_HOLDERS, "utf8").trim().split("\n")).toHaveLength(1);
}, 20_000);

test("skills check reports one codex help failure instead of unknown flags", async () => {
  const root = scratch();
  await writeFixture(
    root,
    "skills/fault/SKILL.md",
    "---\nname: fault\ndescription: Read fault fixture.\n---\n\n```\ncodex exec --read-fault-invalid --read-fault-other\ncodex review --read-fault-third\n```\n",
  );

  const stubs = join(root, "stubs");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "codex"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(stubs, "codex"), 0o755);

  const path = process.env.PATH;
  process.env.PATH = `${stubs}:${path ?? ""}`;
  try {
    const reads = holdReads();
    const { check } = await freshModule<typeof import("./check/check.ts")>("./check/check.ts");
    const output = check(root, { verbs: areas.flatMap((area) => area.verbs) }).join("\n");

    expect(output).toContain("codex exec --help: a child process kept its output open");
    expect(output.match(/codex .*?: a child process kept its output open/g)).toHaveLength(1);
    expect(output).not.toContain("does not accept --read-fault");
    expect(reads).toHaveBeenCalledTimes(1);
  } finally {
    process.env.PATH = path;
  }
});

for (const [step, label] of [
  [0, "git show-ref --verify --quiet"],
  [3, "git rev-parse --verify origin/HEAD^{commit}"],
  [4, "git config branch.topic.skills-base"],
  [5, "git rev-parse --verify oid^{commit}"],
] as const)
  test(`fix facts retain typed failure from ${label}`, async () => {
    let index = 0;
    const git: ReadRunner = async () =>
      index++ === step
        ? {
            code: -1,
            stdout: "",
            stderr: "",
            failure: { kind: "deadline", read: label, deadline: 10_000 },
          }
        : { code: 0, stdout: "oid", stderr: "" };

    await expect(readFixes("reviewed", "topic", git)).rejects.toThrow(
      `fix-facts: ${label}: no exit within 10 s`,
    );

    expect(index).toBe(step + 1);
  });

test("PostToolUse keeps the dash check, skips the comment check after a failed HEAD read and pays once per process", async () => {
  const cwd = scratch();
  await fixtureGit(cwd, ["init", "-q"]);

  const paths = [join(cwd, "first.ts"), join(cwd, "second.ts")];
  for (const path of paths) writeFileSync(path, '// narration\nconst message = "before";\n');
  await commitFixture(cwd);

  for (const path of paths)
    writeFileSync(path, '// narration\nconst message = "after\u2014change";\n');

  const reads = holdReads();
  const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
  const { verdict } = await freshModule<typeof import("./hooks/post-tool-use.ts")>(
    "./hooks/post-tool-use.ts",
  );

  const env = { ...suiteEnvironment(), AGENT_HOOKS: "1" };
  const reasons = paths.map(
    (path) => verdict({ tool_name: "Write", tool_input: { file_path: path } }, env)?.reason,
  );

  expect(stderr).toHaveBeenCalledWith(
    "git show HEAD:./first.ts: a child process kept its output open\n",
  );

  expect(reasons).toHaveLength(2);

  for (const reason of reasons) {
    expect(reason).toContain("No em dashes");
    expect(reason).not.toContain("narration");
  }

  expect(reads).toHaveBeenCalledTimes(1);
});
