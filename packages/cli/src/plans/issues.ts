import { readFileSync } from "node:fs";
import {
  blockerState,
  conflictLine,
  type Filing,
  flatten,
  inConflict,
  inInbox,
  type IndexRow,
  ISSUE_CLOSED,
  ISSUE_FILED,
  ISSUE_LINK,
  issuePlan,
  issueRef,
  parseBlockers,
  parseRef,
  resolvers,
  rowKey,
  type Issue,
  type IssueClosed,
  type IssueFiled,
  type IssueLinked,
  type World,
} from "skills-core";
import type { Io } from "../io.ts";
import { commitPlans, type Tx } from "./commit.ts";
import { Refusal } from "./import.ts";
import { cleanNote, decodeUtf8, plansDir, today } from "./index-tsv.ts";
import { readPlans, readStore, type Plans } from "./projection.ts";
import { appendEvent, highestIssue, storedIssues, type Store } from "./store.ts";

type FileArgs = { target: string; title: string; body?: string; from?: string; blocks?: string };

const FLAGS = ["--body", "--from", "--blocks"];
const CLOSED = new Set(["DONE", "DROPPED"]);

export type IssueAddress = { project: string; n: number; text: string };

function usageError(io: Io, usage: string): number {
  io.err(`usage: ${usage}\n`);
  return 2;
}

async function guarded(io: Io, verb: string, run: () => Promise<number>): Promise<number> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`issues ${verb}: ${error.message}\n`);
    return 1;
  }
}

function fileArgs(args: readonly string[]): FileArgs | undefined {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (!FLAGS.includes(arg)) {
      positional.push(arg);
      continue;
    }

    const value = args[++index];
    if (value === undefined || flags.has(arg)) return undefined;

    flags.set(arg, value);
  }

  const [target, title] = positional;
  if (positional.length !== 2 || !target || title === undefined) return undefined;

  return {
    target,
    title,
    body: flags.get("--body"),
    from: flags.get("--from"),
    blocks: flags.get("--blocks"),
  };
}

function issueAddress(text: string | undefined): IssueAddress | undefined {
  if (text === undefined) return undefined;
  const ref = parseRef(text);
  return ref.kind === "issue" ? { project: ref.project, n: Number(ref.n), text } : undefined;
}

async function plansRead(io: Io): Promise<Plans> {
  const read = await readPlans(io.env);
  if (read.kind === "failed") throw new Refusal(read.reason);
  return read.plans;
}

function projectRefusal(plans: Plans, name: string, root: string): string | undefined {
  const unimported = plans.unimported.get(name);
  if (unimported) return `${unimported} is not in the store yet, run skills plans import`;
  if (plans.projects.has(name)) return undefined;

  const near = [...plans.projects.keys()].find(
    (project) => project.toLowerCase() === name.toLowerCase(),
  );

  return `no project ${name} in ${root}${near ? `, did you mean ${near}` : ""}`;
}

function planRefusal(plans: Plans, flag: string, text: string, root: string): string | undefined {
  const ref = parseRef(text);
  if (ref.kind !== "plan") return `${flag} ${text}: not a plan ref, write <Project>/<id>`;

  const project = projectRefusal(plans, ref.project, root);
  if (project) return `${flag} ${text}: ${project}`;

  const row = plans.projects.get(ref.project)?.find((entry) => entry.id === ref.id);
  if (!row) return `${flag} ${text}: ${ref.project} has no row ${ref.id}`;

  return undefined;
}

function rowOf(world: World, text: string): IndexRow | undefined {
  const ref = parseRef(text);
  if (ref.kind !== "plan") return undefined;
  return world.projects.get(ref.project)?.find((row) => row.id === ref.id);
}

function editable(tx: Tx, project: string, row: IndexRow): IndexRow {
  const edited = tx.rows(project).find((entry) => rowKey(entry) === rowKey(row));
  if (!edited) throw new Refusal(`${project}/${row.id} is not in the store`);
  return edited;
}

function readBody(path: string): string {
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? String(error);
    throw new Refusal(`cannot read --body ${path}: ${code}`);
  }

  try {
    return decodeUtf8(bytes);
  } catch {
    throw new Refusal(`--body ${path} is not UTF-8 text`);
  }
}

