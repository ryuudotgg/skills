import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Io } from "../io.ts";
import { describe, read } from "../read.ts";
import type { Artifact, Kind } from "./artifacts.ts";
import { physical } from "./checkouts.ts";
import { readCwds } from "./release.ts";

export type Tools = { io: Io; grace: number; self: number; docker?: Promise<Ran> };

type Of<K extends Kind> = Extract<Artifact, { kind: K }>;

export type Listing =
  | { kind: "listed"; artifacts: Artifact[] }
  | { kind: "skipped"; reason: string }
  | { kind: "failed"; reason: string };

type Step<K extends Kind> = (artifact: Of<K>, tools: Tools) => Promise<string | undefined>;

type Impl<K extends Kind> = {
  kind: K;
  list(tools: Tools): Promise<Listing>;
  stop: Step<K>;
  settle: Step<K>;
  remove: Step<K>;
};

export type Adapter = {
  kind: Kind;
  list(tools: Tools): Promise<Listing>;
  stop(artifact: Artifact, tools: Tools): Promise<string | undefined>;
  settle(artifact: Artifact, tools: Tools): Promise<string | undefined>;
  remove(artifact: Artifact, tools: Tools): Promise<string | undefined>;
};

export type Ran =
  | { ok: true; stdout: string }
  | { ok: false; reason: string; absent: boolean; code?: number };

const LIST_DEADLINE = 30_000;
const STEP_DEADLINE = 60_000;
const EMULATOR_EXIT = 30_000;
const done = async () => undefined;
const SDK_TOOLS: Record<string, string> = { emulator: "emulator", adb: "platform-tools" };

export function sdkRoot(env: NodeJS.ProcessEnv): string {
  if (env.ANDROID_HOME) return env.ANDROID_HOME;

  const home = env.HOME || homedir();
  return process.platform === "darwin"
    ? join(home, "Library", "Android", "sdk")
    : join(home, "Android", "Sdk");
}

export function toolPath(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const found = Bun.which(name, { PATH: env.PATH });
  if (found) return found;

  const folder = SDK_TOOLS[name];
  const bundled = folder ? join(sdkRoot(env), folder, name) : undefined;
  return bundled && existsSync(bundled) ? bundled : undefined;
}

export async function run(
  argv: readonly string[],
  tools: Tools,
  deadline: number,
  accepted: readonly number[] = [0],
): Promise<Ran> {
  const [name = "", ...rest] = argv;
  const path = toolPath(name, tools.io.env);
  if (!path) return { ok: false, reason: `${name} not found`, absent: true };

  const env = { ...tools.io.env, LC_ALL: "C" };
  const result = await read([path, ...rest], { cwd: "/", env, deadline });
  if (!result.ok) return { ok: false, reason: describe(result.failure), absent: false };
  if (accepted.includes(result.code)) return { ok: true, stdout: result.stdout };

  const said = result.stderr
    .split("\n")
    .find((line) => line.trim())
    ?.trim();

  const label = argv.slice(0, 3).join(" ");
  const reason = `${label} exited ${result.code}${said ? `: ${said}` : ""}`;
  return { ok: false, reason, absent: false, code: result.code };
}

function adapter<K extends Kind>(impl: Impl<K>): Adapter {
  const own = (artifact: Artifact) => artifact as Of<K>;
  return {
    kind: impl.kind,
    list: impl.list,
    stop: (artifact, tools) => impl.stop(own(artifact), tools),
    settle: (artifact, tools) => impl.settle(own(artifact), tools),
    remove: (artifact, tools) => impl.remove(own(artifact), tools),
  };
}

function unlisted(ran: Ran & { ok: false }, unreachable = false): Listing {
  return ran.absent || unreachable
    ? { kind: "skipped", reason: ran.reason }
    : { kind: "failed", reason: ran.reason };
}

export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim());
}

function parseSimulators(stdout: string): Artifact[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }

  const devices = (parsed as { devices?: unknown } | null)?.devices;
  if (typeof devices !== "object" || devices === null) return undefined;

  const artifacts: Artifact[] = [];
  for (const list of Object.values(devices)) {
    if (!Array.isArray(list)) return undefined;

    for (const device of list as Record<string, unknown>[]) {
      const { name, udid, state } = device ?? {};
      if (typeof name !== "string" || typeof udid !== "string" || typeof state !== "string")
        return undefined;

      artifacts.push({ kind: "simulator", name, udid, booted: state !== "Shutdown" });
    }
  }

  return artifacts;
}

