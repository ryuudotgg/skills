import {
  closeSync,
  cpSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { COLUMNS } from "skills-core";
import { runCommand, suiteEnvironment } from "./process.ts";

const repo = resolve(import.meta.dir, "../../../..");
const bin = join(repo, "skills/playbook/bin");
const usage = [
  "usage: bun packages/cli/src/test/hub-live.ts up <dir>",
  "       bun packages/cli/src/test/hub-live.ts machine <dir> <name> --plans fixture|empty|copy",
  "       bun packages/cli/src/test/hub-live.ts reset|restore|down <dir>",
].join("\n");

const PLAN_KINDS = ["fixture", "empty", "copy"] as const;

type PlanKind = (typeof PLAN_KINDS)[number];

type Hub = { readonly url: string; readonly port: number };

function fail(message: string): never {
  process.stderr.write(`hub-live: ${message}\n`);
  process.exit(1);
}

function quoted(value: string): string {
  return /^[\w./:-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function hubDir(dir: string): string {
  return join(dir, "hub");
}

function pidPath(dir: string): string {
  return join(dir, "hub.pid");
}

function logPath(dir: string): string {
  return join(hubDir(dir), "hub.log");
}

function readHub(dir: string): Hub {
  const env = join(dir, "hub.env");
  if (!existsSync(env)) fail(`${dir} has no hub, run up first`);

  const url = /^HUB_URL=(\S+)$/m.exec(readFileSync(env, "utf8"))?.[1];
  const port = Number(url?.split(":").at(-1));
  if (url === undefined || !Number.isInteger(port)) fail(`${env} names no HUB_URL`);

  return { url, port };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function ownHub(pid: number, dir: string): boolean {
  const ps = Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)]);
  const command = ps.stdout.toString();
  const environment = Bun.spawnSync([
    "ps",
    "eww",
    "-o",
    "command=",
    "-p",
    String(pid),
  ]).stdout.toString();

  return (
    command.includes("apps/hub/src/main.ts") && environment.includes(`HUB_DATA=${hubDir(dir)}`)
  );
}

function runningPid(dir: string): number | undefined {
  if (!existsSync(pidPath(dir))) return undefined;
  const pid = Number(readFileSync(pidPath(dir), "utf8").trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid) && ownHub(pid, dir) ? pid : undefined;
}

async function stop(dir: string): Promise<void> {
  const pid = runningPid(dir);
  rmSync(pidPath(dir), { force: true });
  if (pid === undefined) return;

  process.kill(pid, "SIGTERM");

  for (let waited = 0; alive(pid); waited += 50) {
    if (waited > 10_000) {
      process.kill(pid, "SIGKILL");
      break;
    }

    await Bun.sleep(50);
  }
}

async function logLine(dir: string, pattern: RegExp, from: number): Promise<RegExpExecArray> {
  for (let waited = 0; waited < 15_000; waited += 50) {
    const log = existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8").slice(from) : "";
    const found = pattern.exec(log);
    if (found) return found;

    await Bun.sleep(50);
  }

  return fail(`the hub logged no ${pattern.source} in 15 seconds, see ${logPath(dir)}`);
}

async function start(dir: string, port: number): Promise<{ hub: Hub; initCode?: string }> {
  if (runningPid(dir) !== undefined) fail(`${dir} already runs a hub, run down first`);

  mkdirSync(hubDir(dir), { recursive: true });
  const from = existsSync(logPath(dir)) ? readFileSync(logPath(dir), "utf8").length : 0;
  const log = openSync(logPath(dir), "a");
  const child = Bun.spawn(["bun", join(repo, "apps/hub/src/main.ts")], {
    cwd: repo,
    env: { ...suiteEnvironment(), HUB_DATA: hubDir(dir), HUB_LISTEN: `127.0.0.1:${port}` },
    stdin: "ignore",
    stdout: log,
    stderr: log,
    detached: true,
  });

  closeSync(log);
  child.unref();
  writeFileSync(pidPath(dir), `${child.pid}\n`);

  const listening = await logLine(dir, /^listening (http:\/\/127\.0\.0\.1:(\d+))$/m, from);
  const hub = { url: listening[1] ?? "", port: Number(listening[2]) };
  writeFileSync(join(dir, "hub.env"), `HUB_URL=${hub.url}\n`);

  const tail = readFileSync(logPath(dir), "utf8").slice(from);
  const initCode = /^init code (\S+)$/m.exec(tail)?.[1];
  return { hub, initCode };
}

function report(started: { hub: Hub; initCode?: string }): void {
  const lines = [`HUB_URL=${started.hub.url}`];
  if (started.initCode !== undefined) lines.push(`init code ${started.initCode}`);
  process.stdout.write(`${lines.join("\n")}\n`);
}

async function up(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  const port = existsSync(join(dir, "hub.env")) ? readHub(dir).port : 0;
  report(await start(dir, port));
}

async function reset(dir: string): Promise<void> {
  const { port } = readHub(dir);
  await stop(dir);
  rmSync(hubDir(dir), { recursive: true, force: true });
  report(await start(dir, port));
}

async function restore(dir: string): Promise<void> {
  const { port } = readHub(dir);
  await stop(dir);

  const db = join(hubDir(dir), "hub.db");
  if (!existsSync(db)) fail(`${db} does not exist`);

  writeFileSync(join(hubDir(dir), ".restored"), "");
  report(await start(dir, port));
}

async function git(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  const result = await runCommand(["git", ...argv], { cwd, env, timeout: 60_000 });
  if (result.code !== 0 || result.timedOut)
    fail(`git ${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
}

const GIT_ENV = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.com",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.com",
};

async function origin(dir: string): Promise<string> {
  const bare = join(dir, "origin.git");
  if (existsSync(bare)) return bare;

  const env = { ...suiteEnvironment(), ...GIT_ENV };
  const seed = join(dir, ".origin-seed");
  rmSync(seed, { recursive: true, force: true });

  await git(["init", "-q", "--bare", "-b", "main", bare], dir, env);
  await git(["clone", "-q", bare, seed], dir, env);
  await git(
    ["-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    seed,
    env,
  );

  await git(["push", "-q", "origin", "main"], seed, env);
  rmSync(seed, { recursive: true, force: true });

  return bare;
}

function planText(id: string, slug: string): string {
  return `---
id: ${id}
slug: ${slug}
project: Fixture
ctx: ctx-fixture
pri: P2
effort: S
blocked_by: -
surface: the Fixture project
critical: false
created: 2026-11-07
---

# ${id} ${slug}

## Outcome

A fixture plan with nothing to build.

## Acceptance

1. Nothing to check.

## Probe

    rg -n "${slug}"
`;
}

const CTX = `# ctx-fixture

## Invariant

Fixture plans build nothing.

## Verify

none, unit tests cover it
`;

function fixturePlans(plans: string): void {
  const project = join(plans, "Fixture");
  mkdirSync(join(project, "done"), { recursive: true });

  const slugs = ["first-plan", "second-plan", "third-plan"];
  const rows = slugs.map((slug, index) => {
    const id = String(index + 1).padStart(3, "0");
    writeFileSync(join(project, `${id}-${slug}.md`), planText(id, slug));
    return [id, slug, "TODO", "P2", "S", "-", "ctx-fixture", "-", "2026-11-07", "-"].join("\t");
  });

  writeFileSync(join(project, "ctx-fixture.md"), CTX);
  writeFileSync(join(project, "index.tsv"), [COLUMNS.join("\t"), ...rows, ""].join("\n"));
  fixtureFiles(project);
}

function fixtureFiles(project: string): void {
  for (const folder of ["assets", "evidence"])
    mkdirSync(join(project, folder), { recursive: true });

  writeFileSync(join(project, "assets", "a.txt"), "a\n");
  writeFileSync(join(project, "evidence", "b.bin"), randomBytes(3 * 1024 * 1024));
  writeFileSync(join(project, "done", "notes.md"), "# notes\n");

  writeFileSync(join(project, "run.sh"), "#!/bin/sh\necho run\n", { mode: 0o755 });
  symlinkSync(join("assets", "a.txt"), join(project, "link"));
  writeFileSync(join(project, "skip.png"), "png\n");
  writeFileSync(join(project, ".plansignore"), "*.png\n");
}

function makePlans(plans: string, kind: PlanKind, operatorHome: string): void {
  if (kind === "copy") {
    const source = join(operatorHome, "Plans");
    if (!existsSync(source)) fail(`${source} does not exist`);
    cpSync(source, plans, { recursive: true });
    return;
  }

  mkdirSync(plans, { recursive: true });
  if (kind === "fixture") fixturePlans(plans);
}

async function machine(dir: string, name: string, kind: PlanKind): Promise<void> {
  if (!/^[a-z0-9-]+$/.test(name)) fail(`machine names are lowercase words, not ${name}`);

  const { url } = readHub(dir);
  const root = join(dir, name);
  if (existsSync(root)) fail(`${root} exists, remove it or pick another name`);

  const paths = {
    home: join(root, "home"),
    conf: join(root, "skills.conf"),
    agents: join(root, "home/.agents"),
    claude: join(root, "home/.claude"),
    codex: join(root, "home/.codex"),
    plans: join(root, "plans"),
    repo: join(root, "Fixture"),
  };

  for (const path of [paths.home, paths.agents, paths.claude, paths.codex])
    mkdirSync(path, { recursive: true });

  writeFileSync(paths.conf, "");
  makePlans(paths.plans, kind, process.env.HOME ?? fail("HOME is not set"));
  await git(["clone", "-q", await origin(dir), paths.repo], dir, {
    ...suiteEnvironment(),
    ...GIT_ENV,
  });

  const exports: [string, string][] = [
    ["HOME", paths.home],
    ["SKILLS_CONF", paths.conf],
    ["AGENTS_DIR", paths.agents],
    ["CLAUDE_CONFIG_DIR", paths.claude],
    ["CODEX_HOME", paths.codex],
    ["HUB_KEYS", "file"],
    ["HUB_URL", url],
    ["HUB_NETWORK", "local"],
    ["PLANS_DIR", paths.plans],
    ["SKILLS_AUTO_UPDATE", "0"],
    ["SKILLS_MACHINE_REFRESH", "0"],
  ];

  const lines = exports.map(([key, value]) => `export ${key}=${quoted(value)}`);
  lines.push(`export PATH=${quoted(bin)}:"$PATH"`, `cd ${quoted(paths.repo)}`, "");
  process.stdout.write(lines.join("\n"));
}

const [verb, dirArg, ...rest] = process.argv.slice(2);
if (dirArg === undefined) fail(usage);

const dir = resolve(dirArg);
if (verb === "up" && rest.length === 0) await up(dir);
else if (verb === "reset" && rest.length === 0) await reset(dir);
else if (verb === "restore" && rest.length === 0) await restore(dir);
else if (verb === "down" && rest.length === 0) await stop(dir);
else if (verb === "machine") {
  const [name, flag, kind] = rest;
  if (rest.length !== 3 || name === undefined || flag !== "--plans") fail(usage);
  if (!PLAN_KINDS.includes(kind as PlanKind)) fail(usage);
  await machine(dir, name, kind as PlanKind);
} else fail(usage);
