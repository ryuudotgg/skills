import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, sep } from "node:path";
import {
  factsFrom,
  MACHINE_EVENT,
  toolLine,
  TOOLS,
  withCheckout,
  type Checkout,
  type Facts,
  type Tool,
  type ToolName,
} from "skills-core";
import { processIo, type Io } from "../io.ts";
import { withLock } from "../lock.ts";
import { detectProject, gitOutput } from "../project.ts";
import { describe, read } from "../read.ts";
import { toolPath } from "./artifact-kinds.ts";
import { openPlansStore } from "./commit.ts";
import { Refusal } from "./import.ts";
import { plansDir } from "./index-tsv.ts";
import { readStore } from "./projection.ts";
import { appendEvent, openStore, write, type Store } from "./store.ts";

const PROBE_DEADLINE = 5000;

const COMMANDS: Record<Exclude<ToolName, "bun">, readonly string[]> = {
  xcode: ["xcodebuild", "-version"],
  android: ["adb", "--version"],
  docker: ["docker", "version", "--format", "{{.Server.Version}}"],
  node: ["node", "--version"],
  gh: ["gh", "--version"],
};

type Line = { ok: true; line: string } | { ok: false; reason: string };

type Probed = Pick<Facts, "label" | "os" | "arch" | "tools">;

export type Learned = { project: string; checkout: Checkout };

function firstLine(text: string): string | undefined {
  return text
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
}

async function commandLine(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<Line> {
  const [name = "", ...rest] = argv;
  const shown = argv.join(" ");
  const path = toolPath(name, env);
  if (!path) return { ok: false, reason: `${name} not found` };

  const result = await read([path, ...rest], {
    cwd: "/",
    env: { ...env, LC_ALL: "C" },
    deadline: PROBE_DEADLINE,
  });

  if (!result.ok) return { ok: false, reason: describe({ ...result.failure, read: shown }) };

  if (result.code !== 0) {
    const said = firstLine(result.stderr)?.slice(0, 120);
    return { ok: false, reason: `${shown}: exit ${result.code}${said ? `, ${said}` : ""}` };
  }

  const line = firstLine(result.stdout);
  return line ? { ok: true, line } : { ok: false, reason: `${shown}: printed nothing` };
}

async function toolFact(name: ToolName, env: NodeJS.ProcessEnv): Promise<Tool> {
  if (name === "bun") return { version: Bun.version };
  const line = await commandLine(COMMANDS[name], env);
  return line.ok ? { version: line.line } : { absent: true, reason: line.reason };
}

async function defaultLabel(env: NodeJS.ProcessEnv): Promise<string> {
  const argv = process.platform === "darwin" ? ["scutil", "--get", "ComputerName"] : ["hostname"];
  const line = await commandLine(argv, env);
  return line.ok ? line.line : hostname();
}

function releaseName(): string | null {
  try {
    const pretty = readFileSync("/etc/os-release", "utf8")
      .split("\n")
      .find((line) => line.startsWith("PRETTY_NAME="))
      ?.slice("PRETTY_NAME=".length)
      .replace(/^"(.*)"$/, "$1");

    return pretty || null;
  } catch {
    return null;
  }
}

async function osVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  if (process.platform === "linux") return releaseName();
  if (process.platform !== "darwin") return null;

  const line = await commandLine(["sw_vers", "-productVersion"], env);
  return line.ok ? line.line : null;
}

async function probe(env: NodeJS.ProcessEnv): Promise<Probed> {
  const [label, version, ...found] = await Promise.all([
    defaultLabel(env),
    osVersion(env),
    ...TOOLS.map((name) => toolFact(name, env)),
  ]);

  const tools = Object.fromEntries(TOOLS.map((name, index) => [name, found[index]!]));
  return {
    label,
    os: { platform: process.platform, version },
    arch: process.arch,
    tools: tools as Record<ToolName, Tool>,
  };
}

