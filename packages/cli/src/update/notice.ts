import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import { tryLock, withLock } from "../lock.ts";
import { read, type ReadFailure } from "../read.ts";
import { readAutoUpdate } from "./auto-update.ts";

export type UpdateMode = "check" | "apply";

type State = {
  started?: string;
  line?: string;
  finished?: string;
  shown?: boolean;
  unsetShown?: string;
};

const DAY = 24 * 60 * 60 * 1000;
const RUN_DEADLINE = 3 * 60 * 60 * 1000;
const unsetNotice = "Auto-update is not set. Run ./install.sh to choose.";
const updateLinePattern =
  /^(?:updated v\S+ -> v\S+ \S+|available v\S+ \S+|current v\S+|refused .+)$/;

export function agentsDir(env: NodeJS.ProcessEnv): string | undefined {
  if (env.AGENTS_DIR) return resolve(env.AGENTS_DIR);
  return env.HOME ? join(env.HOME, ".agents/skills") : undefined;
}

function statePath(agents: string): string {
  return join(agents, "skills-update.json");
}

function readState(path: string): State {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};

    const raw = value as Record<string, unknown>;
    const text = (key: string) => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
    return {
      started: text("started"),
      line: text("line"),
      finished: text("finished"),
      shown: raw.shown === true,
      unsetShown: text("unsetShown"),
    };
  } catch {
    return {};
  }
}

function writeState(path: string, state: State): void {
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function stateLock(agents: string): string {
  mkdirSync(agents, { recursive: true });
  return join(agents, ".skills-update.json.lock");
}

function within24Hours(since: string | undefined, now: number): boolean {
  const time = since === undefined ? Number.NaN : Date.parse(since);
  return time <= now && now - time < DAY;
}

function failureReason(failure: ReadFailure): string {
  switch (failure.kind) {
    case "spawn":
      return "the update could not start";

    case "deadline":
      return `the update ran past ${RUN_DEADLINE / 3_600_000} hours`;

    case "held":
      return "the update kept its output open";

    case "signal":
      return `the update died on ${failure.signal}`;
  }
}

export function updateNotice(line: string): string | undefined {
  const updated = /^updated (v\S+) -> (v\S+) (\S+)$/.exec(line);
  if (updated) return `Skills updated ${updated[1]} -> ${updated[2]}: ${updated[3]}.`;

  const available = /^available (v\S+) (\S+)$/.exec(line);
  if (available) return `Skills ${available[1]} is out: ${available[2]}. Run skills update.`;

  const refused = /^refused (.+)$/.exec(line);
  return refused ? `Skills update refused: ${refused[1]}.` : undefined;
}

function launch(
  env: NodeJS.ProcessEnv,
  bin: string,
  root: string,
  agents: string,
  mode: UpdateMode,
  started: string,
) {
  const child = spawn(bin, ["--root", root, "hook", "session-start", "--record", mode, started], {
    cwd: agents,
    env: { ...env, AGENTS_DIR: agents },
    detached: true,
    stdio: "ignore",
  });

  child.on("error", () => {});
  child.unref();
}

export async function sessionNotice(
  env: NodeJS.ProcessEnv,
  bin: string,
  root: string,
  now = Date.now(),
): Promise<string | undefined> {
  if (env.CI !== undefined || env.SKILLS_AUTO_UPDATE === "0") return undefined;

  const config = readDeliveryConfig(env);
  if (config.invalid) return undefined;

  const reading = readAutoUpdate(config.content);
  const mode =
    reading.kind === "unset"
      ? "unset"
      : reading.kind === "set" && reading.value !== "off"
        ? reading.value
        : undefined;

  const agents = agentsDir(env);
  if (!mode || !agents) return undefined;

  const path = statePath(agents);
  const locked = await tryLock(stateLock(agents), () => {
    const state = readState(path);
    if (mode === "unset") {
      if (within24Hours(state.unsetShown, now)) return undefined;
      writeState(path, { ...state, unsetShown: new Date(now).toISOString() });
      return unsetNotice;
    }

    const fresh = state.line !== undefined && !state.shown;
    const notice = fresh ? updateNotice(state.line!) : undefined;
    if (within24Hours(state.started, now)) {
      if (fresh) writeState(path, { ...state, shown: true });
      return notice;
    }

    const started = new Date(now).toISOString();
    writeState(path, { started, unsetShown: state.unsetShown });
    launch(env, bin, root, agents, mode === "on" ? "apply" : "check", started);

    return notice;
  });

  return locked.held ? undefined : locked.value;
}

export async function recordUpdate(
  env: NodeJS.ProcessEnv,
  root: string,
  mode: UpdateMode,
  started: string,
): Promise<number> {
  const agents = agentsDir(env);
  if (!agents) return 1;

  const result = await read(
    [join(root, "playbook/bin/skills"), "update", ...(mode === "check" ? ["--check"] : [])],
    { cwd: dirname(root), env, deadline: RUN_DEADLINE },
  );

  const last = result.ok ? result.stdout.trimEnd().split("\n").at(-1) : undefined;
  const line = !result.ok
    ? `refused ${failureReason(result.failure)}`
    : last !== undefined && updateLinePattern.test(last)
      ? last
      : "refused the update printed no update line";

  const path = statePath(agents);
  await withLock(stateLock(agents), "the update state", () => {
    const state = readState(path);
    if (state.started !== started) return;

    writeState(path, {
      ...state,
      line,
      finished: new Date().toISOString(),
      shown: false,
    });
  });

  return 0;
}
