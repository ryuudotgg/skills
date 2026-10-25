import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { processIo, type Io } from "../io.ts";
import { readDelivery } from "../delivery.ts";
import { ghOutput } from "../gh.ts";
import { commandRunner, GhGitHubReader, WatcherQueryError } from "../pr/github.ts";
import { greenClock, lines, waitForGreen } from "../pr/green.ts";
import type { WatchClock } from "../pr/policy.ts";
import { reviewerDeclarations } from "../pr/watch.ts";
import { parsePrNumber, type GitHubReader, type ReviewerDeclarations } from "../pr/types.ts";
import { checkoutIs, detectProject, readCheckout } from "../project.ts";
import { chain } from "../stack/skills-base.ts";
import { next, renderFrontier, stacksOn } from "./frontier.ts";
import {
  cleanNote,
  COLUMNS,
  flatten,
  formatRow,
  indexPath,
  missingIndex,
  isStatus,
  plansDir,
  projectDir,
  readIndex,
  replaceDurably,
  today,
  updateIndex,
  type IndexRow,
} from "./index-tsv.ts";
import { appendLog, bookkeepingEvents, lastEvent, logDetail } from "./trail.ts";
import { landedHeading, lint } from "./lint.ts";

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
  if (!isFile(index)) return stop(`${missingIndex(project)} (run /plans new to bootstrap)`);

  const rows = readIndex(index);
  if (mode === "next") {
    const id = next(rows);
    if (id !== undefined) out(`${id}\n`);
  } else if (mode === "stacks") for (const id of stacksOn(rows, stack)) out(`${id}\n`);
  else out(renderFrontier(rows));

  return 0;
}

type ReaderFactory = (reviewers: ReviewerDeclarations, io: Io) => GitHubReader;

const handoffReader: ReaderFactory = (reviewers, io) =>
  new GhGitHubReader(reviewers, commandRunner({ cwd: io.cwd, env: io.env }));

async function reviewGate(
  project: string,
  row: IndexRow,
  branch: string,
  root: string,
  io: Io,
  readerFactory: ReaderFactory,
  clock: WatchClock,
): Promise<string | undefined> {
  if (!branch || branch === "-") return `row ${row.id} has no branch, so no PR to check`;

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return elsewhere;
  if (!Bun.which("gh", { PATH: io.env.PATH })) return "gh not found, cannot check PR";

  const output = await ghOutput(
    ["pr", "list", "--head", branch, "--state", "all", "--json", "number,state"],
    io,
  );

  if (output === undefined) return `cannot list PRs for ${branch}`;

  let prs: { number: ReturnType<typeof parsePrNumber>; state: string }[];
  try {
    const value: unknown = JSON.parse(output);
    if (!Array.isArray(value)) throw new Error("PR list is not an array");

    prs = value.map((pr: unknown) => {
      if (
        typeof pr !== "object" ||
        pr === null ||
        !("number" in pr) ||
        !("state" in pr) ||
        typeof pr.state !== "string" ||
        !["OPEN", "MERGED", "CLOSED"].includes(pr.state)
      )
        throw new Error("invalid PR list entry");

      return { number: parsePrNumber(pr.number), state: pr.state };
    });
  } catch (error) {
    return `cannot read PR list for ${branch}: ${error instanceof Error ? error.message : String(error)}`;
  }

  const open = prs.find((pr) => pr.state === "OPEN");
  if (!open)
    return prs.some((pr) => pr.state === "MERGED")
      ? undefined
      : `no open or merged PR for ${branch}`;

  const reviewers = reviewerDeclarations(root);
  const reader = readerFactory(reviewers, io);

  let result: { lines: string[]; code: number };
  try {
    const context = await reader.currentPr(open.number);
    result = await waitForGreen([context], reader, clock, reviewers.checks, 30, 180);
  } catch (error) {
    if (!(error instanceof WatcherQueryError)) throw error;

    result = {
      lines: lines(open.number, {
        kind: "waiting",
        holds: [{ kind: "unreadable", detail: error.message }],
      }),
      code: 1,
    };
  }

  if (result.code === 0) return undefined;

  io.err(`${result.lines.join("\n")}\n`);
  return `${row.id} stays ${row.status}: #${open.number} is not green and mergeable. Wait with skills pr green ${open.number}, fix what it names, then set REVIEW again.`;
}

