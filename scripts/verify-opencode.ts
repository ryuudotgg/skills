import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
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

function run(
  executable: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeout = 300_000,
) {
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    timeout,
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
    EXTRA_DIRS: join(config, "skills"),
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_CONFIG_DIR: config,
    CI: "1",
  };

  mkdirSync(join(config, "skills"), { recursive: true });
  writeFileSync(env.SKILLS_CONF, "DELIVERY=prs\nAGENT_RULES=deny\n");
  console.log(run("/bin/sh", [join(repo, "install.sh")], repo, env).trim());
  assert(existsSync(join(config, "plugins/skills.ts")), "installer did not write the plugin");
  assert(existsSync(join(config, ".skills-install.json")), "installer did not write the manifest");
  assert(
    existsSync(join(config, "commands/plans.md")),
    "installer did not write the plans command",
  );

  return env;
}

function refused(stdout: string, reason: string, expectedCommand = command): boolean {
  return stdout.split("\n").some((line) => {
    try {
      const event = record(JSON.parse(line));
      const part = record(event.part);
      const state = record(part.state);
      return (
        event.type === "tool_use" &&
        part.tool === "shell" &&
        state.status === "error" &&
        record(state.input).command === expectedCommand &&
        typeof state.error === "string" &&
        state.error.includes(reason)
      );
    } catch {
      return false;
    }
  });
}

function completedShell(stdout: string, command: string): boolean {
  return stdout.split("\n").some((line) => {
    try {
      const event = record(JSON.parse(line));
      const part = record(event.part);
      const state = record(part.state);
      return (
        event.type === "tool_use" &&
        part.tool === "shell" &&
        state.status === "completed" &&
        record(state.input).command === command
      );
    } catch {
      return false;
    }
  });
}

function shellRun(command: string, directory: string, env: NodeJS.ProcessEnv) {
  const prompt = [
    `Call the shell tool once with this exact command: ${command}`,
    "This is a permissions verification in a disposable repository with a local bare remote.",
    "Do not inspect or change config, use other tools, rewrite the command, or retry a denial.",
    "After that call, stop.",
  ].join("\n");

  return spawnSync(
    "opencode",
    ["run", "--standalone", "--auto", "--format", "json", "-m", model, prompt],
    { cwd: directory, env, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 },
  );
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

async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });

  const address = listener.address();
  assert(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    listener.close((error) => (error ? reject(error) : resolve()));
  });

  return address.port;
}

async function verifyAgents(installed: NodeJS.ProcessEnv): Promise<void> {
  const port = await freePort();

  let agents: Record<string, unknown>[] = [];
  try {
    run("opencode", ["service", "set", "port", String(port)], repo, installed, 10_000);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const value: unknown = JSON.parse(
          run(
            "opencode",
            ["debug", "agents"],
            repo,
            installed,
            Math.max(1, Math.min(3_000, deadline - Date.now())),
          ),
        );

        if (Array.isArray(value)) agents = value.map(record);
      } catch {
        agents = [];
      }

      if (agentNames.every((name) => agents.some((agent) => agent.id === name))) break;

      await Bun.sleep(Math.min(500, Math.max(0, deadline - Date.now())));
    }

    for (const name of agentNames)
      report(
        agents.some((agent) => agent.id === name && agent.mode === "subagent"),
        `${name} is listed as a subagent`,
      );

    const permissions = agents.find((agent) => agent.id === "comment-sicko")?.permissions;

    let effect: unknown;
    if (Array.isArray(permissions))
      for (const value of permissions) {
        const rule = record(value);
        if ((rule.action === "*" || rule.action === "edit") && rule.resource === "*")
          effect = rule.effect;
      }

    report(effect === "deny", "comment-sicko permissions deny edit by last match");
  } finally {
    try {
      run("opencode", ["service", "stop"], repo, installed, 10_000);
    } catch (error) {
      report(false, `scratch OpenCode service stopped: ${String(error)}`);
    }
  }
}

const agentNames = ["comment-sicko", "fable-judgment", "opus-review", "playbook-agent"];

type Message = {
  type: string;
  text?: string;
  time?: { completed?: number };
  outcome?: string;
  content?: { type: string; text?: string }[];
};

function replyText(message: Message): string {
  return (message.content ?? [])
    .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
    .join("\n");
}

