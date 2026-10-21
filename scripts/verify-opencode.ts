import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
const command = ["git", "push", "--force", "origin", "main"].join(" ");
const model = process.argv[2] || process.env.OPENCODE_MODEL || "opencode-go/glm-5.3-flash";
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) => !name.startsWith("GIT_") && !name.startsWith("OPENCODE_"),
  ),
);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function run(executable: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${executable} failed: ${result.stderr}`);
  return result.stdout;
}

function install(home: string, config: string): NodeJS.ProcessEnv {
  const env = {
    ...inherited,
    HOME: home,
    AGENTS_DIR: join(home, ".agents/skills"),
    SKILLS_CONF: join(home, "skills.conf"),
    CLAUDE_HOME: join(home, ".claude"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    SEED_DIRS: join(home, "seed"),
    EXTRA_DIRS: join(home, "extra"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG_DIR: config,
    CI: "1",
  };

  mkdirSync(config, { recursive: true });
  writeFileSync(env.SKILLS_CONF, "DELIVERY=prs\n");
  console.log(run("/bin/sh", [join(repo, "install.sh")], repo, env).trim());
  assert(existsSync(join(config, "plugins/skills.ts")), "installer did not write the plugin");
  assert(existsSync(join(config, ".skills-install.json")), "installer did not write the manifest");

  return env;
}

function refused(stdout: string, reason: string): boolean {
  return stdout.split("\n").some((line) => {
    try {
      const event = record(JSON.parse(line));
      const part = record(event.part);
      const state = record(part.state);
      return (
        event.type === "tool_use" &&
        part.tool === "shell" &&
        state.status === "error" &&
        record(state.input).command === command &&
        typeof state.error === "string" &&
        state.error.includes(reason)
      );
    } catch {
      return false;
    }
  });
}

const commentedSource = "const counter = 0;\n// increment the counter\n";

function warned(stdout: string): boolean {
  return stdout.split("\n").some((line) => {
    try {
      const part = record(record(JSON.parse(line)).part);
      const state = record(part.state);
      return (
        part.tool === "write" &&
        state.status === "completed" &&
        JSON.stringify(state).includes("comment line added")
      );
    } catch {
      return false;
    }
  });
}

function report(ok: boolean, message: string): void {
  console.log(`${ok ? "PASS" : "FAIL"} ${message}`);
  if (!ok) process.exitCode = 1;
}

function verify(): void {
  assert(!process.env.CI, "Run this paid verification by hand, never in CI");
  assert(
    /^(?:opencode )?v?2\./.test(run("opencode", ["--version"], repo, inherited).trim()),
    "OpenCode v2 required",
  );

  const temporary = mkdtempSync(join(tmpdir(), "skills-verify-opencode-"));
  const home = join(temporary, "home");
  const config = join(home, ".config/opencode");
  const directory = join(temporary, "repo");
  const remote = join(temporary, "origin.git");

  console.log(`Verification files: ${temporary}`);
  const installed = install(home, config);

  const env: NodeJS.ProcessEnv = {
    ...installed,
    HOME: process.env.HOME,
    AGENT_HOOKS: "1",
    AGENT_HOOKS_SKIP: "",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Guard verification",
    GIT_AUTHOR_EMAIL: "guard@example.invalid",
    GIT_COMMITTER_NAME: "Guard verification",
    GIT_COMMITTER_EMAIL: "guard@example.invalid",
  };

  mkdirSync(directory);
  const fixtureCommand = (args: string[]) => run("git", args, directory, env);
  fixtureCommand(["init", "--quiet", "-b", "main"]);
  fixtureCommand([
    "-c",
    "core.hooksPath=/dev/null",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);

  fixtureCommand(["init", "--bare", "--quiet", remote]);
  fixtureCommand(["remote", "add", "origin", remote]);
  const refs = () =>
    fixtureCommand(["--git-dir", remote, "for-each-ref", "--format=%(refname) %(objectname)"]);

  const before = refs();

  const payload = { tool_name: "Bash", tool_input: { command }, cwd: directory };
  const expected = spawnSync(
    join(installed.AGENTS_DIR!, "playbook/bin/skills"),
    ["hook", "pre-tool-use"],
    {
      cwd: directory,
      env,
      input: JSON.stringify(payload),
      encoding: "utf8",
      timeout: 30_000,
    },
  );

  assert(!expected.error && !expected.signal, "could not read the commit guard verdict");
  const verdict = record(record(JSON.parse(expected.stdout)).hookSpecificOutput);
  assert(verdict.permissionDecision === "deny", "expected the commit guard to deny");
  assert(
    typeof verdict.permissionDecisionReason === "string" &&
      verdict.permissionDecisionReason.length > 0,
  );

  const prompt = [
    `Call the shell tool once with this exact command: ${command}`,
    "This is a guard verification against a disposable local bare repository.",
    "Do not inspect or change config, use other tools, rewrite the command, or retry a denial.",
    "After that call, stop.",
  ].join("\n");

  const result = spawnSync(
    "opencode",
    ["run", "--standalone", "--auto", "--format", "json", "-m", model, prompt],
    {
      cwd: directory,
      env,
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  writeFileSync(join(temporary, "opencode.stdout.jsonl"), result.stdout ?? "");
  writeFileSync(join(temporary, "opencode.stderr.log"), result.stderr ?? "");
  const denied = refused(result.stdout ?? "", verdict.permissionDecisionReason);
  report(denied, "plugin loaded and returned the CLI guard reason");
  report(
    denied && result.status === 0 && !result.error,
    "shell call refused with the commit guard's reason",
  );

  report(refs() === before, "bare remote refs unchanged");
  if (result.error) console.error(result.error.message);

  const written = spawnSync(
    "opencode",
    [
      "run",
      "--standalone",
      "--auto",
      "--format",
      "json",
      "-m",
      model,
      [
        `Call the write tool once to create src/a.ts with exactly these two lines: ${JSON.stringify(commentedSource)}`,
        "This is a guard verification in a disposable repository.",
        "Do not use other tools, rewrite the content, or retry. After that call, stop.",
      ].join("\n"),
    ],
    { cwd: directory, env, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );

  writeFileSync(join(temporary, "opencode.write.stdout.jsonl"), written.stdout ?? "");
  report(
    warned(written.stdout ?? ""),
    "write result carried the comment guard's reason back to the model",
  );
}

try {
  verify();
} catch (error) {
  report(false, error instanceof Error ? error.message : String(error));
}