export async function setRowVerb(
  args: readonly string[],
  usage: string,
  root: string,
  io: Io = processIo(),
  readerFactory: ReaderFactory = handoffReader,
  clock: WatchClock = greenClock,
): Promise<number> {
  const [project, id, status, branch, note] = args;
  if (!project || !id || !status || args.length > 5) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const index = indexPath(project, io.env);
  if (!isFile(index)) {
    io.err(`${missingIndex(project)}\n`);
    return 1;
  }

  if (!isStatus(status)) {
    io.err(`bad status: ${status}\n`);
    return 1;
  }

  if (status === "REVIEW" && readDelivery(root, io.env).mode === "prs") {
    const row = readIndex(index).find((entry) => entry.id === id);
    if (!row) {
      io.err(`id not found: ${id}\n`);
      return 1;
    }

    const refusal = await reviewGate(
      project,
      row,
      branch !== undefined && branch !== "-" ? branch : row.branch,
      root,
      io,
      readerFactory,
      clock,
    );

    if (refusal !== undefined) {
      io.err(`set-row: ${refusal}\n`);
      return 1;
    }
  }

  const updated = await setRow(index, id, status, branch, note);
  if (!updated) {
    io.err(`id not found: ${id}\n`);
    return 1;
  }

  io.out(`${formatRow(updated)}\n`);
  return 0;
}

async function setRow(
  index: string,
  id: string,
  status: string,
  branch?: string,
  note?: string,
): Promise<IndexRow | undefined> {
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
    return readdirSync(directory).filter(
      (name) => /^[0-9]{3}-.*\.md$/.test(name) && isFile(`${directory}/${name}`),
    );
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
    err(`${missingIndex(project)}\n`);
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
      throw new Error(
        `id ${own} is already in the index as ${taken.slug}; renumber ${own}-${slug}.md and every reference to it`,
      );

    const highest = Math.max(
      0,
      ...[...rows.map((entry) => entry.id), ...files.map((name) => name.slice(0, 3))]
        .map(Number)
        .filter(Number.isSafeInteger),
    );

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

  await appendLog(project, id, event, detail);
  return 0;
}

export async function markStarted(
  index: string,
  project: string,
  id: string,
  branch: string,
  expected: IndexRow,
  env: NodeJS.ProcessEnv = process.env,
): Promise<IndexRow | { refusal: string } | undefined> {
  return updateIndex(
    index,
    (rows) => {
      const row = rows.find((entry) => entry.id === id);
      if (!row) return undefined;

      if (formatRow(row) !== formatRow(expected)) {
        const changes = COLUMNS.filter(
          (column) => flatten(row[column]) !== flatten(expected[column]),
        )
          .map((column) => `${column} ${expected[column]} -> ${row[column]}`)
          .join(", ");

        return { refusal: changes };
      }

      row.status = "DOING";
      row.branch = branch;
      row.updated = today();
      return row;
    },
    async (row) => {
      if (!row || "refusal" in row) return;

      const previous = lastEvent(project, id, env, bookkeepingEvents);
      if (previous?.event !== "start" || previous.detail !== logDetail(branch))
        await appendLog(project, id, "start", branch, env);
    },
  );
}

type Refusal = { refusal: string; draftless?: string };
type Closed = IndexRow | "closed" | Refusal;
type PlanFile = { source: string; destination: string; atSource: boolean; atDestination: boolean };

