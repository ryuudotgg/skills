import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { inInbox } from "skills-core";
import { readDelivery } from "../delivery.ts";
import { readStaleMarks } from "../plans/leases.ts";
import { learnCheckout } from "../plans/machine.ts";
import { plansDir as resolvePlansDir } from "../plans/index-tsv.ts";
import { readPlans } from "../plans/projection.ts";
import { detectProject, gitOutput } from "../project.ts";
import type { Context } from "../registry.ts";
import { recordUpdate, sessionNotice } from "../update/notice.ts";
import { machineLine } from "./machine-refresh.ts";

const STDIN_WAIT_MS = 1000;

function complete(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

function stdinText(): Promise<string> {
  const stdin = process.stdin;
  if (stdin.isTTY) return Promise.resolve("");

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const done = () => {
      clearTimeout(timer);
      stdin.destroy();
      resolve(Buffer.concat(chunks).toString("utf8"));
    };

    const timer = setTimeout(done, STDIN_WAIT_MS);
    stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      if (complete(Buffer.concat(chunks).toString("utf8"))) done();
    });

    stdin.once("end", done);
    stdin.once("error", done);
  });
}

async function recordSession(): Promise<void> {
  const input = await stdinText();
  if (!input.trim()) return;

  const { recordHookSession } = await import("../sessions/ledger.ts");
  await recordHookSession(input, process.env);
}

function exists(path: string, kind: "file" | "directory"): boolean {
  try {
    const info = statSync(path);
    return kind === "file" ? info.isFile() : info.isDirectory();
  } catch {
    return false;
  }
}

async function collect(lines: string[], ctx: Context): Promise<void> {
  const delivery = readDelivery(ctx.root, process.env);
  lines.push(
    `Delivery: ${delivery.mode}${delivery.active.length ? `, with ${delivery.active.join(" ")}` : ""}${delivery.notes.length ? ` (${delivery.notes.join("; ")})` : ""}`,
  );

  const plansDir = resolvePlansDir();
  const hasPlans = exists(plansDir, "directory");
  const [status, project, learned] = await Promise.all([
    gitOutput(process.cwd(), ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], {
      quiet: true,
    }),
    hasPlans ? detectProject(process.cwd(), plansDir, true) : Promise.resolve(undefined),
    hasPlans ? learnCheckout(plansDir).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  const entries = status?.split("\n") ?? [];
  const head = entries.find((line) => line.startsWith("# branch.head "))?.slice(14);
  const branch = head === "(detached)" ? undefined : head;
  if (branch) {
    const changed = entries.filter((line) => /^(1 |2 |u |\? )/.test(line)).length;
    const untracked = entries.filter((line) => line.startsWith("? ")).length;
    lines.push(`Branch: ${branch}  (${changed} changed, ${untracked} untracked)`);
  }

  const machineAt = lines.length;
  const read = branch && hasPlans && project ? await readPlans() : undefined;

  if (hasPlans && existsSync(join(plansDir, "plans.db"))) {
    const machine = await machineLine(plansDir, learned, ctx.bin, ctx.root).catch(() => undefined);
    if (machine && branch) lines.splice(machineAt, 0, machine);
  }

  if (!branch || !read || !project) return;
  if (read.kind === "failed") {
    const fix = read.refused ? "; fix it, then run skills plans import" : "";
    lines.push(`${plansDir}: ${read.reason}${fix}`);
    return;
  }

  const rows = read.plans.projects.get(project);
  if (!rows) return;

  const ids = new Set(rows.filter((row) => row.branch === branch).map((row) => row.id));
  const mine = rows.filter((row) => ids.has(row.id));
  const stale = mine.some((row) => row.status === "DOING")
    ? await readStaleMarks(project, mine)
    : new Map<string, string>();

  for (const row of mine) {
    const mark = stale.get(row.id);
    lines.push(`Plan ${row.id} ${row.slug} [${row.status}] ${row.note}${mark ? ` ${mark}` : ""}`);
  }

  const open = rows.filter((row) =>
    ["TODO", "DOING", "BLOCKED", "REVIEW"].includes(row.status),
  ).length;

  lines.push(`${plansDir}/${project}: ${open} open. Run /plans for the frontier.`);

  const inbox = [...read.plans.issues.values()].filter(
    (issue) => issue.project === project && inInbox(issue),
  ).length;

  if (inbox > 0) lines.push(`Inbox: ${inbox} open, run skills issues list ${project}`);

  const trail = read.plans.trail
    .filter(
      (entry) => entry.project === project && (ids.has(entry.id) || entry.detail.includes(branch)),
    )
    .slice(-3)
    .map((entry) => entry.line);

  if (trail.length) lines.push("Recent trail:", ...trail);
}

type HubBrief = { readonly lines: string[]; readonly abandoned: boolean };

async function hubBrief(): Promise<HubBrief> {
  try {
    const { hubSetting } = await import("../hub/network.ts");
    if (hubSetting(process.env, "HUB_URL") === undefined) return { lines: [], abandoned: false };

    const { shortSyncWithin, unseenLines } = await import("../hub/sync.ts");
    if (!(await shortSyncWithin(process.env))) return { lines: [], abandoned: true };

    return { lines: await unseenLines(process.env), abandoned: false };
  } catch {
    return { lines: [], abandoned: false };
  }
}

export async function sessionStart(args: readonly string[], ctx: Context): Promise<number> {
  if (args[0] === "--record" && (args[1] === "check" || args[1] === "apply") && args[2])
    return recordUpdate(process.env, ctx.root, args[1], args[2]);

  if (process.env.AGENT_HOOKS === "0") return 0;

  const lines: string[] = [];
  const recorded = recordSession().catch(() => {});
  const chain = await hubBrief();
  const [, notice] = await Promise.all([
    collect(lines, ctx).catch(() => {}),
    sessionNotice(process.env, ctx.bin, ctx.root).catch(() => undefined),
  ]);

  lines.push(...chain.lines);

  if (notice) lines.splice(1, 0, notice);

  process.stdout.write(
    `${JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") },
      ...(notice ? { systemMessage: notice } : {}),
    })}\n`,
  );

  await recorded;
  if (chain.abandoned) process.exit(0);
  return 0;
}
