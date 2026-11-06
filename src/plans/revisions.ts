import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Io } from "../io.ts";
import { isCtxSlug } from "./batch.ts";
import { createDurably, decodeUtf8, plansDir, projectDir } from "./index-tsv.ts";
import { readStore } from "./projection.ts";
import { revisionsUnder, revisionText, sha256, type RevisionEntry, type Store } from "./store.ts";

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY_MS = 86_400_000;
export function parseTime(text: string): number | undefined {
  const date = DATE.exec(text);
  if (date) {
    const start = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    const valid = new Date(start).toISOString().startsWith(text);
    return valid ? start + DAY_MS - 1 : undefined;
  }

  if (!INSTANT.test(text)) return undefined;

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;

  return new Date(at).toISOString().slice(0, 19) === text.slice(0, 19) ? at : undefined;
}

type Copies = { prefix: string; folders: string[]; matches: (name: string) => boolean };

function copiesOf(project: string, key: string): Copies {
  if (isCtxSlug(key))
    return { prefix: `${key}.md`, folders: [project], matches: (name) => name === `${key}.md` };

  return {
    prefix: `${key}-`,
    folders: [project, `${project}/done`],
    matches: (name) => name.startsWith(`${key}-`) && name.endsWith(".md"),
  };
}

function storedCopies(store: Store, copies: Copies): RevisionEntry[] {
  return copies.folders
    .flatMap((folder) =>
      revisionsUnder(store, `${folder}/${copies.prefix}`).filter(
        (entry) => dirname(entry.path) === folder && copies.matches(basename(entry.path)),
      ),
    )
    .sort((a, b) => a.seq - b.seq);
}

function diskCopies(root: string, copies: Copies): string[] {
  return copies.folders.flatMap((folder) => {
    try {
      return readdirSync(join(root, folder))
        .filter(copies.matches)
        .map((name) => join(root, folder, name));
    } catch {
      return [];
    }
  });
}

type Chosen = { entry: RevisionEntry; text: Uint8Array };
type Read = { root: string; copies: Copies; entries: RevisionEntry[]; chosen: Chosen | undefined };

async function readRevisions(
  project: string,
  key: string,
  io: Io,
  choose: (entries: RevisionEntry[]) => RevisionEntry | undefined = () => undefined,
): Promise<Read | { refusal: string }> {
  try {
    projectDir(project, io.env);
  } catch (error) {
    return { refusal: (error as Error).message };
  }

  const root = plansDir(io.env);
  const copies = copiesOf(project, key);
  const read = await readStore(root, (store) => {
    const entries = storedCopies(store, copies);
    const entry = choose(entries);
    const chosen = entry && { entry, text: revisionText(store, entry.seq) };
    return { root, copies, entries, chosen };
  });

  if (read.kind === "failed") return { refusal: read.reason };
  if (read.kind === "absent" || read.value.entries.length === 0)
    return { refusal: `no revisions of ${key} in ${project}` };

  return read.value;
}

function parseKey(args: readonly string[]): { project: string; key: string } | undefined {
  const [project, key] = args;
  if (!project || !key || args.length !== 2) return undefined;
  if (!/^[0-9]{3}$/.test(key) && !isCtxSlug(key)) return undefined;

  return { project, key };
}

function refuse(io: Io, verb: string, reason: string): number {
  io.err(`${verb}: ${reason}\n`);
  return 1;
}

function usage(io: Io, text: string): number {
  io.err(`usage: ${text}\n`);
  return 2;
}

export async function showVerb(args: readonly string[], text: string, io: Io): Promise<number> {
  const at = args.indexOf("--at");
  const time = at < 0 ? undefined : args[at + 1];
  const rest = at < 0 ? args : args.filter((_, index) => index !== at && index !== at + 1);
  const parsed = parseKey(rest);
  if (!parsed || (at >= 0 && time === undefined)) return usage(io, text);

  const until = time === undefined ? Infinity : parseTime(time);
  if (until === undefined) return refuse(io, "show", `not a time: ${time}`);

  const read = await readRevisions(parsed.project, parsed.key, io, (entries) =>
    entries.findLast((entry) => Date.parse(entry.captured) <= until),
  );

  if ("refusal" in read) return refuse(io, "show", read.refusal);
  if (!read.chosen) return refuse(io, "show", `no revision of ${parsed.key} at or before ${time}`);

  let printed: string;
  try {
    printed = decodeUtf8(read.chosen.text);
  } catch {
    return refuse(io, "show", `${read.chosen.entry.path} at that revision is not valid UTF-8`);
  }

  io.out(printed);
  return 0;
}

export async function historyVerb(args: readonly string[], text: string, io: Io): Promise<number> {
  const parsed = parseKey(args);
  if (!parsed) return usage(io, text);

  const read = await readRevisions(parsed.project, parsed.key, io);
  if ("refusal" in read) return refuse(io, "history", read.refusal);

  for (const entry of read.entries)
    io.out(`${[entry.captured, entry.sha256, entry.machine, entry.bytes].join("\t")}\n`);

  return 0;
}

function readWorkingCopy(path: string): Uint8Array | undefined {
  try {
    return readFileSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function checkoutVerb(args: readonly string[], text: string, io: Io): Promise<number> {
  const parsed = parseKey(args);
  if (!parsed) return usage(io, text);

  const read = await readRevisions(parsed.project, parsed.key, io, (entries) => entries.at(-1));
  if ("refusal" in read) return refuse(io, "checkout", read.refusal);

  const { entry, text: newest } = read.chosen!;
  const path = join(read.root, entry.path);
  const elsewhere = diskCopies(read.root, read.copies).filter((copy) => copy !== path);
  if (elsewhere.length > 0)
    return refuse(io, "checkout", `${elsewhere.join(", ")} holds ${parsed.key}, not ${path}`);

  const disk = readWorkingCopy(path);
  if (disk === undefined) {
    mkdirSync(dirname(path), { recursive: true });

    try {
      createDurably(path, newest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return refuse(io, "checkout", `${path} appeared during checkout, run it again`);
    }

    io.out(`${path} written\n`);
    return 0;
  }

  if (sha256(disk) === entry.sha256) {
    io.out(`${path} current\n`);
    return 0;
  }

  return refuse(
    io,
    "checkout",
    `${path} differs from its newest revision, a plans verb that reads it records it`,
  );
}
