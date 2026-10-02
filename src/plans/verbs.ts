import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { processIo, type Io } from "../io.ts";
import { checkoutIs, detectProject, readCheckout } from "../project.ts";
import { chain } from "../stack/skills-base.ts";
import { next, renderFrontier, stacksOn } from "./frontier.ts";
import {
  cleanNote,
  flatten,
  formatRow,
  indexPath,
  isStatus,
  plansDir,
  projectDir,
  readIndex,
  today,
  updateIndex,
  type IndexRow,
} from "./index-tsv.ts";
import { lint } from "./lint.ts";


function out(text: string): void {
  process.stdout.write(text);
}

function err(text: string): void {
  process.stderr.write(text);
}

function usageError(usage: string): number {
  err(`usage: ${usage}\n`);
  return 2;
}

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

function dash(value: string | undefined): string {
  return value === undefined || value === "" ? "-" : value;
}

export async function frontierVerb(args: readonly string[], usage: string): Promise<number> {
  const rest = [...args];

  let mode: "default" | "next" | "stacks" = "default";
  let stack = "";
  if (rest[0] === "--next") {
    mode = "next";
    rest.shift();
  } else if (rest[0] === "--stacks-on") {
    if (rest.length < 2) return usageError(usage);

    mode = "stacks";
    stack = rest[1] ?? "";
    rest.splice(0, 2);
  } else if (rest[0]?.startsWith("-")) return usageError(usage);

  if (rest.length > 1) return usageError(usage);

  const stop = (...lines: string[]): number => {
    if (mode === "default") {
      out(`${lines.join("\n")}\n`);
      return 0;
    }

    err(`${lines.join("\n")}\n`);
    return 1;
  };

  const plans = plansDir();

  let project = rest[0] ?? "";
  if (project === "") {
    const detected = await detectProject(process.cwd(), plans);
    if (!detected) {
      const { repo } = await readCheckout(process.cwd());
      const miss = `no project under ${plans} matches '${repo}'. Pass one: /plans <Project>`;
      if (!existsSync(plans) || !statSync(plans).isDirectory())
        return stop(miss, `${plans} does not exist. Create it, or set PLANS_DIR.`);

      const known = readdirSync(plans)
        .filter((name) => !name.startsWith("."))
        .sort()
        .map((name) => `${name} `)
        .join("");

      return known ? stop(miss, `known projects: ${known}`) : stop(miss);
    }

    project = detected;
  }

  const index = indexPath(project);
  if (!isFile(index)) return stop(`no index.tsv for ${project} (run /plans new to bootstrap)`);

  const rows = readIndex(index);
  if (mode === "next") {
    const id = next(rows);
    if (id !== undefined) out(`${id}\n`);
  } else if (mode === "stacks")
    for (const id of stacksOn(rows, stack)) out(`${id}\n`);
  else out(renderFrontier(rows));

  return 0;
}

export async function setRowVerb(args: readonly string[], usage: string): Promise<number> {
  const [project, id, status, branch, note] = args;
  if (!project || !id || !status || args.length > 5) return usageError(usage);

  const index = indexPath(project);
  if (!isFile(index)) {
    err(`no index.tsv for ${project}\n`);
    return 1;
  }

  if (!isStatus(status)) {
    err(`bad status: ${status}\n`);
    return 1;
  }

  const updated = await setRow(index, id, status, branch, note);
  if (!updated) {
    err(`id not found: ${id}\n`);
    return 1;
  }

  out(`${formatRow(updated)}\n`);
  return 0;
}

async function setRow(index: string, id: string, status: string, branch?: string, note?: string): Promise<IndexRow | undefined> {
  return updateIndex(index, (rows) => {
    const matches = rows.filter((row) => row.id === id);
    for (const row of matches) {
      row.status = status;
      if (dash(branch) !== "-") row.branch = branch ?? "";
      if (dash(note) !== "-") row.note = cleanNote(note ?? "");
      row.updated = today();
    }

    return matches[0];
  });
}

function planFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter((name) => /^[0-9]{3}-.*\.md$/.test(name) && isFile(`${directory}/${name}`));
  } catch {
    return [];
  }
}

const PRIORITIES = ["P0", "P1", "P2", "P3"];
const EFFORTS = ["XS", "S", "M", "L"];

