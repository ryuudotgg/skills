import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type BlockerRef,
  blockerState,
  bookkeepingEvents,
  foreignRefusal,
  COLUMNS,
  flatten,
  formatRow,
  frontier,
  historiesOf,
  type History,
  historyKey,
  type IndexRow,
  inboxLines,
  isForeign,
  isStatus,
  lastEvent,
  next,
  parseBlockers,
  parseRef,
  parseTime,
  renderFrontier,
  stacksOn,
  trailVerbs,
} from "skills-core";
import { processIo, type Io } from "../io.ts";
import { readDelivery } from "../delivery.ts";
import { ghOutput } from "../gh.ts";
import { commandRunner, GhGitHubReader, WatcherQueryError } from "../pr/github.ts";
import { withLock } from "../lock.ts";
import { greenClock, lines, waitForGreen } from "../pr/green.ts";
import type { WatchClock } from "../pr/policy.ts";
import { reviewerDeclarations } from "../pr/watch.ts";
import { parsePrNumber, type GitHubReader, type ReviewerDeclarations } from "../pr/types.ts";
import { checkoutIs, detectProject, readCheckout } from "../project.ts";
import { chain } from "../stack/skills-base.ts";
import { isCtxSlug } from "./batch.ts";
import {
  cleanNote,
  indexPath,
  missingIndex,
  plansDir,
  projectDir,
  replaceDurably,
  scratchLock,
  today,
} from "./index-tsv.ts";
import { appendLog, recordWorkingCopies, updateIndex } from "./commit.ts";
import { Refusal as StoreRefusal } from "./import.ts";
import { logDetail } from "./trail.ts";
import { readPlans, readProject, readProjectAt, writableIndex } from "./projection.ts";
import { sha256 } from "./store.ts";
import { landedHeading, lint, lintedFiles } from "./lint.ts";
import { readNeeds } from "./needs.ts";
import { linkBlocker, resolveRefusal, resolveWith, settleIssues } from "./issues.ts";

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
  const rest: string[] = [];

  let mode: "default" | "next" | "stacks" = "default";
  let stack = "";
  let time: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    const value = args[index + 1];
    if (arg === "--next" && mode === "default") mode = "next";
    else if (arg === "--stacks-on" && mode === "default" && value !== undefined) {
      mode = "stacks";
      stack = value;
      index++;
    } else if (arg === "--at" && time === undefined && value !== undefined) {
      time = value;
      index++;
    } else if (arg.startsWith("-")) return usageError(usage);
    else rest.push(arg);
  }

  if (rest.length > 1) return usageError(usage);

  const until = time === undefined ? undefined : parseTime(time);
  if (time !== undefined && until === undefined) {
    err(`frontier: not a time: ${time}\n`);
    return 1;
  }

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

      const known = readdirSync(plans, { withFileTypes: true })
        .filter((entry) => !entry.name.startsWith(".") && entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .map((name) => `${name} `)
        .join("");

      return known ? stop(miss, `known projects: ${known}`) : stop(miss);
    }

    project = detected;
  }

  const read =
    until === undefined ? await readProject(project) : await readProjectAt(project, until);

  if (read.kind === "failed") return stop(read.reason);
  if (read.kind === "absent") return stop(`${missingIndex(project)} (run /plans new to bootstrap)`);
  if (read.kind === "before") {
    const since = new Date(read.since).toISOString();
    err(`frontier: ${time} is before the store holds ${project}, from ${since}\n`);
    return 1;
  }

  const { rows } = read;
  if (mode === "stacks") {
    for (const id of stacksOn(rows, stack, read)) out(`${id}\n`);
    return 0;
  }

  const ready = frontier(rows, read).ready.map(({ row }) => row);
  const needs = until === undefined ? await readNeeds(project, ready) : undefined;
  if (needs && "refusal" in needs) return stop(needs.refusal);

  if (mode === "next") {
    const id = next(rows, read, needs);
    if (id !== undefined) out(`${id}\n`);
  } else {
    const inbox = inboxLines([...read.issues.values()].filter((one) => one.project === project));
    out(renderFrontier(rows, read, needs));
    if (inbox.length > 0) out(`\n${inbox.join("\n")}\n`);
  }

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

  const read = await readProject(project, io.env);
  if (read.kind !== "rows") {
    io.err(`${read.kind === "failed" ? read.reason : missingIndex(project)}\n`);
    return 1;
  }

  if (!isStatus(status)) {
    io.err(`bad status: ${status}\n`);
    return 1;
  }

  if (status === "REVIEW" && readDelivery(root, io.env).mode === "prs") {
    const row = read.rows.find((entry) => entry.id === id);
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

  const updated = await setRow(indexPath(project, io.env), id, status, branch, note);
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
async function addRefusal(
  project: string,
  refs: readonly BlockerRef[],
): Promise<string | undefined> {
  if (!refs.some(isForeign)) return undefined;

  const read = await readPlans();
  if (read.kind === "failed") return read.reason;

  const { projects, unimported } = read.plans;
  for (const ref of refs) {
    if (ref.kind !== "plan" && ref.kind !== "issue") continue;
    if (ref.kind === "plan" && ref.project.toLowerCase() === project.toLowerCase())
      return `blocked_by ${ref.text}: names this project, write ${ref.id}`;

    if (unimported.has(ref.project))
      return `blocked_by ${ref.text}: ${ref.project} is not in the store yet, run skills plans import`;

    const state =
      ref.kind === "issue" && !projects.has(ref.project)
        ? ({ kind: "no-project" } as const)
        : blockerState(ref, [], read.plans);

    if (state.kind === "no-project") {
      const near = [...projects.keys()].find(
        (name) => name.toLowerCase() === ref.project.toLowerCase(),
      );

      return `blocked_by ${ref.text}: no project ${ref.project} in ${plansDir()}${near ? `, did you mean ${near}` : ""}`;
    }

    if (state.kind === "no-row" && ref.kind === "plan")
      return `blocked_by ${ref.text}: ${ref.project} has no row ${ref.id}`;

    if (state.kind === "no-issue") return `blocked_by ${ref.text}: no issue ${ref.text}`;
  }

  return undefined;
}

function resolvesFlag(
  args: readonly string[],
): { positional: string[]; resolves?: string } | undefined {
  const at = args.indexOf("--resolves");
  if (at === -1) return { positional: [...args] };

  const resolves = args[at + 1];
  const positional = [...args.slice(0, at), ...args.slice(at + 2)];
  if (resolves === undefined || positional.includes("--resolves")) return undefined;

  return { positional, resolves };
}

export async function addVerb(args: readonly string[], usage: string): Promise<number> {
  const parsed = resolvesFlag(args);
  if (!parsed) return usageError(usage);

  const { positional, resolves } = parsed;
  const [project, slug, pri, effort, blockedBy, ctx, note] = positional;
  if (!project || !slug || !pri || !effort || positional.length > 7) return usageError(usage);

  const refs = parseBlockers(dash(blockedBy));
  const problem = !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)
    ? `slug is not kebab case: ${slug}`
    : !PRIORITIES.includes(pri)
      ? `bad pri: ${pri}`
      : !EFFORTS.includes(effort)
        ? `bad effort: ${effort}`
        : refs.some((ref) => ref.kind === "bad")
          ? `bad blocked_by: ${blockedBy}`
          : dash(ctx) !== "-" && !isCtxSlug(dash(ctx))
            ? `bad ctx: ${ctx}`
            : resolves !== undefined && parseRef(resolves).kind !== "issue"
              ? `--resolves ${resolves}: not an issue ref, write <Project>#<n>`
              : undefined;

  if (problem) {
    err(`${problem}\n`);
    return 1;
  }

  const writable = await writableIndex(project);
  if ("refusal" in writable) {
    err(`${writable.refusal}\n`);
    return 1;
  }

  const foreign = await addRefusal(project, refs);
  if (foreign) {
    err(`${foreign}\n`);
    return 1;
  }

  const { index } = writable;
  const directory = dirname(index);
  const row = await updateIndex(index, (rows, _trail, _record, _world, tx) => {
    const linked = (entry: IndexRow): IndexRow => {
      const plan = `${project}/${entry.id}`;
      for (const ref of parseBlockers(entry.blocked_by))
        if (ref.kind === "issue") linkBlocker(tx, ref.text, plan);

      if (resolves === undefined) return entry;

      const refusal = resolveRefusal(tx.world(), resolves, plan, entry);
      if (refusal) throw new Error(`--resolves ${resolves}: ${refusal}`);

      resolveWith(tx, resolves, plan);
      return entry;
    };

    const files = [directory, `${directory}/done`].flatMap((path) => planFiles(path));
    const own = files.find((name) => name.slice(4) === `${slug}.md`)?.slice(0, 3);
    const taken = rows.find((entry) => entry.id === own);
    if (taken?.slug === slug) return linked(taken);

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

    const id = own ?? String(highest + 1).padStart(3, "0");
    const known = new Set([
      ...rows.map((entry) => entry.id),
      ...files.map((name) => name.slice(0, 3)),
    ]);

    for (const ref of refs) {
      if (ref.kind !== "local") continue;
      if (ref.id === id) throw new Error(`blocked_by ${ref.text}: a row cannot wait on itself`);
      if (!known.has(ref.id))
        throw new Error(`blocked_by ${ref.text}: no row or plan file ${ref.id} in ${project}`);
    }

    const added: IndexRow = {
      id,
      slug,
      status: "TODO",
      pri,
      effort,
      blocked_by: refs.length ? refs.map((ref) => ref.text).join(",") : "-",
      ctx: dash(ctx),
      branch: "-",
      updated: today(),
      note: dash(note) === "-" ? "-" : cleanNote(note ?? ""),
    };

    rows.push(added);
    return linked(added);
  });

  out(`${formatRow(row)}\n`);
  return 0;
}

