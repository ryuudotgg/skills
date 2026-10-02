import { statSync } from "node:fs";
import { join } from "node:path";
import { readDelivery } from "../delivery.ts";
import { ghOutput } from "../gh.ts";
import type { Io } from "../io.ts";
import { readDeclarations, type Declaration } from "../reviewers/declaration.ts";
import { checkoutIs, gitOutput } from "../project.ts";
import { git } from "../publish/commit.ts";
import { chain, recordBase, recordedBase } from "../stack/skills-base.ts";
import { formatRow, indexPath, readIndex } from "./index-tsv.ts";
import { markStarted } from "./verbs.ts";

type Blocker =
  | { kind: "unmerged"; id: string; branch: string }
  | { kind: "merged"; id: string; branch: string; oid: string };

const network = { timeout: 60_000, stderr: "inherit", killSignal: "SIGTERM" } as const;

type BlockerPr = { state: string; oid: string };
type ThreadPage = { urls: string[]; cursor: string | undefined };

export const QUERY = "query($owner: String!, $repo: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $repo) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(first: 1) { nodes { url author { login } } } } } } } }";

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function projectIndex(project: string, io: Io): string | undefined {
  try {
    const index = indexPath(project, io.env);
    return isFile(index) ? index : undefined;
  } catch {
    return undefined;
  }
}

function usageError(usage: string, io: Io): number {
  io.err(`usage: ${usage}\n`);
  return 2;
}

async function hasBranch(cwd: string, branch: string, io: Io): Promise<boolean> {
  return await gitOutput(cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], {}, io) !== undefined;
}

async function contains(cwd: string, ancestor: string, branch: string, io: Io): Promise<boolean> {
  return await gitOutput(cwd, ["merge-base", "--is-ancestor", ancestor, branch], {}, io) !== undefined;
}

export async function stackBaseVerb(args: readonly string[], usage: string, root: string, io: Io): Promise<number> {
  const cut = args[0] === "--cut";
  const rest = cut ? args.slice(1) : args;
  if (rest.length !== 2) return usageError(usage, io);

  const [project = "", id = ""] = rest;
  const result = await pickBase(project, id, root, cut, io);
  if (typeof result === "number") return result;

  io.out(`${result.base}\n`);
  return 0;
}

