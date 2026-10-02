import { statSync } from "node:fs";
import { readDelivery } from "../delivery.ts";
import { indexPath, plansDir as resolvePlansDir, readIndex } from "../plans/index-tsv.ts";
import { readTrail, trailPath } from "../plans/trail.ts";
import { detectProject, gitOutput } from "../project.ts";
import type { Context } from "../registry.ts";

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
  const [status, project] = await Promise.all([
    gitOutput(process.cwd(), ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], {
      quiet: true,
    }),
    hasPlans ? detectProject(process.cwd(), plansDir, true) : Promise.resolve(undefined),
  ]);

  const entries = status?.split("\n") ?? [];
  const branch = entries.find((line) => line.startsWith("# branch.head "))?.slice(14);
  if (!branch || branch === "(detached)") return;

  const changed = entries.filter((line) => /^(1 |2 |u |\? )/.test(line)).length;
  const untracked = entries.filter((line) => line.startsWith("? ")).length;
  lines.push(`Branch: ${branch}  (${changed} changed, ${untracked} untracked)`);
  if (!hasPlans || !project) return;

  const index = indexPath(project);
  if (!exists(index, "file")) return;

  const rows = readIndex(index, true);
  const id = rows.slice(1).find((row) => row.branch === branch)?.id ?? "";
  if (id)
    for (const row of rows.filter((row) => row.id === id))
      lines.push(`Plan ${row.id} ${row.slug} [${row.status}] ${row.note}`);

  const open = rows
    .slice(1)
    .filter((row) => ["TODO", "DOING", "BLOCKED", "REVIEW"].includes(row.status)).length;

  lines.push(`${plansDir}/${project}: ${open} open. Run /plans for the frontier.`);

  const log = trailPath();
  if (!exists(log, "file")) return;

  const trail = readTrail(log)
    .filter((entry) => {
      return (
        entry.project === project &&
        ((id !== "" && entry.id === id) || entry.detail.includes(branch))
      );
    })
    .slice(-3)
    .map((entry) => entry.line);

  if (trail.length) lines.push("Recent trail:", ...trail);
}

export async function sessionStart(_args: readonly string[], ctx: Context): Promise<number> {
  if (process.env.AGENT_HOOKS === "0") return 0;

  const lines: string[] = [];
  try {
    await collect(lines, ctx);
  } catch {}

  process.stdout.write(
    `${JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: lines.join("\n") } })}\n`,
  );

  return 0;
}