function planFile(index: string, row: IndexRow): PlanFile | Refusal {
  const source = join(dirname(index), `${row.id}-${row.slug}.md`);
  const destination = join(dirname(index), "done", `${row.id}-${row.slug}.md`);

  const atSource = isFile(source);
  const atDestination = isFile(destination);
  if (atSource && atDestination)
    return { refusal: `plan file exists at both ${source} and ${destination}` };

  if (!atSource && !atDestination)
    return { refusal: `no plan file at ${source} or ${destination}` };

  const path = atSource ? source : destination;
  if (!landedHeading(readFileSync(path, "utf8")))
    return { refusal: "write the Landed section first (## Landed)", draftless: path };

  return { source, destination, atSource, atDestination };
}

function landedDraft(path: string): { branch: string; start: number; end: number } | undefined {
  const text = readFileSync(path, "utf8");
  const heading = landedHeading(text);
  if (!heading) return undefined;

  const first = /^(?:[ \t]*\r?\n)*([^\r\n]+)/.exec(text.slice(heading.end));
  const line = first?.[1];
  const branch = line && /^Branch (.+), not merged yet\.[ \t]*$/.exec(line)?.[1];
  if (!first || !line || !branch) return undefined;

  const offset = heading.end + first[0].length - line.length;
  const start = Buffer.byteLength(text.slice(0, offset), "utf8");
  return { branch, start, end: start + Buffer.byteLength(line, "utf8") };
}

async function mergedPlanPr(branch: string): Promise<{ number: number; sha: string } | undefined> {
  const output = await ghOutput([
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "merged",
    "--json",
    "number,mergeCommit",
    "--limit",
    "1",
  ]);

  if (output === undefined) return undefined;

  try {
    const value: unknown = JSON.parse(output);
    const pr: unknown = Array.isArray(value) ? value[0] : undefined;
    if (
      typeof pr !== "object" ||
      pr === null ||
      !("number" in pr) ||
      typeof pr.number !== "number" ||
      !Number.isSafeInteger(pr.number) ||
      pr.number <= 0 ||
      !("mergeCommit" in pr) ||
      typeof pr.mergeCommit !== "object" ||
      pr.mergeCommit === null ||
      !("oid" in pr.mergeCommit) ||
      typeof pr.mergeCommit.oid !== "string" ||
      !/^[0-9a-f]{7,40}$/i.test(pr.mergeCommit.oid)
    )
      return undefined;

    return { number: pr.number, sha: pr.mergeCommit.oid };
  } catch {
    return undefined;
  }
}

export function mergedLine(sha: string, branch: string, pr?: number): string {
  const short = sha.slice(0, 7).toLowerCase();
  return pr === undefined
    ? `Merged as ${short} (branch ${branch}).`
    : `Merged as ${short} (PR ${pr}, branch ${branch}).`;
}

export type CloseStatus = "DONE" | "DROPPED";
export type Stamp = (draftBranch: string) => Promise<string | { refusal: string }>;
export type CloseRequest = {
  index: string;
  project: string;
  id: string;
  status: CloseStatus;
  note: string;
  stamp: Stamp;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  guard?: (row: IndexRow) => string | undefined;
};

export type CloseResult =
  | { kind: "closed"; row: IndexRow; landed: string | undefined }
  | { kind: "already" }
  | { kind: "refused"; reason: string; draftless?: string };

function refused({ refusal, draftless }: Refusal): CloseResult {
  return { kind: "refused", reason: refusal, draftless };
}

function closedAlready(
  project: string,
  row: IndexRow,
  file: PlanFile,
  env: NodeJS.ProcessEnv,
): boolean {
  return (
    (row.status === "DONE" || row.status === "DROPPED") &&
    file.atDestination &&
    lastEvent(project, row.id, env)?.event === "done"
  );
}

