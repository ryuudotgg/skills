import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { flatten } from "skills-core";
import type { Io } from "../io.ts";
import { asciiLower } from "../project.ts";
import { openPlansStore, recordWorkingCopies } from "./commit.ts";
import { Refusal } from "./import.ts";
import { plansDir } from "./index-tsv.ts";
import { foldRecall, recallBehind, recallStatus } from "./recall.ts";
import { CTX_FILE, PLAN_FILE, projectedRows, storedIssues, write, type Store } from "./store.ts";

const DEFAULT_LIMIT = 20;

const LISTED = 50;

const FUSION_K = 60;

type Index = { table: "recall" | "recall_trigram"; minimum: number; tokens: number };

const INDEXES: readonly Index[] = [
  { table: "recall", minimum: 1, tokens: 12 },
  { table: "recall_trigram", minimum: 3, tokens: 64 },
];

type Request = { words: string[]; project?: string; limit: number; json: boolean };

type Listed = {
  id: number;
  project: string;
  ref: string;
  slug: string;
  section: string;
  path: string;
  recorded: string;
  snippet: string;
};

export type RecallHit = Omit<Listed, "id" | "slug"> & { status: string; rank: number };

function parse(args: readonly string[]): Request | undefined {
  const request: Request = { words: [], limit: DEFAULT_LIMIT, json: false };
  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!;
    if (arg === "--json") request.json = true;
    else if (arg === "--project" || arg === "--limit") {
      const value = args[++at];
      if (value === undefined) return undefined;
      if (arg === "--project") request.project = value;
      else if (/^[1-9][0-9]*$/.test(value)) request.limit = Number(value);
      else return undefined;
    } else if (arg.startsWith("--")) return undefined;
    else request.words.push(...arg.split(/\s+/).filter(Boolean));
  }

  return request.words.length > 0 ? request : undefined;
}

function names(directory: string): string[] {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

function projectsIn(root: string): string[] {
  return names(root).filter(
    (name) =>
      !name.startsWith(".") && statSync(join(root, name), { throwIfNoEntry: false })?.isDirectory(),
  );
}

function workingCopies(root: string, project: string): string[] {
  const directory = join(root, project);
  const done = join(directory, "done");
  return [
    ...names(directory)
      .filter((name) => PLAN_FILE.test(name) || CTX_FILE.test(name))
      .map((name) => join(directory, name)),
    ...names(done)
      .filter((name) => PLAN_FILE.test(name))
      .map((name) => join(done, name)),
  ];
}

function phrase(word: string): string {
  return `"${word.replaceAll('"', '""')}"`;
}

function listed(store: Store, index: Index, words: string[], project?: string): Listed[] {
  const usable = words.filter((word) => [...word].length >= index.minimum);
  const short = words.filter((word) => !usable.includes(word));
  if (usable.length === 0) return [];

  const { table, tokens } = index;
  return store.db
    .query(
      `SELECT rowid AS id, project, ref, slug, section, path, recorded,
         snippet(${table}, 2, '[', ']', '...', ${tokens}) AS snippet
       FROM ${table} WHERE ${table} MATCH ?1 AND (?2 IS NULL OR project = ?2)
         AND (?3 IS NULL OR rowid IN (SELECT rowid FROM recall WHERE recall MATCH ?3))
       ORDER BY bm25(${table}), recorded DESC, project, ref, path, section, body LIMIT ${LISTED}`,
    )
    .all(
      usable.map(phrase).join(" "),
      project ?? null,
      short.length === 0 ? null : short.map(phrase).join(" "),
    ) as Listed[];
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function fuse(lists: Listed[][]): (Listed & { rank: number })[] {
  const fused = new Map<number, Listed & { rank: number }>();

  for (const list of lists)
    list.forEach((entry, at) => {
      const score = 1 / (FUSION_K + at + 1);
      const known = fused.get(entry.id);
      if (known) known.rank += score;
      else fused.set(entry.id, { ...entry, rank: score });
    });

  return [...fused.values()].sort(
    (left, right) =>
      right.rank - left.rank ||
      compare(right.recorded, left.recorded) ||
      compare(left.project, right.project) ||
      compare(left.ref, right.ref) ||
      compare(left.path, right.path) ||
      compare(left.section, right.section),
  );
}

export function searchRecall(store: Store, words: string[], project?: string): RecallHit[] {
  return store.db
    .transaction(() => {
      const world = { rows: projectedRows(store), issues: storedIssues(store) };
      const fused = fuse(INDEXES.map((index) => listed(store, index, words, project)));
      return fused.map((hit) => ({
        project: hit.project,
        ref: hit.ref,
        section: hit.section,
        status: recallStatus(hit, world),
        snippet: hit.snippet.replace(/\s+/g, " ").trim(),
        path: hit.path,
        recorded: hit.recorded,
        rank: hit.rank,
      }));
    })
    .deferred();
}

async function search(root: string, words: string[], project?: string): Promise<RecallHit[]> {
  const store = await openPlansStore(root);
  try {
    if (recallBehind(store.db)) write(store, () => foldRecall(store.db));
    return searchRecall(store, words, project);
  } finally {
    store.db.close();
  }
}

function line(hit: RecallHit): string {
  const { project, ref, section, status, snippet, path } = hit;
  return [project, ref, section, status, snippet, path].map(flatten).join("\t");
}

function json(hit: RecallHit): string {
  const { project, ref, section, status, snippet, path, recorded, rank } = hit;
  return JSON.stringify({ project, ref, section, status, snippet, path, recorded, rank });
}

function refuse(io: Io, reason: string): number {
  io.err(`recall: ${reason}\n`);
  return 1;
}

export async function recallVerb(args: readonly string[], usage: string, io: Io): Promise<number> {
  const request = parse(args);
  if (!request) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const root = plansDir(io.env);
  const known = projectsIn(root);
  const wanted = request.project === undefined ? undefined : asciiLower(request.project);
  const project = known.find((name) => asciiLower(name) === wanted);
  if (request.project !== undefined && project === undefined)
    return refuse(io, `no project ${request.project} under ${root}`);

  let hits: RecallHit[];
  try {
    const scope = project === undefined ? known : [project];
    await recordWorkingCopies(
      root,
      scope.flatMap((name) => workingCopies(root, name)),
    );

    hits = await search(root, request.words, project);
  } catch (error) {
    if (error instanceof Refusal) return refuse(io, error.message);
    const reason = error instanceof Error ? error.message : String(error);
    return refuse(io, `cannot read ${join(root, "plans.db")}: ${reason}`);
  }

  for (const hit of hits.slice(0, request.limit))
    io.out(`${request.json ? json(hit) : line(hit)}\n`);

  return 0;
}