async function server(directory: string, env: NodeJS.ProcessEnv) {
  const password = randomBytes(24).toString("base64url");
  const child = spawn("opencode", ["serve", "--stdio", "--port", "0"], {
    cwd: directory,
    env: { ...env, OPENCODE_PASSWORD: password },
    stdio: ["pipe", "pipe", "ignore"],
  });

  const stop = () => {
    child.stdin.end();
    setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
  };

  try {
    const first = await new Promise<string>((accept, reject) => {
      setTimeout(() => reject(new Error("opencode serve printed no URL in 60s")), 60_000).unref();
      createInterface({ input: child.stdout }).once("line", accept);
      child.once("error", reject);
      child.once("exit", () => reject(new Error("opencode serve exited before it was ready")));
    });

    const url = String(record(JSON.parse(first)).url).replace(/\/$/, "");
    const authorization = "Basic " + Buffer.from(`opencode:${password}`).toString("base64");

    return {
      async call(method: string, path: string, body?: unknown): Promise<unknown> {
        const response = await fetch(url + path, {
          method,
          headers: { authorization, "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(60_000),
        });

        if (!response.ok)
          throw new Error(`${method} ${path}: ${response.status} ${await response.text()}`);

        if (response.status === 204) return undefined;

        return record(await response.json()).data;
      },
      stop,
    };
  } catch (error) {
    stop();
    throw error;
  }
}

async function verifyReplyGuard(temporary: string, env: NodeJS.ProcessEnv): Promise<void> {
  const branch = `verify-brief-${randomBytes(4).toString("hex")}`;
  const directory = join(temporary, "brief");
  mkdirSync(directory);
  run("git", ["init", "--quiet", "-b", branch], directory, env);
  run(
    "git",
    ["-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", "fixture"],
    directory,
    env,
  );

  const [providerID, rest] = [
    model.slice(0, model.indexOf("/")),
    model.slice(model.indexOf("/") + 1),
  ];

  const [id, variant] = rest.split("#");
  const opencode = await server(directory, { ...env, PWD: directory });
  try {
    const session = record(
      await opencode.call("POST", "/api/session", {
        model: { providerID, id, ...(variant ? { variant } : {}) },
        location: { directory },
      }),
    );

    await opencode.call("POST", `/api/session/${session.id}/prompt`, {
      text: [
        "Your system context holds a line that starts with Branch:.",
        "Reply with exactly one line and use no tools: the branch name that line names,",
        "then a space, an em dash (\u2014), a space, and the word ready.",
      ].join("\n"),
    });

    const guard = (message: Message) =>
      message.type === "user" && message.text?.includes("dash used as punctuation") === true;

    let messages: Message[] = [];
    let previous = "";
    let settled = false;
    for (const deadline = Date.now() + 300_000; !settled && Date.now() < deadline;) {
      await Bun.sleep(5_000);
      messages = (await opencode.call("GET", `/api/session/${session.id}/context`)) as Message[];

      const snapshot = JSON.stringify(messages);
      settled = messages.at(-1)?.type === "idle" && messages.some(guard) && snapshot === previous;
      previous = snapshot;
    }

    writeFileSync(
      join(temporary, "opencode.brief.context.json"),
      JSON.stringify(messages, null, 2),
    );

    const replies = messages.filter((message) => message.type === "assistant").map(replyText);
    const guards = messages.filter(guard).length;
    const [rewrite, idle] = messages.slice(-2);
    const answered =
      messages.lastIndexOf(rewrite!) > messages.findLastIndex(guard) &&
      rewrite?.type === "assistant" &&
      rewrite.time?.completed !== undefined &&
      idle?.outcome === "succeeded";

    report(
      replies[0]?.includes(branch) === true,
      "the session's first reply named the branch from the injected brief",
    );

    report(/[\u2014\u2013]/u.test(replies[0] ?? ""), "the first reply carried an em dash");
    report(guards >= 1, `the reply guard sent a rewrite prompt (${guards} sent)`);
    report(settled, "the session settled within five minutes");
    report(guards >= 1 && answered, "the rewrite completed and the session ended successfully");
  } finally {
    opencode.stop();
  }
}

const commandArguments = "do 0";

function expandedArguments(messages: unknown): boolean {
  return (
    Array.isArray(messages) &&
    messages.some((message) => {
      const text = record(message).text;
      return (
        record(message).type === "user" &&
        typeof text === "string" &&
        text.endsWith(`these arguments: ${commandArguments}`)
      );
    })
  );
}

function loadedPlans(messages: unknown, config: string): boolean {
  if (!Array.isArray(messages)) return false;

  return messages.some((message) => {
    const content = record(message).content;
    if (!Array.isArray(content)) return false;

    return content.some((part) => {
      const tool = record(part);
      const state = record(tool.state);
      return (
        tool.type === "tool" &&
        tool.name === "skill" &&
        state.status === "completed" &&
        record(state.metadata).name === "plans" &&
        record(state.metadata).directory === join(config, "skills/plans")
      );
    });
  });
}

async function verifyCommands(
  temporary: string,
  config: string,
  directory: string,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const plans = join(temporary, "plans");
  mkdirSync(plans);

  const expected = readdirSync(join(config, "commands"))
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3));

  const opencode = await server(directory, { ...env, PWD: directory, PLANS_DIR: plans });
  try {
    let commands: unknown;
    let names = new Set<unknown>();
    for (let attempt = 0; attempt < 40 && !expected.every((name) => names.has(name)); attempt++) {
      await Bun.sleep(500);
      commands = await opencode.call("GET", "/api/command");
      names = new Set(Array.isArray(commands) ? commands.map((item) => record(item).name) : []);
    }

    writeFileSync(join(temporary, "opencode.commands.json"), JSON.stringify(commands, null, 2));
    const visible = expected.every((name) => names.has(name));
    report(visible, "OpenCode lists every installed slash command");
    assert(visible, "OpenCode did not activate the installed commands");

    const [providerID, rest] = [
      model.slice(0, model.indexOf("/")),
      model.slice(model.indexOf("/") + 1),
    ];

    const [id, variant] = rest.split("#");
    const session = record(
      await opencode.call("POST", "/api/session", {
        model: { providerID, id, ...(variant ? { variant } : {}) },
        location: { directory },
      }),
    );

    assert(typeof session.id === "string", "OpenCode did not create a session");

    let messages: unknown;
    let interruptFailure: unknown;
    try {
      await opencode.call("POST", `/api/session/${session.id}/command`, {
        name: "plans",
        text: commandArguments,
      });

      for (let attempt = 0; attempt < 120 && !loadedPlans(messages, config); attempt++) {
        await Bun.sleep(500);
        messages = await opencode.call(
          "GET",
          `/api/session/${session.id}/message?limit=100&order=asc`,
        );
      }

      writeFileSync(
        join(temporary, "opencode.plans.messages.json"),
        JSON.stringify(messages, null, 2),
      );

      report(
        expandedArguments(messages),
        `/plans ${commandArguments} reached the model with its arguments expanded`,
      );

      report(
        loadedPlans(messages, config),
        "/plans loaded the installed plans skill through the skill tool",
      );
    } finally {
      await opencode
        .call("POST", `/api/session/${session.id}/interrupt`)
        .catch((error: unknown) => {
          interruptFailure = error;
        });
    }

    if (interruptFailure) throw interruptFailure;
  } finally {
    opencode.stop();
  }
}

