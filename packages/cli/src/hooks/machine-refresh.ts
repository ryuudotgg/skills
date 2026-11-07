import { spawn } from "node:child_process";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factsStale, type Facts } from "skills-core";
import { tryLock } from "../lock.ts";
import { learnInto, machineLock, type Learned } from "../plans/machine.ts";

const BUSY_MS = 100;
const LAUNCH_WINDOW = 60_000;

function markerPath(root: string): string {
  return join(root, ".machine-refresh.json");
}

function launchedWithin(root: string, now: number): boolean {
  try {
    const { started } = JSON.parse(readFileSync(markerPath(root), "utf8")) as { started?: unknown };
    const at = typeof started === "string" ? Date.parse(started) : Number.NaN;
    return at <= now && now - at < LAUNCH_WINDOW;
  } catch {
    return false;
  }
}

function markLaunched(root: string, now: number): void {
  const path = markerPath(root);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify({ started: new Date(now).toISOString() })}\n`);
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function launch(bin: string, skillsRoot: string, cwd: string): void {
  const child = spawn(bin, ["--root", skillsRoot, "machine", "refresh"], {
    cwd,
    env: process.env,
    detached: true,
    stdio: "ignore",
  });

  child.on("error", () => {});
  child.unref();
}

type Read = { ok: true; facts: Facts | undefined } | { ok: false };

function readFacts(root: string, learned: Learned | undefined): Read {
  try {
    return { ok: true, facts: learnInto(root, learned, BUSY_MS) };
  } catch {
    return { ok: false };
  }
}

function needsRefresh(read: Read, now: number): boolean {
  return read.ok && factsStale(read.facts, now);
}

export async function machineLine(
  root: string,
  learned: Learned | undefined,
  bin: string,
  skillsRoot: string,
  now = Date.now(),
): Promise<string | undefined> {
  const read = readFacts(root, learned);
  if (needsRefresh(read, now) && process.env.SKILLS_MACHINE_REFRESH !== "0")
    await tryLock(machineLock(root), () => {
      if (launchedWithin(root, now) || !needsRefresh(readFacts(root, undefined), now)) return;
      markLaunched(root, now);
      launch(bin, skillsRoot, process.cwd());
    }).catch(() => {});

  return read.ok && read.facts ? `Machine: ${read.facts.label}` : undefined;
}