function listLine(issue: Issue): string {
  return [issueRef(issue), issue.state.kind, issue.title, issue.from ?? "-"].join("\t");
}

async function readIssues(io: Io, project?: string): Promise<Issue[]> {
  const read = await readStore(plansDir(io.env), (store) => storedIssues(store, project));
  if (read.kind === "failed") throw new Refusal(read.reason);
  return read.kind === "read" ? read.value : [];
}

function inTx<T>(root: string, edit: (tx: Tx) => T): Promise<T> {
  return commitPlans(root, {}, (_trail, _rows, _record, _world, tx) => edit(tx));
}

export function linkIssue(
  tx: Tx,
  issue: { project: string; n: number },
  ref: string,
  kind: IssueLinked["kind"],
): void {
  appendEvent(tx.store, {
    kind: "stored",
    type: ISSUE_LINK,
    at: tx.at,
    project: issue.project,
    plan: issuePlan(issue.n),
    payload: { ref, kind },
  });
}

export function releaseIssue(tx: Tx, ref: string): void {
  const world = tx.world();
  for (const [project, rows] of world.projects)
    for (const row of rows) {
      if (row.status !== "BLOCKED") continue;

      const refs = parseBlockers(row.blocked_by);
      if (!refs.some((one) => one.text === ref)) continue;
      if (refs.some((one) => blockerState(one, rows, world).kind !== "released")) continue;

      const edited = editable(tx, project, row);
      edited.status = "TODO";
      edited.note = cleanNote(`unblocked by ${ref}`);
      edited.updated = today();
    }
}

function shut(tx: Tx, issue: Issue, closing: IssueClosed): void {
  appendEvent(tx.store, {
    kind: "stored",
    type: ISSUE_CLOSED,
    at: tx.at,
    project: issue.project,
    plan: issuePlan(issue.n),
    payload: closing,
  });

  releaseIssue(tx, issueRef(issue));
}

function resolveIfDone(tx: Tx, ref: string): void {
  const world = tx.world();
  const issue = world.issues.get(ref);
  if (!issue || issue.state.kind === "closed") return;

  const plans = resolvers(issue);
  if (plans.length === 0 || !plans.every((plan) => rowOf(world, plan)?.status === "DONE")) return;

  shut(tx, issue, { reason: `resolved by ${plans.join(", ")}`, resolvedBy: plans });
}

export function settleIssues(tx: Tx, project: string, id: string, status: string): void {
  if (!CLOSED.has(status)) return;

  const ref = `${project}/${id}`;
  for (const issue of storedIssues(tx.store, project)) {
    if (!resolvers(issue).includes(ref)) continue;
    if (status === "DROPPED") linkIssue(tx, issue, ref, "unlinked");
    resolveIfDone(tx, issueRef(issue));
  }
}

function waitsOn(world: World, project: string, row: IndexRow, issueText: string): boolean {
  const seen = new Set<string>();
  const queue = [{ project, row }];
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const rows = world.projects.get(next.project) ?? [];
    for (const ref of parseBlockers(next.row.blocked_by)) {
      if (ref.text === issueText) return true;
      if (ref.kind !== "local" && ref.kind !== "plan") continue;

      const owner = ref.kind === "plan" ? ref.project : next.project;
      const key = `${owner}/${ref.id}`;
      const blocker = (ref.kind === "plan" ? (world.projects.get(owner) ?? []) : rows).find(
        (entry) => entry.id === ref.id,
      );

      if (!blocker || CLOSED.has(blocker.status) || seen.has(key)) continue;

      seen.add(key);
      queue.push({ project: owner, row: blocker });
    }
  }

  return false;
}

export function conflictRefusal(issue: Issue): string | undefined {
  if (!inConflict(issue)) return undefined;
  const ref = issueRef(issue);
  return `${ref} is filed more than once, run skills issues renumber ${ref} first`;
}