const simulator = adapter({
  kind: "simulator",
  async list(tools) {
    const listed = await run(
      ["xcrun", "simctl", "list", "devices", "--json"],
      tools,
      LIST_DEADLINE,
    );

    if (!listed.ok) return unlisted(listed, listed.code === 72);

    const artifacts = parseSimulators(listed.stdout);
    return artifacts
      ? { kind: "listed", artifacts }
      : { kind: "failed", reason: "xcrun simctl list devices printed no device list" };
  },
  async stop({ udid, booted }, tools) {
    if (!booted) return undefined;

    const stopped = await run(
      ["xcrun", "simctl", "shutdown", udid],
      tools,
      STEP_DEADLINE,
      [0, 149],
    );

    return stopped.ok ? undefined : stopped.reason;
  },
  settle: done,
  async remove({ udid }, tools) {
    const deleted = await run(["xcrun", "simctl", "delete", udid], tools, STEP_DEADLINE);
    return deleted.ok ? undefined : deleted.reason;
  },
});

export function avdHome(env: NodeJS.ProcessEnv): string {
  if (env.ANDROID_AVD_HOME) return env.ANDROID_AVD_HOME;
  if (env.ANDROID_USER_HOME) return join(env.ANDROID_USER_HOME, "avd");
  return join(env.HOME || homedir(), ".android", "avd");
}

export async function emulatorSerials(tools: Tools): Promise<string[] | (Ran & { ok: false })> {
  const listed = await run(["adb", "devices"], tools, LIST_DEADLINE);
  if (!listed.ok) return listed;
  return lines(listed.stdout).flatMap((line) => /^(emulator-[0-9]+)\s/.exec(line)?.[1] ?? []);
}

function avdData(name: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = avdHome(env);
  const ini = join(home, `${name}.ini`);
  const data = join(home, `${name}.avd`);
  if (!existsSync(ini)) return `no ${ini}`;

  const path = /^path=(.+)$/m.exec(readFileSync(ini, "utf8"))?.[1]?.trim();
  return path && physical(path) !== physical(data)
    ? `its data lives at ${path}, not ${data}`
    : undefined;
}

export async function runningAvd(serial: string, tools: Tools): Promise<string | undefined> {
  const named = await run(["adb", "-s", serial, "emu", "avd", "name"], tools, LIST_DEADLINE);
  return named.ok ? lines(named.stdout)[0]?.trim() : undefined;
}