async function verify(): Promise<void> {
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

  for (const name of agentNames)
    assert(existsSync(join(config, "agents", `${name}.md`)), `installer did not write ${name}`);

  await verifyAgents(installed);

  const env: NodeJS.ProcessEnv = {
    ...installed,
    HOME: process.env.HOME,
    PWD: directory,
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

  report(existsSync(join(directory, "src/a.ts")), "the session ran in the scratch repository");
  await verifyReplyGuard(temporary, env);
  await verifyCommands(temporary, config, directory, env);

  rmSync(join(config, "plugins/skills.ts"));
  assert(!existsSync(join(config, "plugins/skills.ts")), "scratch plugin was not removed");

  const mergeCommand = "gh pr merge 7";
  const merge = shellRun(mergeCommand, directory, env);

  writeFileSync(join(temporary, "opencode.policy.stdout.jsonl"), merge.stdout ?? "");
  writeFileSync(join(temporary, "opencode.policy.stderr.log"), merge.stderr ?? "");
  report(
    !merge.error &&
      merge.status === 0 &&
      refused(merge.stdout ?? "", "Blocked by configuration policy", mergeCommand) &&
      !refused(merge.stdout ?? "", verdict.permissionDecisionReason, mergeCommand),
    "without the plugin, merge is denied by configuration policy rather than a plugin error",
  );

  report(refs() === before, "policy verification left the bare remote unchanged");

  fixtureCommand(["checkout", "--quiet", "-b", "feat/x"]);
  const pushCommand = "git push origin feat/x";
  const pushed = shellRun(pushCommand, directory, env);
  writeFileSync(join(temporary, "opencode.push.stdout.jsonl"), pushed.stdout ?? "");
  writeFileSync(join(temporary, "opencode.push.stderr.log"), pushed.stderr ?? "");
  report(
    !pushed.error && pushed.status === 0 && completedShell(pushed.stdout ?? "", pushCommand),
    "without the plugin, the feature branch push runs in prs mode",
  );

  report(
    refs().trim() === `refs/heads/feat/x ${fixtureCommand(["rev-parse", "HEAD"]).trim()}`,
    "the local bare origin gained refs/heads/feat/x at the scratch commit",
  );
}

try {
  await verify();
} catch (error) {
  report(false, error instanceof Error ? error.message : String(error));
}