export async function pickBase(project: string, id: string, root: string, cut: boolean, io: Io, adopt = false): Promise<{ base: string; slug: string } | number> {
  const cwd = io.cwd;
  const refuse = (reason: string): number => {
    io.err(`stack-base: ${reason}\n`);
    return 1;
  };

  const index = projectIndex(project, io);
  if (!index) return refuse(`no index.tsv for ${project}`);

  const elsewhere = await checkoutIs(cwd, project, io);
  if (elsewhere) return refuse(elsewhere);

  const rows = readIndex(index);
  const row = rows.find((entry) => entry.id === id);
  if (!row?.slug) return refuse(`id ${id} not in ${index}`);
  if (["DONE", "DROPPED", "REVIEW"].includes(row.status))
    return refuse(`row ${id} is ${row.status}, nothing to start`);

  const status = await gitOutput(cwd, ["--no-optional-locks", "status", "--porcelain"], { timeout: 10_000, killSignal: "SIGTERM" }, io);
  if (status === undefined || status.trimEnd()) return refuse("working tree is dirty, commit or clear it first");
  if (!adopt && await hasBranch(cwd, `feat/${row.slug}`, io))
    return refuse(`feat/${row.slug} already exists, check it out instead of cutting it again`);

  const mode = readDelivery(root, io.env).mode;
  const live = (reason: string): number | undefined => {
    if (mode === "prs") return refuse(reason);
    io.err(`stack-base: warning, ${reason}\n`);
    return undefined;
  };

  const current = (await gitOutput(cwd, ["branch", "--show-current"], {}, io))?.trimEnd();
  const holder = current && rows.find((entry) => entry.status === "DOING" && entry.id !== id && entry.branch === current);
  if (holder) {
    const refusal = live(`row ${holder.id} is DOING on ${current}, this checkout is its thread`);
    if (refusal !== undefined) return refusal;
  }

  const blockers: Blocker[] = [];
  for (const blockerId of row.blocked_by.split(/[,\s]+/).filter((value) => value && value !== "-")) {
    const blocker = rows.find((entry) => entry.id === blockerId);
    if (!blocker?.status) return refuse(`blocker ${blockerId} not in ${index}`);
    if (blocker.status === "DONE" || blocker.status === "DROPPED") continue;

    if (blocker.status === "DOING") {
      const refusal = live(`blocker ${blockerId} is DOING, wait until it is in REVIEW`);
      if (refusal !== undefined) return refusal;
    }

    const branch = blocker.branch;
    if (!branch || branch === "-") return refuse(`blocker ${blockerId} has no branch, so no PR`);
    if (!Bun.which("gh", { PATH: io.env.PATH })) return refuse(`gh not found, cannot check blocker ${blockerId}`);

    const output = await ghOutput([
      "pr", "list", "--head", branch, "--state", "all", "--json", "state,mergeCommit",
      "--jq", '.[] | [.state, .mergeCommit.oid // "-"] | join(" ")',
    ], io);

    if (output === undefined) return refuse(`gh pr list failed for ${branch}`);

    const prs: BlockerPr[] = output.trim().split("\n").map((line) => {
      const [state = "", oid = ""] = line.trim().split(/\s+/);
      return { state, oid };
    });

    if (prs.some((pr) => pr.state === "OPEN")) {
      if (!await hasBranch(cwd, branch, io)) return refuse(`blocker ${blockerId} branch ${branch} is not in this checkout`);
      blockers.push({ kind: "unmerged", id: blockerId, branch });
    } else {
      const merged = prs.find((pr) => pr.state === "MERGED");
      if (merged) blockers.push({ kind: "merged", id: blockerId, branch, oid: merged.oid });
      else if (prs.some((pr) => pr.state === "CLOSED"))
        return refuse(`blocker ${blockerId} PR on ${branch} was closed without merging`);
      else return refuse(`blocker ${blockerId} has no PR for ${branch}`);
    }
  }

  const unmerged = blockers.filter((blocker) => blocker.kind === "unmerged");
  const merges = blockers.filter((blocker) => blocker.kind === "merged");

  let base = "";
  if (unmerged.length === 0) {
    const remote = await gitOutput(cwd, ["ls-remote", "--symref", "origin", "HEAD"], { ...network, stderr: "ignore" }, io);
    const defaultBranch = remote?.split("\n").find((line) => line.split(/\s+/)[0] === "ref:")
      ?.split(/\s+/)[1]?.replace("refs/heads/", "");

    if (!defaultBranch) return refuse("cannot read the default branch of origin");
    if (await gitOutput(cwd, ["fetch", "--quiet", "origin", `+refs/heads/${defaultBranch}:refs/remotes/origin/${defaultBranch}`], network, io) === undefined)
      return refuse(`fetch of origin ${defaultBranch} failed`);

    base = `origin/${defaultBranch}`;

    for (const merge of merges)
      if (!await contains(cwd, merge.oid, base, io)) return refuse(`blocker ${merge.id} merged, but not yet into ${base}`);
  } else {
    for (const candidate of unmerged) {
      let top = candidate.branch;
      for (const other of unmerged)
        if (!await contains(cwd, other.branch, top, io)) {
          top = "";
          break;
        }

      if (top) {
        base = top;
        break;
      }
    }

    if (!base) return refuse(`blockers ${unmerged.map((blocker) => blocker.id).join(" ")} are on two chains, no branch contains the others`);

    for (const merge of merges)
      if (!await contains(cwd, merge.oid, base, io) && !(await hasBranch(cwd, merge.branch, io) && await contains(cwd, merge.branch, base, io)))
        return refuse(`blocker ${merge.id} merged but ${base} does not contain it, rebase ${base} onto what it merged into`);
  }

  if (cut) {
    const code = await cutBase(base, row.slug, io);
    if (code !== 0) return code;
  }

  return { base, slug: row.slug };
}