export async function addVerb(args: readonly string[], usage: string): Promise<number> {
  const [project, slug, pri, effort, blockedBy, ctx, note] = args;
  if (!project || !slug || !pri || !effort || args.length > 7) return usageError(usage);

  const problem = !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)
    ? `slug is not kebab case: ${slug}`
    : !PRIORITIES.includes(pri)
      ? `bad pri: ${pri}`
      : !EFFORTS.includes(effort)
        ? `bad effort: ${effort}`
        : !/^(-|[0-9]{3}(,[0-9]{3})*)$/.test(dash(blockedBy))
          ? `bad blocked_by: ${blockedBy}`
          : !/^(-|ctx-[a-z0-9-]+)$/.test(dash(ctx))
            ? `bad ctx: ${ctx}`
            : undefined;

  if (problem) {
    err(`${problem}\n`);
    return 1;
  }

  const index = indexPath(project);
  if (!isFile(index)) {
    err(`no index.tsv for ${project}\n`);
    return 1;
  }

  const directory = dirname(index);
  const row = await updateIndex(index, (rows) => {
    const files = [directory, `${directory}/done`].flatMap((path) => planFiles(path));
    const own = files.find((name) => name.slice(4) === `${slug}.md`)?.slice(0, 3);
    const taken = rows.find((entry) => entry.id === own);
    if (taken?.slug === slug) return taken;

    const twin = rows.find((entry) => entry.slug === slug);
    if (twin) throw new Error(`slug ${slug} is already in the index as ${twin.id}`);

    if (taken)
      throw new Error(`id ${own} is already in the index as ${taken.slug}; renumber ${own}-${slug}.md and every reference to it`);

    const highest = Math.max(0, ...[...rows.map((entry) => entry.id), ...files.map((name) => name.slice(0, 3))].map(Number).filter(Number.isSafeInteger));
    if (own === undefined && highest >= 999) throw new Error("no three digit id is left");

    const added: IndexRow = {
      id: own ?? String(highest + 1).padStart(3, "0"),
      slug,
      status: "TODO",
      pri,
      effort,
      blocked_by: dash(blockedBy),
      ctx: dash(ctx),
      branch: "-",
      updated: today(),
      note: dash(note) === "-" ? "-" : cleanNote(note ?? ""),
    };

    rows.push(added);
    return added;
  });

  out(`${formatRow(row)}\n`);
  return 0;
}

export async function logVerb(args: readonly string[], usage: string): Promise<number> {
  const [project, id, event, detail = ""] = args;
  if (!project || !id || !event || args.length > 4) return usageError(usage);

  appendLog(project, id, event, detail);
  return 0;
}

function logDetail(detail: string): string {
  return flatten(detail).slice(0, 140);
}

