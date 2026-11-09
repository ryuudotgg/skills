import {
  AD_HOC_ID,
  factsFrom,
  secondStamp,
  MACHINE_EVENT,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  sessionTokens,
  UNKNOWN_EFFORT,
  type Host,
  type SessionPolicy,
  type SessionRecord,
  type SessionStats,
} from "skills-core";
import { plansDir } from "../plans/index-tsv.ts";
import { detectProject, gitOutput } from "../project.ts";
import { recordEvent } from "../plans/record.ts";
import type { Store } from "../plans/store.ts";
import { object } from "./jsonl.ts";
import { projectPolicies, sessionKey, sessionPolicy, silenced, type Links } from "./policy.ts";
import { hostDirs } from "./transcripts.ts";

const HOOK_BUSY_MS = 200;

const SESSION_ID = /^[^\s/\\]{1,200}$/;

export type SessionLine = {
  host: Host;
  session: string;
  project: string;
  plans: string[];
  links: string[];
  branch: string;
  machine: string;
  start: string;
  end: string;
  models: string[];
  tokens: number;
  policy: SessionPolicy;
  silenced: boolean;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function under(path: string, folder: string): boolean {
  return path.startsWith(folder.endsWith("/") ? folder : `${folder}/`);
}

export function hookHost(payload: Record<string, unknown>, env: NodeJS.ProcessEnv): Host | null {
  if (payload.host === "opencode") return "opencode";

  const transcript = text(payload.transcript_path);
  const dirs = hostDirs(env);
  if (under(transcript, dirs.codex) || transcript.includes("/.codex/sessions/")) return "codex";
  if (under(transcript, dirs.claude) || transcript.includes("/.claude/projects/")) return "claude";

  return env.CLAUDE_PROJECT_DIR ? "claude" : null;
}

export async function recordHookSession(input: string, env: NodeJS.ProcessEnv): Promise<void> {
  let payload: Record<string, unknown> | undefined;
  try {
    const value: unknown = JSON.parse(input);
    payload = object(value) ? value : undefined;
  } catch {
    return;
  }

  if (!payload) return;

  const host = hookHost(payload, env);
  const session = text(payload.session_id);
  if (!host || !SESSION_ID.test(session)) return;

  const cwd = text(payload.cwd) || process.cwd();
  const [project, head] = await Promise.all([
    detectProject(cwd, plansDir(env), true),
    gitOutput(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { quiet: true }),
  ]);

  if (!project) return;

  const branch = head?.trim() || undefined;
  const record: SessionRecord = {
    host,
    session,
    branch: branch ?? AD_HOC_ID,
    plans: [],
    source: text(payload.source) || AD_HOC_ID,
    started: secondStamp(Date.now()),
  };

  await recordEvent(SESSION_EVENT, record, { project, branch }, env, HOOK_BUSY_MS);
}

type Row = { machine: string; project: string; type: string; payload: string };

type Folded = {
  record: SessionRecord;
  project: string;
  machine: string;
  plans: string[];
  started: string;
  stats: SessionStats | null;
};

function labels(store: Store): Map<string, string> {
  const rows = store.db
    .query(
      `SELECT machine, payload FROM events
       WHERE type = ? AND project = '-' AND plan = '-' AND legacy = 0
       ORDER BY wall, counter`,
    )
    .all(MACHINE_EVENT) as { machine: string; payload: string }[];

  const found = new Map<string, string>();
  for (const row of rows) {
    const facts = factsFrom(JSON.parse(row.payload));
    if (facts) found.set(row.machine, facts.label);
  }

  return found;
}

function earlier(left: string, right: string): string {
  return Date.parse(right) < Date.parse(left) ? right : left;
}

function modelsOf(stats: SessionStats | null): string[] {
  if (!stats) return [];

  return Object.entries(stats.models).map(
    ([model, usage]) => `${model}/${usage.effort || UNKNOWN_EFFORT}`,
  );
}

export function sessionLines(store: Store, withheld: Links = new Map()): SessionLine[] {
  const rows = store.db
    .query(
      `SELECT machine, project, type, payload FROM events
       WHERE type IN (?, ?) AND legacy = 0 AND quarantined IS NULL
       ORDER BY wall, counter, machine`,
    )
    .all(SESSION_EVENT, SESSION_STATS_EVENT) as Row[];

  const sessions = new Map<string, Folded>();
  const stats = new Map<string, SessionStats>();
  const projects = new Map<string, Set<string>>();
  for (const row of rows) {
    const payload = JSON.parse(row.payload) as SessionRecord | SessionStats;
    const key = sessionKey(payload.host, payload.session);
    projects.set(key, (projects.get(key) ?? new Set()).add(row.project));

    if (row.type === SESSION_STATS_EVENT) {
      stats.set(key, payload as SessionStats);
      continue;
    }

    const record = payload as SessionRecord;
    const seen = sessions.get(key);
    const plans = [...(seen?.plans ?? [])];
    for (const id of record.plans) {
      const link = `${row.project}/${id}`;
      if (!plans.includes(link)) plans.push(link);
    }

    sessions.set(key, {
      record,
      project: row.project,
      machine: row.machine,
      plans,
      started: seen ? earlier(seen.started, record.started) : record.started,
      stats: null,
    });
  }

  const machines = labels(store);
  const policies = projectPolicies(store);
  const lines: SessionLine[] = [];
  for (const [key, folded] of sessions) {
    const sessionStats = stats.get(key) ?? null;
    const linked = new Set([...projects.get(key)!, ...(withheld.get(key) ?? [])]);
    lines.push({
      host: folded.record.host,
      session: folded.record.session,
      project: folded.project,
      plans: folded.plans
        .filter((link) => link.startsWith(`${folded.project}/`))
        .map((link) => link.slice(folded.project.length + 1)),
      links: folded.plans,
      branch: folded.record.branch,
      machine: machines.get(folded.machine) ?? AD_HOC_ID,
      start: sessionStats?.start ?? folded.started,
      end: sessionStats?.end ?? AD_HOC_ID,
      models: modelsOf(sessionStats),
      tokens: sessionStats ? sessionTokens(sessionStats) : 0,
      policy: sessionPolicy(policies, linked),
      silenced: silenced(policies, linked),
    });
  }

  return lines.sort((left, right) => Date.parse(right.start) - Date.parse(left.start));
}

export function lineText(line: SessionLine): string {
  return [
    line.host,
    line.session,
    line.project,
    line.plans.length ? line.plans.join(",") : AD_HOC_ID,
    line.branch,
    line.machine,
    line.start,
    line.end,
    line.models.length ? line.models.join(",") : AD_HOC_ID,
    String(line.tokens),
    line.policy,
  ].join("\t");
}