export function logicalPath(real: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const pwd = env.PWD;
  try {
    if (!pwd || realpathSync(pwd) !== realpathSync(cwd)) return real;
  } catch {
    return real;
  }

  for (let ancestor = pwd; dirname(ancestor) !== ancestor; ancestor = dirname(ancestor))
    try {
      const resolved = realpathSync(ancestor);
      if (resolved !== ancestor && (real === resolved || real.startsWith(resolved + sep)))
        return ancestor + real.slice(resolved.length);
    } catch {}

  return real;
}

export async function learnCheckout(
  root: string,
  io: Io = processIo(),
): Promise<Learned | undefined> {
  const [project, list, origin] = await Promise.all([
    detectProject(io.cwd, root, true),
    gitOutput(io.cwd, ["worktree", "list", "--porcelain", "-z"], { quiet: true }, io),
    gitOutput(io.cwd, ["remote", "get-url", "origin"], { quiet: true }, io),
  ]);

  const primary = list
    ?.split("\0")
    .find((field) => field.startsWith("worktree "))
    ?.slice("worktree ".length);

  if (!project || !primary) return undefined;

  return {
    project,
    checkout: { path: logicalPath(primary, io.env, io.cwd), origin: origin?.trim() || null },
  };
}

export function newestFacts(store: Store): Facts | undefined {
  const newest = store.db
    .query(
      `SELECT payload FROM events
       WHERE project = '-' AND plan = '-' AND type = ? AND legacy = 0 AND machine = ?
       ORDER BY wall DESC, counter DESC LIMIT 1`,
    )
    .get(MACHINE_EVENT, store.machine) as { payload: string } | null;

  return newest ? factsFrom(JSON.parse(newest.payload)) : undefined;
}

export function deviceId(store: Store): string | null {
  const device = store.db.query("SELECT value FROM meta WHERE key = 'device'").get() as {
    value: string;
  } | null;

  return device?.value ?? null;
}

function recordFacts(store: Store, facts: Facts, at: number): void {
  appendEvent(store, {
    kind: "stored",
    type: MACHINE_EVENT,
    at,
    project: "-",
    plan: "-",
    payload: facts,
  });
}

type Refresh = { environment?: string; label?: string; learned?: Learned };

function refreshed(
  previous: Facts | undefined,
  probed: Probed,
  refresh: Refresh,
  now: number,
): Facts {
  const kept = Object.entries(previous?.checkouts ?? {}).filter(([, checkout]) =>
    existsSync(checkout.path),
  );

  const learned = refresh.learned
    ? [[refresh.learned.project, refresh.learned.checkout] as const]
    : [];

  const checkouts = Object.fromEntries([...kept, ...learned]);
  return {
    ...probed,
    label: refresh.label ?? previous?.label ?? probed.label,
    environment: refresh.environment ?? previous?.environment ?? null,
    checkouts,
    captured: new Date(now).toISOString(),
  };
}

export function machineLock(root: string): string {
  return join(root, ".machine.lock");
}

async function refreshFacts(root: string, refresh: Refresh, io: Io): Promise<Facts> {
  if (!existsSync(root)) throw new Refusal(`no plans directory at ${root}`);

  return withLock(machineLock(root), "the machine facts", async () => {
    const [probed, learned] = await Promise.all([probe(io.env), learnCheckout(root, io)]);
    const store = await openPlansStore(root);
    try {
      return write(store, () => {
        const now = Date.now();
        const facts = refreshed(newestFacts(store), probed, { ...refresh, learned }, now);

        recordFacts(store, facts, now);
        return facts;
      });
    } finally {
      store.db.close();
    }
  });
}

async function relabel(root: string, label: string, io: Io): Promise<Facts> {
  const store = await openPlansStore(root);
  try {
    const labelled = write(store, () => {
      const previous = newestFacts(store);
      if (!previous) return undefined;

      const facts = { ...previous, label };
      recordFacts(store, facts, Date.now());
      return facts;
    });

    if (labelled) return labelled;
  } finally {
    store.db.close();
  }

  return refreshFacts(root, { label }, io);
}