export async function cutBase(base: string, slug: string, io: Io): Promise<number> {
  const cwd = io.cwd;
  const refuse = (reason: string): number => {
    io.err(`stack-base: ${reason}\n`);
    return 1;
  };

  const result = await git(cwd, ["checkout", "--quiet", "--no-track", "-b", `feat/${slug}`, base], { capture: true, write: true }, io);
  if (result.code !== 0) return refuse(`cannot cut feat/${slug} from ${base}`);
  if (!await recordBase(cwd, `feat/${slug}`, base, io)) return refuse(`cannot record the base of feat/${slug}`);

  return 0;
}

function reviewerDeclarations(root: string, io: Io): Declaration[] | undefined {
  try {
    return readDeclarations(root);
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n`);
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function threadPage(output: string, logins: ReadonlySet<string>): ThreadPage | undefined {
  let response: Record<string, unknown> | undefined;
  try {
    response = object(JSON.parse(output));
  } catch {
    return undefined;
  }

  if (!response || "errors" in response) return undefined;

  const repository = object(object(response.data)?.repository);
  const threads = object(object(repository?.pullRequest)?.reviewThreads);
  if (!Array.isArray(threads?.nodes)) return undefined;

  const pageInfo = object(threads.pageInfo);

  let cursor: string | undefined;
  if (pageInfo?.hasNextPage === true) {
    if (typeof pageInfo.endCursor !== "string" || !pageInfo.endCursor) return undefined;
    cursor = pageInfo.endCursor;
  }

  const urls: string[] = [];
  for (const node of threads.nodes) {
    const thread = object(node);
    if (!thread || thread.isResolved === true) continue;

    const comments = object(thread.comments)?.nodes;
    const comment = Array.isArray(comments) ? object(comments[0]) : undefined;
    const login = object(comment?.author)?.login;
    if (logins.has(typeof login === "string" ? login.toLowerCase() : ""))
      urls.push(typeof comment?.url === "string" ? comment.url : "null");
  }

  return { urls, cursor };
}

export async function belowVerb(args: readonly string[], usage: string, root: string, io: Io): Promise<number> {
  if (args.length !== 2) return usageError(usage, io);
  const [project = "", base = ""] = args;
  return checkBelow(project, base, root, io);
}

export async function checkBelow(
  project: string,
  base: string,
  root: string,
  io: Io,
  readGh: typeof ghOutput = ghOutput,
): Promise<number> {
  const cwd = io.cwd;
  const refuse = (reason: string): number => {
    io.err(`below: ${reason}\n`);
    return 1;
  };

  const index = projectIndex(project, io);
  if (!index) return refuse(`no index.tsv for ${project}`);

  const elsewhere = await checkoutIs(cwd, project, io);
  if (elsewhere) return refuse(elsewhere);
  if (base.startsWith("origin/")) return 0;

  const installed = reviewerDeclarations(root, io);
  if (installed === undefined) return refuse("cannot read reviewer declarations");

  const names = installed.map((entry) => entry.displayName).join(" or ");
  const logins = new Set(installed.flatMap((entry) => entry.logins.map((login) => login.toLowerCase())));

  const result = await chain(cwd, base, io);
  if (!result.ok) return refuse(`cannot read the base chain of ${base}: ${result.reason}`);

  const rows = readIndex(index);
  const output: string[] = [];
  for (const branch of result.stack) {
    const id = rows.find((row) => row.branch === branch)?.id;
    if (!id) return refuse(`${branch} is not an owned branch`);

    const prs = await readGh([
      "pr", "list", "--head", branch, "--state", "all", "--json", "number,state",
      "--jq", '.[] | "\\(.state) \\(.number)"',
    ], io);

    if (prs === undefined) return refuse(`gh pr list failed for ${branch}`);

    const number = prs.split("\n").map((line) => line.trim().split(/\s+/)).find((fields) => fields[0] === "OPEN")?.[1];
    if (!number) {
      if (prs.includes("MERGED")) continue;
      if (prs.includes("CLOSED")) return refuse(`PR for ${branch} was closed without merging`);
      return refuse(`${branch} has no PR`);
    }

    if (!installed.length) continue;

    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= 100) return refuse(`gh failed reading review threads for ${branch}`);

      const threads = await readGh([
        "api", "graphql", "-F", "owner={owner}", "-F", "repo={repo}", "-F", `number=${number}`,
        ...(cursor ? ["-f", `after=${cursor}`] : []), "-F", `query=${QUERY}`,
      ], io);

      const parsed = threads === undefined ? undefined : threadPage(threads, logins);
      if (!parsed) return refuse(`gh failed reading review threads for ${branch}`);

      output.push(...parsed.urls.map((url) => `open\t${id}\t${branch}\t${number}\t${url}`));
      cursor = parsed.cursor;
      if (!cursor) break;
    }
  }

  if (output.length === 0) return 0;

  io.err(`${output.join("\n")}\n`);
  return refuse(`unresolved ${names} threads below the base`);
}

export async function startVerb(args: readonly string[], usage: string, root: string, io: Io): Promise<number> {
  if (args.length !== 2) return usageError(usage, io);

  const [project = "", id = ""] = args;
  const preflight = readDelivery(root, io.env).mode === "prs";
  const resumed = await resumable(project, id, io);
  if (resumed && "reason" in resumed) {
    io.err(`start: ${resumed.reason}\n`);
    return 1;
  }

  const adopt = resumed !== undefined;

  const picked = await pickBase(project, id, root, false, io, adopt);
  if (typeof picked === "number") return picked;
  if (resumed && resumed.base !== picked.base) {
    io.err(`stack-base: ${resumed.branch} was cut from ${resumed.base}, but the base is now ${picked.base}; delete ${resumed.branch} and run plans start again to cut it from ${picked.base}\n`);
    return 1;
  }

  if (preflight && !picked.base.startsWith("origin/")) {
    const code = await checkBelow(project, picked.base, root, io);
    if (code !== 0) return code;

    const again = await pickBase(project, id, root, false, io, adopt);
    if (typeof again === "number") return again;
    if (again.base !== picked.base) {
      io.err(`stack-base: base moved from ${picked.base} to ${again.base} during the preflight, start again\n`);
      return 1;
    }
  }

  if (!resumed) {
    const code = await cutBase(picked.base, picked.slug, io);
    if (code !== 0) return code;
  }

  return finishStart(project, id, picked.base, `feat/${picked.slug}`, io);
}

async function resumable(project: string, id: string, io: Io): Promise<{ base: string; branch: string } | { reason: string } | undefined> {
  const cwd = io.cwd;
  const index = projectIndex(project, io);
  if (!index || await checkoutIs(cwd, project, io)) return undefined;

  const row = readIndex(index).find((entry) => entry.id === id);
  if (!row?.slug || !["TODO", "DOING"].includes(row.status)) return undefined;

  const branch = `feat/${row.slug}`;
  if ((await gitOutput(cwd, ["branch", "--show-current"], {}, io))?.trimEnd() !== branch) return undefined;

  const result = await recordedBase(cwd, branch, io);
  if (!result.ok) return { reason: result.reason };

  return result.base ? { base: result.base, branch } : undefined;
}

async function finishStart(project: string, id: string, base: string, branch: string, io: Io): Promise<number> {
  const updated = await markStarted(indexPath(project, io.env), project, id, branch, io.env);
  if (!updated) {
    io.err(`id not found: ${id}\n`);
    return 1;
  }

  io.out(`${base}\n${formatRow(updated)}\n`);
  return 0;
}
