import { homedir } from "node:os";
import type { Io } from "../io.ts";
import { Refusal } from "../plans/import.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { readStore } from "../plans/projection.ts";
import { lineText, sessionLines } from "./ledger.ts";
import { scanSessions } from "./scan.ts";

function usageError(io: Io, usage: string): number {
  io.err(`usage: ${usage}\n`);
  return 2;
}

export async function scanVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  if (args.length) return usageError(io, usage);

  try {
    const { scanned, changed } = await scanSessions(plansDir(io.env), io.env.HOME || homedir());
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

  const read = await readStore(plansDir(io.env), sessionLines);
  if (read.kind === "failed") {
    io.err(`sessions list: ${read.reason}\n`);
    return 1;
  }

  const lines = read.kind === "read" ? read.value : [];
  const { project, plan } = filter;
  for (const line of lines) {
    if (project !== undefined && line.project !== project) continue;
    if (plan && !line.links.includes(`${plan.project}/${plan.id}`)) continue;
    io.out(`${lineText(line)}\n`);
  }

  return 0;
}