export function resolveRefusal(
  world: World,
  issueText: string,
  planText: string,
  row: IndexRow | undefined,
): string | undefined {
  const issue = world.issues.get(issueText);
  if (!issue) return `no issue ${issueText}`;

  const conflict = conflictRefusal(issue);
  if (conflict) return conflict;
  if (issue.state.kind === "closed") return `${issueText} is closed`;

  const plan = parseRef(planText);
  if (plan.kind !== "plan" || plan.project !== issue.project)
    return `${issueText} is in ${issue.project}, link a row of ${issue.project}`;

  if (!row) return `${issue.project} has no row ${plan.id}`;
  if (row.status === "DROPPED") return `${planText} is DROPPED`;
  if (waitsOn(world, issue.project, row, issueText))
    return `${planText} waits on ${issueText}, so it cannot resolve it`;

  return undefined;
}

export function resolveWith(tx: Tx, issueText: string, planText: string): void {
  const world = tx.world();
  const issue = world.issues.get(issueText);
  if (!issue) return;

  if (!issue.links.some((link) => link.kind === "resolves" && link.ref === planText))
    linkIssue(tx, issue, planText, "resolves");

  resolveIfDone(tx, issueText);
}

export function linkBlocker(tx: Tx, issueText: string, planText: string): void {
  const issue = tx.world().issues.get(issueText);
  const conflict = issue && conflictRefusal(issue);
  if (conflict) throw new Refusal(`blocked_by ${issueText}: ${conflict}`);
  if (!issue || issue.links.some((link) => link.kind === "blocks" && link.ref === planText)) return;

  linkIssue(tx, issue, planText, "blocks");
}

function blockOn(tx: Tx, issue: { project: string; n: number }, planText: string): void {
  const row = rowOf(tx.world(), planText);
  if (!row) throw new Refusal(`--blocks ${planText}: no such row`);
  if (CLOSED.has(row.status)) throw new Refusal(`--blocks ${planText}: the row is ${row.status}`);

  const ref = issueRef(issue);
  const target = parseRef(planText);
  const edited = editable(tx, target.kind === "plan" ? target.project : "", row);

  edited.blocked_by = edited.blocked_by === "-" ? ref : `${edited.blocked_by},${ref}`;
  edited.updated = today();
  linkIssue(tx, issue, planText, "blocks");
}

export function fileIssue(
  store: Store,
  project: string,
  filing: Omit<IssueFiled, "n"> & { moved?: string },
  at: number,
): number {
  const n = highestIssue(store, project) + 1;

  appendEvent(store, {
    kind: "stored",
    type: ISSUE_FILED,
    at,
    project,
    plan: issuePlan(n),
    payload: { ...filing, n },
  });

  return n;
}

export async function fileVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const filing = fileArgs(args);
  if (!filing) return usageError(io, usage);

  return guarded(io, "file", async () => {
    const root = plansDir(io.env);
    const title = flatten(filing.title);
    if (title.trim() === "") throw new Refusal("the title is empty");

    const plans = await plansRead(io);
    const refusal =
      (parseRef(`${filing.target}#1`).kind === "issue"
        ? undefined
        : `${filing.target} cannot head an issue ref, its name holds a space, comma, slash or #`) ??
      projectRefusal(plans, filing.target, root) ??
      (filing.from === undefined ? undefined : planRefusal(plans, "--from", filing.from, root)) ??
      (filing.blocks === undefined
        ? undefined
        : planRefusal(plans, "--blocks", filing.blocks, root));

    if (refusal) throw new Refusal(refusal);

    const blocked = filing.blocks === undefined ? undefined : rowOf(plans, filing.blocks);
    if (blocked && CLOSED.has(blocked.status))
      throw new Refusal(`--blocks ${filing.blocks}: the row is ${blocked.status}`);

    const body = filing.body === undefined ? null : readBody(filing.body);
    const filed = { title, body, from: filing.from ?? null };
    const n = await inTx(root, (tx) => {
      const filedN = fileIssue(tx.store, filing.target, filed, tx.at);
      if (filing.blocks !== undefined)
        blockOn(tx, { project: filing.target, n: filedN }, filing.blocks);

      return filedN;
    });

    io.out(`${issueRef({ project: filing.target, n })}\n`);
    return 0;
  });
}

export async function listVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const all = args.includes("--all");
  const rest = args.filter((arg) => arg !== "--all");
  if (rest.length > 1 || args.length - rest.length > 1 || rest[0]?.startsWith("--"))
    return usageError(io, usage);

  return guarded(io, "list", async () => {
    const [project] = rest;
    if (project !== undefined) {
      const refusal = projectRefusal(await plansRead(io), project, plansDir(io.env));
      if (refusal) throw new Refusal(refusal);
    }

    const shown = (await readIssues(io, project)).filter((issue) => all || inInbox(issue));

    io.out(shown.map((issue) => `${listLine(issue)}\n`).join(""));
    return 0;
  });
}