const avd = adapter({
  kind: "avd",
  async list(tools) {
    const listed = await run(["emulator", "-list-avds"], tools, LIST_DEADLINE);
    if (!listed.ok) return unlisted(listed);

    const names = lines(listed.stdout).filter((line) => /^[A-Za-z0-9._-]+$/.test(line));
    if (names.length === 0) return { kind: "listed", artifacts: [] };

    const serials = await emulatorSerials(tools);
    if (!Array.isArray(serials)) return unlisted(serials);

    const running = new Map<string, string[]>();
    for (const serial of serials) {
      const name = await runningAvd(serial, tools);
      if (!name) return { kind: "failed", reason: `cannot read the AVD ${serial} runs` };
      running.set(name, [...(running.get(name) ?? []), serial]);
    }

    return {
      kind: "listed",
      artifacts: names.map((name) => ({ kind: "avd", name, serials: running.get(name) ?? [] })),
    };
  },
  async stop({ name, serials }, tools) {
    const elsewhere = avdData(name, tools.io.env);
    if (elsewhere) return elsewhere;

    for (const serial of serials) {
      const now = await runningAvd(serial, tools);
      if (now !== name) return `${serial} no longer runs ${name}`;

      const killed = await run(["adb", "-s", serial, "emu", "kill"], tools, STEP_DEADLINE);
      if (!killed.ok) return killed.reason;
    }

    return undefined;
  },
  async settle({ serials }, tools) {
    if (serials.length === 0) return undefined;

    const deadline = Date.now() + EMULATOR_EXIT;
    for (;;) {
      const now = await emulatorSerials(tools);
      if (!Array.isArray(now)) return now.reason;

      const left = serials.filter((serial) => now.includes(serial));
      if (left.length === 0) return undefined;
      if (Date.now() > deadline)
        return `${left.join(", ")} still runs after ${EMULATOR_EXIT / 1000} s`;

      await Bun.sleep(250);
    }
  },
  async remove({ name }, tools) {
    const home = avdHome(tools.io.env);
    try {
      const elsewhere = avdData(name, tools.io.env);
      if (elsewhere) return elsewhere;

      rmSync(join(home, `${name}.avd`), { recursive: true, force: true });
      rmSync(join(home, `${name}.ini`), { force: true });
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  },
});

function dockerReach(tools: Tools): Promise<Ran> {
  tools.docker ??= run(["docker", "info", "--format", "{{.ServerVersion}}"], tools, LIST_DEADLINE);
  return tools.docker;
}

const COMPOSE_LABELS =
  '{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}';

async function composeProjects(
  tools: Tools,
  only?: string,
): Promise<Map<string, Set<string>> | (Ran & { ok: false })> {
  const label = `label=com.docker.compose.project${only === undefined ? "" : `=${only}`}`;
  const listed = await run(
    ["docker", "ps", "--all", "--no-trunc", "--filter", label, "--format", COMPOSE_LABELS],
    tools,
    LIST_DEADLINE,
  );

  if (!listed.ok) return listed;

  const projects = new Map<string, Set<string>>();
  for (const line of lines(listed.stdout)) {
    const [name = "", directory = ""] = line.split("\t");
    if (!name)
      return { ok: false, reason: `docker ps printed ${JSON.stringify(line)}`, absent: false };

    projects.set(name, (projects.get(name) ?? new Set()).add(directory));
  }

  return projects;
}

function bare(tools: Tools): Tools {
  const env = Object.fromEntries(
    Object.entries(tools.io.env).filter(([key]) => !key.startsWith("COMPOSE_")),
  );

  return { ...tools, io: { ...tools.io, env } };
}

const compose = adapter({
  kind: "compose",
  async list(tools) {
    const reach = await dockerReach(tools);
    if (!reach.ok) return unlisted(reach, true);

    const projects = await composeProjects(tools);
    if (!(projects instanceof Map)) return unlisted(projects);

    return {
      kind: "listed",
      artifacts: [...projects].map(([name, directories]) => ({
        kind: "compose",
        name,
        directories: [...directories],
      })),
    };
  },
  stop: done,
  settle: done,
  async remove({ name, directories }, tools) {
    const before = await composeProjects(tools, name);
    if (!(before instanceof Map)) return before.reason;

    const now = [...(before.get(name) ?? [])].sort();
    if (now.join("\0") !== [...directories].sort().join("\0"))
      return "its containers changed since the first read";

    const down = await run(
      ["docker", "compose", "-p", name, "down", "--volumes", "--timeout", "0"],
      bare(tools),
      STEP_DEADLINE,
    );

    if (!down.ok) return down.reason;

    const after = await composeProjects(tools, name);
    if (!(after instanceof Map)) return after.reason;

    return after.size ? "containers remain after docker compose down" : undefined;
  },
});

const volume = adapter({
  kind: "volume",
  async list(tools) {
    const reach = await dockerReach(tools);
    if (!reach.ok) return unlisted(reach, true);

    const listed = await run(
      ["docker", "volume", "ls", "--format", "{{.Name}}"],
      tools,
      LIST_DEADLINE,
    );

    if (!listed.ok) return unlisted(listed);

    return {
      kind: "listed",
      artifacts: lines(listed.stdout).map((name) => ({ kind: "volume", name: name.trim() })),
    };
  },
  stop: done,
  settle: done,
  async remove({ name }, tools) {
    const removed = await run(["docker", "volume", "rm", name], tools, STEP_DEADLINE);
    return removed.ok ? undefined : removed.reason;
  },
});

type Process = { ppid: number; started: string; zombie: boolean };

async function processes(tools: Tools, pid?: number): Promise<Map<number, Process> | string> {
  const select = pid === undefined ? ["-A"] : ["-p", String(pid)];
  const listed = await run(
    ["ps", ...select, "-o", "pid=,ppid=,stat=,lstart="],
    tools,
    LIST_DEADLINE,
    pid === undefined ? [0] : [0, 1],
  );

  if (!listed.ok) return listed.reason;

  const table = new Map<number, Process>();
  for (const line of lines(listed.stdout)) {
    const found = /^\s*([0-9]+)\s+([0-9]+)\s+(\S+)\s+(.+?)\s*$/.exec(line);
    if (!found) return `ps printed ${JSON.stringify(line)}`;

    const [, id = "", ppid = "", stat = "", started = ""] = found;
    table.set(Number(id), { ppid: Number(ppid), started, zombie: stat.startsWith("Z") });
  }

  return table;
}

async function same(pid: number, started: string, tools: Tools): Promise<boolean | string> {
  const table = await processes(tools, pid);
  if (typeof table === "string") return table;

  const found = table.get(pid);
  return found !== undefined && !found.zombie && found.started === started;
}

function ancestors(self: number, table: ReadonlyMap<number, Process>): Set<number> {
  const seen = new Set<number>();
  for (let pid = self; pid > 1 && !seen.has(pid); pid = table.get(pid)?.ppid ?? 0) seen.add(pid);
  return seen;
}

function parseListening(stdout: string): Map<number, { command: string; ports: string[] }> {
  const listening = new Map<number, { command: string; ports: string[] }>();

  let pid = 0;
  for (const line of lines(stdout)) {
    const value = line.slice(1);
    if (line.startsWith("p")) pid = Number(value);
    if (line.startsWith("c")) listening.set(pid, { command: value, ports: [] });

    const port = line.startsWith("n") ? /:([0-9]+)$/.exec(value)?.[1] : undefined;
    const entry = listening.get(pid);
    if (port && entry && !entry.ports.includes(port)) entry.ports.push(port);
  }

  return listening;
}

function signal(pid: number, name: "SIGTERM" | "SIGKILL"): string | undefined {
  try {
    process.kill(pid, name);
    return undefined;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ESRCH" ? undefined : `${name} to ${pid} failed: ${code ?? String(error)}`;
  }
}

async function waitGone(pid: number, started: string, tools: Tools, limit: number) {
  const deadline = Date.now() + limit;
  for (;;) {
    const alive = await same(pid, started, tools);
    if (alive !== true || Date.now() > deadline) return alive;
    await Bun.sleep(100);
  }
}

const listener = adapter({
  kind: "listener",
  async list(tools) {
    const uid = String(process.getuid?.() ?? "");
    const sockets = await run(
      ["lsof", "-n", "-P", "-a", "-u", uid, "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
      tools,
      LIST_DEADLINE,
      [0, 1],
    );

    if (!sockets.ok) return unlisted(sockets);

    const listening = parseListening(sockets.stdout);
    if (listening.size === 0) return { kind: "listed", artifacts: [] };

    const cwds = await readCwds(tools.io);
    if (!Array.isArray(cwds)) return { kind: "failed", reason: cwds.reason };

    const table = await processes(tools);
    if (typeof table === "string") return { kind: "failed", reason: table };

    const protectedPids = ancestors(tools.self, table);
    const artifacts: Artifact[] = [];
    for (const [pid, { command, ports }] of listening) {
      const cwd = cwds.find((entry) => entry.pid === String(pid))?.path;
      const started = table.get(pid)?.started;
      if (pid <= 1 || protectedPids.has(pid) || !cwd || !started) continue;

      const name = `${command}(${pid}):${ports.join(",")}`;
      artifacts.push({ kind: "listener", name, pid, started, cwd });
    }

    return { kind: "listed", artifacts };
  },
  async stop({ pid, started }, tools) {
    const alive = await same(pid, started, tools);
    if (typeof alive === "string") return alive;
    return alive ? signal(pid, "SIGTERM") : undefined;
  },
  async settle({ pid, started }, tools) {
    const alive = await waitGone(pid, started, tools, tools.grace);
    return typeof alive === "string" ? alive : undefined;
  },
  async remove({ pid, started }, tools) {
    const alive = await same(pid, started, tools);
    if (typeof alive === "string") return alive;
    if (!alive) return undefined;

    const failed = signal(pid, "SIGKILL");
    if (failed) return failed;

    const still = await waitGone(pid, started, tools, 2_000);
    if (typeof still === "string") return still;

    return still ? `${pid} survived SIGKILL` : undefined;
  },
});

export const ADAPTERS: readonly Adapter[] = [simulator, avd, compose, volume, listener];