function appendLog(project: string, id: string, event: string, detail: string, env: NodeJS.ProcessEnv = process.env): void {
  const log = `${plansDir(env)}/log.tsv`;
  mkdirSync(dirname(log), { recursive: true });

  try {
    writeFileSync(log, "ts\tproject\tid\tevent\tdetail\n", { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const fields = [stamp, project, id, event, logDetail(detail)].map(flatten);
  appendFileSync(log, `${fields.join("\t")}\n`);
}

function lastEvent(project: string, id: string, env: NodeJS.ProcessEnv = process.env): { event: string; detail: string } | undefined {
  const log = join(plansDir(env), "log.tsv");
  if (!isFile(log)) return undefined;

  const fields = readFileSync(log, "utf8").split("\n").slice(1).map((line) => line.split("\t"))
    .findLast((entry) => entry[1] === project && entry[2] === id);

  return fields ? { event: fields[3] ?? "", detail: fields[4] ?? "" } : undefined;
}

export async function markStarted(index: string, project: string, id: string, branch: string, env: NodeJS.ProcessEnv = process.env): Promise<IndexRow | undefined> {
  return updateIndex(index, (rows) => {
    const row = rows.find((entry) => entry.id === id);
    if (!row) return undefined;

    row.status = "DOING";
    row.branch = branch;
    row.updated = today();
    return row;
  }, (row) => {
    const previous = lastEvent(project, id, env);
    if (row && (previous?.event !== "start" || previous.detail !== logDetail(branch))) appendLog(project, id, "start", branch, env);
  });
}

type Closed = IndexRow | "closed" | { refusal: string };
type PlanFile = { source: string; destination: string; atSource: boolean; atDestination: boolean };

function planFile(index: string, row: IndexRow): PlanFile | { refusal: string } {
  const source = join(dirname(index), `${row.id}-${row.slug}.md`);
  const destination = join(dirname(index), "done", `${row.id}-${row.slug}.md`);

  const atSource = isFile(source);
  const atDestination = isFile(destination);
  if (atSource && atDestination) return { refusal: `plan file exists at both ${source} and ${destination}` };
  if (!atSource && !atDestination) return { refusal: `no plan file at ${source} or ${destination}` };

  if (!/^## Landed[ \t]*\r?$/m.test(readFileSync(atSource ? source : destination, "utf8")))
    return { refusal: "write the Landed section first (## Landed)" };

  return { source, destination, atSource, atDestination };
}

export async function closeVerb(args: readonly string[], usage: string): Promise<number> {
  const [project = "", id = "", status = "", note = ""] = args;
  if (args.length !== 4 || !["DONE", "DROPPED"].includes(status) || !note) return usageError(usage);

  const refuse = (reason: string): number => {
    err(`close: ${reason}\n`);
    return 1;
  };

  let index: string;
  try {
    index = indexPath(project);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  if (!isFile(index)) return refuse(`no index.tsv for ${project}`);

  const listed = readIndex(index).find((entry) => entry.id === id);
  if (!listed) return refuse(`id ${id} not in ${index}`);

  const checked = planFile(index, listed);
  if ("refusal" in checked) return refuse(checked.refusal);

  const result = await updateIndex(index, (rows): Closed => {
    const row = rows.find((entry) => entry.id === id);
    if (!row) return { refusal: `id ${id} not in ${index}` };

    const file = planFile(index, row);
    if ("refusal" in file) return file;

    const { source, destination, atSource, atDestination } = file;
    const logged = lastEvent(project, id)?.event === "done";
    if ((row.status === "DONE" || row.status === "DROPPED") && atDestination && logged) return "closed";

    if (atSource) {
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(source, destination);
    }

    row.status = status;
    row.note = cleanNote(note);
    row.updated = today();
    return row;
  }, (closed) => {
    if (typeof closed === "object" && !("refusal" in closed) && lastEvent(project, id)?.event !== "done")
      appendLog(project, id, "done", cleanNote(note));
  });

  if (result === "closed") {
    out(`${id} is already closed\n`);
    return 0;
  }

  if ("refusal" in result) return refuse(result.refusal);

  out(`${formatRow(result)}\n`);
  return 0;
}

export async function lintVerb(args: readonly string[], usage: string): Promise<number> {
  const [project, id] = args;
  if (!project || args.length > 2) return usageError(usage);

  const result = lint(projectDir(project), project, id || undefined);
  out(result.stdout);
  err(result.stderr);

  return result.code;
}

export async function handoffVerb(args: readonly string[], usage: string, io: Io = processIo()): Promise<number> {
  if (args.length !== 2) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const [project = "", id = ""] = args;
  const refuse = (reason: string): number => {
    io.err(`handoff: ${reason}\n`);
    return 1;
  };

  const index = indexPath(project, io.env);
  if (!isFile(index)) return refuse(`no index.tsv for ${project}`);

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return refuse(elsewhere);

  const rows = readIndex(index);
  const row = rows.find((entry) => entry.id === id);
  if (!row) return refuse(`id ${id} not found`);
  if (row.status !== "DOING") return refuse(`row ${id} is ${row.status}, not DOING`);
  if (row.branch === "" || row.branch === "-") return refuse(`row ${id} has no branch`);

  const asReview = rows.map((entry) => (entry.id === id ? { ...entry, status: "REVIEW" } : entry));
  const result = await chain(io.cwd, row.branch, io);
  if (!result.ok) return refuse(result.reason);

  io.out(`babysit ${result.stack.join(" ")}\n`);
  for (const ready of stacksOn(asReview, id)) io.out(`next ${ready}\n`);

  return 0;
}

export async function chainVerb(args: readonly string[], usage: string, io: Io = processIo()): Promise<number> {
  if (args.length !== 1) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const result = await chain(io.cwd, args[0] ?? "", io);
  if (!result.ok) {
    io.err(`chain: ${result.reason}\n`);
    return 1;
  }

  io.out(`${result.stack.join("\n")}\n`);
  return 0;
}