function showLines(issue: Pick<Issue, keyof Filing | "state" | "links">): string {
  const state = issue.state.kind === "open" ? "open" : `closed: ${issue.state.reason}`;

  const head = [
    issue.title,
    `from ${issue.from ?? "-"}`,
    `filed ${issue.filed}`,
    state,
    ...issue.links.map((link) => `${link.kind} ${link.ref}`),
  ];

  const body = !issue.body || issue.body.endsWith("\n") ? (issue.body ?? "") : `${issue.body}\n`;
  return `${head.join("\n")}\n\n${body}`;
}

function shown(issue: Issue): string {
  const conflict = conflictLine(issue);
  if (conflict === undefined) return showLines(issue);

  const rivals = issue.rivals.map((rival) =>
    showLines({ ...rival, state: { kind: "open" }, links: [] }),
  );

  const blocks = [showLines(issue), ...rivals].map((block) => `${block.trimEnd()}\n`);
  return [`${conflict}\n`, ...blocks].join("\n");
}

export async function showVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const address = issueAddress(args[0]);
  if (args.length !== 1 || !address) return usageError(io, usage);

  return guarded(io, "show", async () => {
    const issue = (await readIssues(io, address.project)).find((one) => one.n === address.n);
    if (!issue) throw new Refusal(`no issue ${address.text}`);

    io.out(shown(issue));
    return 0;
  });
}

export function closeIssue(tx: Tx, address: IssueAddress, closing: IssueClosed): Issue {
  const issue = tx.world().issues.get(address.text);
  if (!issue) throw new Refusal(`no issue ${address.text}`);

  const conflict = conflictRefusal(issue);
  if (conflict) throw new Refusal(conflict);
  if (issue.state.kind === "closed") throw new Refusal(`${address.text} is already closed`);

  shut(tx, issue, closing);
  return tx.world().issues.get(address.text) ?? issue;
}

export async function closeVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const address = issueAddress(args[0]);
  const reason = flatten(args[1] ?? "");
  if (args.length !== 2 || !address || reason.trim() === "") return usageError(io, usage);

  return guarded(io, "close", async () => {
    const closing = { reason, resolvedBy: [] };
    const issue = await inTx(plansDir(io.env), (tx) => closeIssue(tx, address, closing));

    io.out(`${listLine(issue)}\n`);
    return 0;
  });
}

export async function linkVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const address = issueAddress(args[0]);
  const id = args[1] ?? "";
  if (args.length !== 2 || !address || !/^[0-9]{3}$/.test(id)) return usageError(io, usage);

  return guarded(io, "link", async () => {
    const plan = `${address.project}/${id}`;
    const issue = await inTx(plansDir(io.env), (tx) => {
      const world = tx.world();
      const refusal = resolveRefusal(world, address.text, plan, rowOf(world, plan));
      if (refusal) throw new Refusal(refusal);

      resolveWith(tx, address.text, plan);
      return tx.world().issues.get(address.text);
    });

    if (issue) io.out(`${listLine(issue)}\n`);
    return 0;
  });
}

function renumber(tx: Tx, address: IssueAddress): number {
  const issue = tx.world().issues.get(address.text);
  if (!issue) throw new Refusal(`no issue ${address.text}`);

  const latest = issue.rivals.at(-1);
  if (!latest) throw new Refusal(`${address.text} has no conflict`);

  const { title, body, from, id } = latest;
  return fileIssue(tx.store, address.project, { title, body, from, moved: id }, tx.at);
}

export async function renumberVerb(
  args: readonly string[],
  usage: string,
  io: Io,
): Promise<number> {
  const address = issueAddress(args[0]);
  if (args.length !== 1 || !address) return usageError(io, usage);

  return guarded(io, "renumber", async () => {
    const n = await inTx(plansDir(io.env), (tx) => renumber(tx, address));
    io.out(`${issueRef({ project: address.project, n })}\n`);
    return 0;
  });
}
