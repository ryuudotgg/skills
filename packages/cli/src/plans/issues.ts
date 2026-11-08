import { readFileSync } from "node:fs";
import {
  flatten,
  ISSUE_CLOSED,
  ISSUE_FILED,
  issuePlan,
  issueRef,
  parseRef,
  secondStamp,
  type Issue,
  type IssueClosed,
  type IssueFiled,
} from "skills-core";
import type { Io } from "../io.ts";
import { openPlansStore } from "./commit.ts";
import { Refusal } from "./import.ts";
import { decodeUtf8, plansDir } from "./index-tsv.ts";
import { readPlans, readStore, type Plans } from "./projection.ts";
import { appendEvent, highestIssue, storedIssues, write, type Store } from "./store.ts";

type Filing = { target: string; title: string; body?: string; from?: string };

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

function fileArgs(args: readonly string[]): Filing | undefined {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg !== "--body" && arg !== "--from") {
      positional.push(arg);
      continue;
    }

    const value = args[++index];
    if (value === undefined || flags.has(arg)) return undefined;

    flags.set(arg, value);
  }

  const [target, title] = positional;
  if (positional.length !== 2 || !target || title === undefined) return undefined;

  return { target, title, body: flags.get("--body"), from: flags.get("--from") };
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

function fromRefusal(plans: Plans, from: string, root: string): string | undefined {
  const ref = parseRef(from);
  if (ref.kind !== "plan") return `--from ${from}: not a plan ref, write <Project>/<id>`;

  const project = projectRefusal(plans, ref.project, root);
  if (project) return `--from ${from}: ${project}`;

  const rows = plans.projects.get(ref.project) ?? [];
  if (!rows.some((row) => row.id === ref.id))
    return `--from ${from}: ${ref.project} has no row ${ref.id}`;

  return undefined;
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

async function inStore<T>(root: string, edit: (store: Store) => T): Promise<T> {
  const store = await openPlansStore(root);
  try {
    return write(store, () => edit(store));
  } finally {
    store.db.close();
  }
}

export function fileIssue(
  store: Store,
  project: string,
  filing: Omit<IssueFiled, "n">,
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
      (filing.from === undefined ? undefined : fromRefusal(plans, filing.from, root));

    if (refusal) throw new Refusal(refusal);

    const body = filing.body === undefined ? null : readBody(filing.body);
    const filed = { title, body, from: filing.from ?? null };
    const n = await inStore(root, (store) => fileIssue(store, filing.target, filed, Date.now()));

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

    const shown = (await readIssues(io, project)).filter(
      (issue) => all || issue.state.kind === "open",
    );

    io.out(shown.map((issue) => `${listLine(issue)}\n`).join(""));
    return 0;
  });
}

function showLines(issue: Issue): string {
  const state = issue.state.kind === "open" ? "open" : `closed: ${issue.state.reason}`;

  const head = [issue.title, `from ${issue.from ?? "-"}`, `filed ${issue.filed}`, state];
  const body = !issue.body || issue.body.endsWith("\n") ? (issue.body ?? "") : `${issue.body}\n`;
  return `${head.join("\n")}\n\n${body}`;
}

export async function showVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const address = issueAddress(args[0]);
  if (args.length !== 1 || !address) return usageError(io, usage);

  return guarded(io, "show", async () => {
    const issue = (await readIssues(io, address.project)).find((one) => one.n === address.n);
    if (!issue) throw new Refusal(`no issue ${address.text}`);

    io.out(showLines(issue));
    return 0;
  });
}

export function closeIssue(
  store: Store,
  address: IssueAddress,
  closing: IssueClosed,
  at: number,
): Issue {
  const issue = storedIssues(store, address.project).find((one) => one.n === address.n);
  if (!issue) throw new Refusal(`no issue ${address.text}`);
  if (issue.state.kind === "closed") throw new Refusal(`${address.text} is already closed`);

  appendEvent(store, {
    kind: "stored",
    type: ISSUE_CLOSED,
    at,
    project: address.project,
    plan: issuePlan(address.n),
    payload: closing,
  });

  return { ...issue, state: { kind: "closed", reason: closing.reason, at: secondStamp(at) } };
}

export async function closeVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const address = issueAddress(args[0]);
  const reason = flatten(args[1] ?? "");
  if (args.length !== 2 || !address || reason.trim() === "") return usageError(io, usage);

  return guarded(io, "close", async () => {
    const closing = { reason, resolvedBy: [] };
    const issue = await inStore(plansDir(io.env), (store) =>
      closeIssue(store, address, closing, Date.now()),
    );

    io.out(`${listLine(issue)}\n`);
    return 0;
  });
}