export async function logVerb(args: readonly string[], usage: string): Promise<number> {
  const [project, id, event, detail = ""] = args;
  if (!project || !id || !event || args.length > 4) return usageError(usage);

  const allowed = trailVerbs(id);
  if (!allowed.includes(event)) {
    err(`log: ${event} is not one of ${allowed.join(", ")}\n`);
    return 1;
  }

  await appendLog(project, id, event, detail);
  return 0;
}

export async function markStarted(
  index: string,
  project: string,
  branch: string,
  expected: readonly IndexRow[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<IndexRow[] | { refusal: string } | undefined> {
  return withLock(scratchLock(env), "scratch", () => claim(index, project, branch, expected));
}

async function claim(
  index: string,
  project: string,
  branch: string,
  expected: readonly IndexRow[],
): Promise<IndexRow[] | { refusal: string } | undefined> {
  return updateIndex(index, (rows, trail, _record, world) => {
    const claimed: IndexRow[] = [];
    for (const wanted of expected) {
      const row = rows.find((entry) => entry.id === wanted.id);
      if (!row) return undefined;

      if (formatRow(row) !== formatRow(wanted)) {
        const changes = COLUMNS.filter((column) => flatten(row[column]) !== flatten(wanted[column]))
          .map((column) => `${column} ${wanted[column]} -> ${row[column]}`)
          .join(", ");

        return { refusal: expected.length > 1 ? `row ${row.id} ${changes}` : changes };
      }

      const foreign = foreignRefusal(row, rows, world());
      if (foreign) return { refusal: expected.length > 1 ? `row ${row.id} ${foreign}` : foreign };

      claimed.push(row);
    }

    for (const row of claimed) {
      row.status = "DOING";
      row.branch = branch;
      row.updated = today();

      const previous = trail.last(project, row.id, bookkeepingEvents);
      if (previous?.event !== "start" || previous.detail !== logDetail(branch))
        trail.log(project, row.id, "start", branch);
    }

    return claimed;
  });
}

type Refusal = { refusal: string; draftless?: string };
type Closed = IndexRow | "closed";

class CloseRefused extends Error {
  constructor(readonly reason: Refusal) {
    super(reason.refusal);
  }
}

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

function landedDraft(
  bytes: Uint8Array,
): { branch: string; start: number; end: number } | undefined {
  const text = Buffer.from(bytes).toString("utf8");
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
  guard?: (row: IndexRow, history: History | undefined) => string | undefined;
};

export type CloseResult =
  | { kind: "closed"; row: IndexRow; landed: string | undefined }
  | { kind: "already" }
  | { kind: "refused"; reason: string; draftless?: string };

function refused({ refusal, draftless }: Refusal): CloseResult {
  return { kind: "refused", reason: refusal, draftless };
}

async function storeRefusal<T>(write: Promise<T>): Promise<T | Refusal> {
  try {
    return await write;
  } catch (error) {
    if (error instanceof CloseRefused) return error.reason;
    if (error instanceof StoreRefusal) return { refusal: error.message };
    throw error;
  }
}

function closedAlready(
  row: IndexRow,
  file: PlanFile,
  last: { event: string } | undefined,
): boolean {
  return (
    (row.status === "DONE" || row.status === "DROPPED") &&
    file.atDestination &&
    last?.event === "done"
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
  const read = await readPlans(env);
  if (read.kind === "failed") return { kind: "refused", reason: read.reason };

  const { projects, trail } = read.plans;
  const listed = projects.get(project)?.find((entry) => entry.id === id);
  if (!listed) return { kind: "refused", reason: `id ${id} not in ${index}` };

  const directory = dirname(index);
  const name = `${listed.id}-${listed.slug}.md`;
  const copies = [join(directory, name), join(directory, "done", name)];
  await recordWorkingCopies(plansDir(env), copies);

  const checked = planFile(index, listed);
  if ("refusal" in checked) return refused(checked);

  if (closedAlready(listed, checked, lastEvent(trail, project, listed.id)))
    return { kind: "already" };

  const changed = guard(listed, historiesOf(trail).get(historyKey(project, listed.id)));
  if (changed) return { kind: "refused", reason: changed };

  const seen = sha256(readFileSync(checked.atSource ? checked.source : checked.destination));

  const draft =
    status === "DONE"
      ? landedDraft(readFileSync(checked.atSource ? checked.source : checked.destination))
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

  const result = await storeRefusal(
    updateIndex(
      index,
      (rows, trail, record, _world, tx): Closed => {
        const row = rows.find((entry) => entry.id === id);
        if (!row) throw new CloseRefused({ refusal: `id ${id} not in ${index}` });

        const file = planFile(index, row);
        if ("refusal" in file) throw new CloseRefused(file);
        if (closedAlready(row, file, trail.last(project, id))) return "closed";

        const changed = guard(row, trail.history(project, row.id));
        if (changed) throw new CloseRefused({ refusal: changed });

        const { source, destination, atSource } = file;
        const path = atSource ? source : destination;
        const bytes = readFileSync(path);
        if (sha256(bytes) !== seen || record(path))
          throw new CloseRefused({ refusal: `${path} changed during close, retry` });

        const currentDraft = status === "DONE" ? landedDraft(bytes) : undefined;
        if (currentDraft && (!landed || currentDraft.branch !== draft?.branch))
          throw new CloseRefused({ refusal: "Landed draft changed during close, retry" });

        row.status = status;
        row.note = cleanNote(note);
        row.updated = today();
        settleIssues(tx, project, id, status);

        if (currentDraft && landed)
          replaceDurably(
            path,
            Buffer.concat([
              bytes.subarray(0, currentDraft.start),
              Buffer.from(landed, "utf8"),
              bytes.subarray(currentDraft.end),
            ]),
          );

        if (atSource) {
          mkdirSync(dirname(destination), { recursive: true });
          renameSync(source, destination);
        }

        record(destination);

        if (trail.last(project, id)?.event !== "done")
          trail.log(project, id, "done", cleanNote(note));

        return row;
      },
      true,
    ),
  );

  if (result === "closed") return { kind: "already" };
  if ("refusal" in result) {
    await recordWorkingCopies(plansDir(env), copies);
    return refused(result);
  }

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

  let writable: Awaited<ReturnType<typeof writableIndex>>;
  try {
    writable = await writableIndex(project);
  } catch (error) {
    return refuse(error instanceof Error ? error.message : String(error));
  }

  if ("refusal" in writable) return refuse(writable.refusal);

  const { index } = writable;

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
  if (args.includes("--overlap")) {
    const [project] = args.filter((arg) => arg !== "--overlap");
    if (args.length !== 2 || !project || project.startsWith("-")) return usageError(usage);

    const { overlapVerb } = await import("./overlap.ts");
    return overlapVerb(project, processIo());
  }

  const [project, id] = args;
  if (!project || args.length > 2) return usageError(usage);

  const directory = projectDir(project);
  const read = await readProject(project);
  if (read.kind === "failed") {
    err(`${read.reason}\n`);
    return 1;
  }

  const texts = await recordWorkingCopies(
    plansDir(),
    lintedFiles(directory, id || undefined).map((name) => `${directory}/${name}`),
  );

  const result = lint(
    directory,
    project,
    id || undefined,
    read.kind === "rows" ? read : undefined,
    (path) => {
      const bytes = texts.get(path);
      return bytes === undefined ? readFileSync(path, "utf8") : Buffer.from(bytes).toString("utf8");
    },
  );

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

  const read = await readProject(project, io.env);
  if (read.kind === "failed") return refuse(read.reason);
  if (read.kind === "absent") return refuse(missingIndex(project));

  const elsewhere = await checkoutIs(io.cwd, project, io);
  if (elsewhere) return refuse(elsewhere);

  const { rows } = read;
  const row = rows.find((entry) => entry.id === id);
  if (!row) return refuse(`id ${id} not found`);
  if (row.status !== "DOING") return refuse(`row ${id} is ${row.status}, not DOING`);
  if (row.branch === "" || row.branch === "-") return refuse(`row ${id} has no branch`);

  const layer = new Set(
    rows
      .filter((entry) => entry.status === "DOING" && entry.branch === row.branch)
      .map((entry) => entry.id),
  );

  const asReview = rows.map((entry) =>
    layer.has(entry.id) ? { ...entry, status: "REVIEW" } : entry,
  );

  const result = await chain(io.cwd, row.branch, io);
  if (!result.ok) return refuse(result.reason);

  io.out(`babysit ${result.stack.join(" ")}\n`);

  for (const { row: ready, stacksOn: below } of frontier(asReview, read).ready)
    if (below !== undefined && layer.has(below)) io.out(`next ${ready.id}\n`);

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
