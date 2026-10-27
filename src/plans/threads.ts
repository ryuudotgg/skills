import { readdirSync } from "node:fs";
import { join } from "node:path";
import { processIo, type Io } from "../io.ts";
import { detectProject, gitRead, readCheckout } from "../project.ts";
import { describe } from "../read.ts";
import { ownedKey } from "../stack/skills-base.ts";
import { indexIn, plansDir, readIndexTolerant } from "./index-tsv.ts";
import { AD_HOC_ID, appendLog } from "./trail.ts";

export const AD_HOC_EVENTS = ["start", "handback", "nudge"] as const;

function indexedIn(branch: string, env: NodeJS.ProcessEnv): string | undefined {
  const root = plansDir(env);

  let projects: string[];
  try {
    projects = readdirSync(root).filter((name) => !name.startsWith("."));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return `cannot read ${root}`;
  }

  for (const project of projects.sort()) {
    const index = indexIn(join(root, project));
    const table = readIndexTolerant(index);
    if (table.kind === "failed") return `cannot read ${index}`;
    if (table.kind === "rows" && table.rows.some((row) => row.branch === branch))
      return `${branch} is in ${index}, so its row keeps the trail`;
  }

  return undefined;
}

export async function threadsLogVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
): Promise<number> {
  const [branch, event, detail = ""] = args;
  if (!branch || !event || args.length > 3 || branch.startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const refuse = (reason: string): number => {
    io.err(`threads log: ${reason}\n`);
    return 1;
  };

  if (!(AD_HOC_EVENTS as readonly string[]).includes(event))
    return refuse(`${event} is not one of ${AD_HOC_EVENTS.join(", ")}`);

  const indexed = indexedIn(branch, io.env);
  if (indexed) return refuse(indexed);

  const key = ownedKey(branch);
  const mark = await gitRead(io.cwd, ["config", "--get", key], {}, io);
  if (!mark.ok) return refuse(`cannot read ${key} (${describe(mark.failure)})`);
  if (mark.code > 1) return refuse(`cannot read ${key} (git config exited ${mark.code})`);
  if (mark.stdout.trim() !== "true") return refuse(`${branch} carries no publish mark`);

  const project =
    (await detectProject(io.cwd, plansDir(io.env), true)) ??
    (await readCheckout(io.cwd, true, io)).candidates.at(-1)!;

  await appendLog(project, AD_HOC_ID, event, detail ? `${branch} ${detail}` : branch, io.env);
  return 0;
}