export async function closePlan({
  index,
  project,
  id,
  status,
  note,
  stamp,
  dryRun,
  env = process.env,
  guard = () => undefined,
}: CloseRequest): Promise<CloseResult> {
  const listed = readIndex(index).find((entry) => entry.id === id);
  if (!listed) return { kind: "refused", reason: `id ${id} not in ${index}` };

  const checked = planFile(index, listed);
  if ("refusal" in checked) return refused(checked);
  if (closedAlready(project, listed, checked, env)) return { kind: "already" };

  const changed = guard(listed);
  if (changed) return { kind: "refused", reason: changed };

  const draft =
    status === "DONE"
      ? landedDraft(checked.atSource ? checked.source : checked.destination)
      : undefined;

  let landed: string | undefined;
  if (draft) {
    const stamped = await stamp(draft.branch);
    if (typeof stamped !== "string") return { kind: "refused", reason: stamped.refusal };
    landed = stamped;
  }

  if (dryRun) {
    const row = { ...listed, status, note: cleanNote(note), updated: today() };
    return { kind: "closed", row, landed };
  }

  const result = await updateIndex(
    index,
    (rows): Closed => {
      const row = rows.find((entry) => entry.id === id);
      if (!row) return { refusal: `id ${id} not in ${index}` };

      const file = planFile(index, row);
      if ("refusal" in file) return file;
      if (closedAlready(project, row, file, env)) return "closed";

      const changed = guard(row);
      if (changed) return { refusal: changed };

      const { source, destination, atSource } = file;
      const path = atSource ? source : destination;
      const currentDraft = status === "DONE" ? landedDraft(path) : undefined;
      if (currentDraft && (!landed || currentDraft.branch !== draft?.branch))
        return { refusal: "Landed draft changed during close, retry" };

      if (currentDraft && landed) {
        const bytes = readFileSync(path);
        replaceDurably(
          path,
          Buffer.concat([
            bytes.subarray(0, currentDraft.start),
            Buffer.from(landed, "utf8"),
            bytes.subarray(currentDraft.end),
          ]),
        );
      }

      if (atSource) {
        mkdirSync(dirname(destination), { recursive: true });
        renameSync(source, destination);
      }

      row.status = status;
      row.note = cleanNote(note);
      row.updated = today();
      return row;
    },
    async (closed) => {
      if (
        typeof closed === "object" &&
        !("refusal" in closed) &&
        lastEvent(project, id, env)?.event !== "done"
      )
        await appendLog(project, id, "done", cleanNote(note), env);
    },
  );

  if (result === "closed") return { kind: "already" };
  if ("refusal" in result) return refused(result);

  return { kind: "closed", row: result, landed };
}

export async function closeVerb(args: readonly string[], usage: string): Promise<number> {
  const positional: string[] = [];

  let dryRun = false;
  let sha: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--sha") {
      sha = args[++index];
      if (!sha || !/^[0-9a-f]{7,40}$/i.test(sha)) return usageError(usage);
    } else positional.push(arg);
  }

  const [project = "", id = "", status = "", note = ""] = positional;
  if (positional.length !== 4 || (status !== "DONE" && status !== "DROPPED") || !note)
    return usageError(usage);

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

  if (!isFile(index)) return refuse(missingIndex(project));

  const stamp: Stamp = async (branch) => {
    const elsewhere = await checkoutIs(process.cwd(), project);
    if (elsewhere && !sha) return { refusal: `${elsewhere}, pass --sha <sha>` };

    const pr = elsewhere ? undefined : await mergedPlanPr(branch);
    const mergedSha = sha ?? pr?.sha;
    if (!mergedSha) return { refusal: `PR for ${branch} is not merged, pass --sha <sha>` };

    return mergedLine(mergedSha, branch, pr?.number);
  };

  const result = await closePlan({ index, project, id, status, note, stamp, dryRun });
  if (result.kind === "refused") return refuse(result.reason);

  if (result.kind === "already") {
    out(`${id} is already closed\n`);
    return 0;
  }

  out(`${formatRow(result.row)}\n`);
  if (dryRun && result.landed) out(`landed: ${result.landed}\n`);
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

export async function handoffVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
): Promise<number> {
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
  if (!isFile(index)) return refuse(missingIndex(project));

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

export async function chainVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
): Promise<number> {
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
