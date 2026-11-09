import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  AD_HOC_ID,
  isSessionPolicy,
  POLICY_EVENT,
  SESSION_POLICIES,
  type SessionPolicy,
} from "skills-core";
import type { Io } from "../io.ts";
import { openPlansStore } from "../plans/commit.ts";
import { Refusal } from "../plans/import.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { readStore } from "../plans/projection.ts";
import { appendEvent, write } from "../plans/store.ts";
import { lineText, sessionLines } from "./ledger.ts";
import { localLinks, projectPolicies } from "./policy.ts";
import { scanSessions } from "./scan.ts";
import { hostDirs } from "./transcripts.ts";

function usageError(io: Io, usage: string): number {
  io.err(`usage: ${usage}\n`);
  return 2;
}

export async function scanVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  if (args.length) return usageError(io, usage);

  try {
    const { scanned, changed } = await scanSessions(plansDir(io.env), hostDirs(io.env));
    io.out(`scanned ${scanned} transcripts, ${changed} changed\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`sessions scan: ${error.message}\n`);
    return 1;
  }
}

type Filter = { project?: string; plan?: { project: string; id: string } };

function filterFrom(args: readonly string[]): Filter | undefined {
  const filter: Filter = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--plan") {
      const match = /^([^/\s]+)\/(\d{3})$/.exec(args[++index] ?? "");
      if (!match || filter.plan) return undefined;

      filter.plan = { project: match[1]!, id: match[2]! };
      continue;
    }

    if (arg.startsWith("--") || filter.project !== undefined) return undefined;

    filter.project = arg;
  }

  return filter;
}

export async function listVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const filter = filterFrom(args);
  if (!filter) return usageError(io, usage);

  const root = plansDir(io.env);
  const read = await readStore(root, (store) => sessionLines(store, localLinks(root)));
  if (read.kind === "failed") {
    io.err(`sessions list: ${read.reason}\n`);
    return 1;
  }

  const lines = read.kind === "read" ? read.value : [];
  const { project, plan } = filter;
  for (const line of lines) {
    if (line.silenced) continue;
    if (project !== undefined && line.project !== project) continue;
    if (plan && !line.links.includes(`${plan.project}/${plan.id}`)) continue;

    io.out(`${lineText(line)}\n`);
  }

  return 0;
}

function projectRefusal(root: string, name: string): string | undefined {
  let entries: string[];
  try {
    entries = readdirSync(root).filter((entry) => {
      if (entry.startsWith(".")) return false;

      try {
        return statSync(join(root, entry)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    entries = [];
  }

  if (name !== AD_HOC_ID && entries.includes(name)) return undefined;

  const near = entries.find((entry) => entry.toLowerCase() === name.toLowerCase());
  return `no project ${name} in ${root}${near ? `, did you mean ${near}` : ""}`;
}

async function setPolicy(root: string, project: string, policy: SessionPolicy): Promise<void> {
  const store = await openPlansStore(root);
  try {
    write(store, () => {
      if (projectPolicies(store).get(project) === policy) return;

      appendEvent(store, {
        kind: "stored",
        type: POLICY_EVENT,
        at: Date.now(),
        project,
        plan: AD_HOC_ID,
        payload: { policy },
      });
    });
  } finally {
    store.db.close();
  }
}

export async function policyVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const [project, wanted, ...rest] = args;
  if (!project || project.startsWith("--") || rest.length) return usageError(io, usage);

  if (wanted !== undefined && !isSessionPolicy(wanted)) {
    io.err(`sessions policy: ${wanted} is not a policy, pass ${SESSION_POLICIES.join(", ")}\n`);
    return 2;
  }

  const root = plansDir(io.env);
  const refusal = projectRefusal(root, project);
  if (refusal) {
    io.err(`sessions policy: ${refusal}\n`);
    return 1;
  }

  try {
    if (wanted) {
      await setPolicy(root, project, wanted);
      io.out(`${project} ${wanted}\n`);
      return 0;
    }

    const read = await readStore(root, (store) => projectPolicies(store).get(project));
    if (read.kind === "failed") throw new Refusal(read.reason);

    const policy = read.kind === "read" ? read.value : undefined;
    io.out(policy ? `${project} ${policy}\n` : `${project} redacted (default)\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`sessions policy: ${error.message}\n`);
    return 1;
  }
}