export function learnInto(
  root: string,
  learned: Learned | undefined,
  busyMs: number,
): Facts | undefined {
  const store = openStore(join(root, "plans.db"), { busyMs, drain: false });
  try {
    const facts = store.db.transaction(() => newestFacts(store)).deferred();
    if (!facts || !learned || !withCheckout(facts, learned.project, learned.checkout)) return facts;

    try {
      return write(store, () => {
        const newest = newestFacts(store);
        const next = newest && withCheckout(newest, learned.project, learned.checkout);
        if (next) recordFacts(store, next, Date.now());

        return next ?? newest;
      });
    } catch {
      return facts;
    }
  } finally {
    store.db.close();
  }
}

export async function recordCheckout(io: Io): Promise<void> {
  const root = plansDir(io.env);
  try {
    const learned = await learnCheckout(root, io);
    if (learned) learnInto(root, learned, 1000);
  } catch {}
}

function factLines(facts: Facts, device: string | null): string[] {
  return [
    `label ${facts.label}`,
    `device ${device ?? "-"}`,
    `environment ${facts.environment ?? "-"}`,
    `os ${facts.os.platform} ${facts.os.version ?? "-"}`,
    `arch ${facts.arch}`,
    ...TOOLS.map((name) => toolLine(name, facts.tools[name])),
    ...Object.entries(facts.checkouts)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([project, { path, origin }]) => `checkout ${project} ${path} ${origin ?? "-"}`),
    `captured ${facts.captured}`,
  ];
}

function print(io: Io, facts: Facts, device: string | null, json: boolean): void {
  if (json) {
    const { label, environment, os, arch, tools, checkouts, captured } = facts;
    const shown = { label, device, environment, os, arch, tools, checkouts, captured };
    io.out(`${JSON.stringify(shown)}\n`);
    return;
  }

  io.out(`${factLines(facts, device).join("\n")}\n`);
}

function validName(value: string | undefined): boolean {
  return (
    value === undefined || (value !== "" && !value.startsWith("--") && !/[\t\r\n]/.test(value))
  );
}

function usageError(io: Io, usage: string): number {
  io.err(`usage: ${usage}\n`);
  return 2;
}

async function readDevice(root: string): Promise<string | null> {
  const read = await readStore(root, deviceId);
  return read.kind === "read" ? read.value : null;
}

async function guarded(io: Io, verb: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`machine ${verb}: ${error.message}\n`);
    return 1;
  }
}

export async function showVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const json = args[0] === "--json";
  if (args.length > (json ? 1 : 0)) return usageError(io, usage);

  const root = plansDir(io.env);
  const read = await readStore(root, (store) => ({
    facts: newestFacts(store),
    device: deviceId(store),
  }));

  if (read.kind === "failed") {
    io.err(`machine show: ${read.reason}\n`);
    return 1;
  }

  const shown = read.kind === "read" ? read.value : undefined;
  if (!shown?.facts) {
    io.err("machine show: no facts for this machine yet, run skills machine refresh\n");
    return 1;
  }

  print(io, shown.facts, shown.device, json);
  return 0;
}

export async function labelVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const label = args[0]?.trim();
  if (args.length !== 1 || !label || !validName(label)) return usageError(io, usage);

  return guarded(io, "label", async () => {
    const root = plansDir(io.env);
    const facts = await relabel(root, label, io);

    print(io, facts, await readDevice(root), false);
    return 0;
  });
}

export async function refreshVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const environment = args[0] === "--environment" ? args[1]?.trim() : undefined;
  if (args.length !== (environment === undefined ? 0 : 2) || !validName(environment))
    return usageError(io, usage);

  return guarded(io, "refresh", async () => {
    const root = plansDir(io.env);
    const facts = await refreshFacts(root, { environment }, io);

    print(io, facts, await readDevice(root), false);
    return 0;
  });
}
