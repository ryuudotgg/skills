import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { parseTime } from "skills-core";
import type { Io } from "../io.ts";
import { isCtxSlug } from "./batch.ts";
import { createDurably, decodeUtf8, plansDir, projectDir } from "./index-tsv.ts";
import { readStore } from "./projection.ts";
import { openPlansStore } from "./commit.ts";
import { Refusal } from "./import.ts";
import {
  compareRevisions,
  latestRevision,
  revisionsUnder,
  revisionText,
  sha256,
  write,
  type RevisionEntry,
  type Store,
} from "./store.ts";

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
    .sort(compareRevisions);
}

function diskCopies(root: string, copies: Copies): string[] {
  return copies.folders.flatMap((folder) => {
    let names: string[];
    try {
      names = readdirSync(join(root, folder));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }

    return names.filter(copies.matches).map((name) => join(root, folder, name));
  });
}

type Chosen = { entry: RevisionEntry; text: Uint8Array | undefined };
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
    const chosen = entry && { entry, text: revisionText(store, entry.sha256) };
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

  const { entry, text: bytes } = read.chosen;
  if (bytes === undefined) return refuse(io, "show", fetching(entry));

  let printed: string;
  try {
    printed = decodeUtf8(bytes);
  } catch {
    return refuse(io, "show", `${entry.path} at that revision is not valid UTF-8`);
  }

  io.out(printed);
  return 0;
}

export async function historyVerb(args: readonly string[], text: string, io: Io): Promise<number> {
  const parsed = parseKey(args);
  if (!parsed) return usage(io, text);

  const read = await readRevisions(parsed.project, parsed.key, io);
  if ("refusal" in read) return refuse(io, "history", read.refusal);

  for (const entry of read.entries) {
    const fields = [entry.captured, entry.sha256, entry.machine, entry.bytes];
    io.out(`${[...fields, ...(entry.stored ? [] : ["(fetching)"])].join("\t")}\n`);
  }

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

type Restored = { line: string } | { refusal: string };

function fetching(entry: RevisionEntry): string {
  return `${entry.path} at that revision is still fetching from another machine`;
}

function restore(
  path: string,
  entry: RevisionEntry,
  newest: Uint8Array,
  ownLatest: string | undefined,
): Restored {
  const disk = readWorkingCopy(path);
  if (disk === undefined) {
    mkdirSync(dirname(path), { recursive: true });

    try {
      createDurably(path, newest);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return { refusal: `${path} appeared during checkout, run it again` };
    }

    return { line: `${path} written` };
  }

  const digest = sha256(disk);
  if (digest === entry.sha256) return { line: `${path} current` };

  if (digest === ownLatest)
    return {
      refusal: `${path} is this machine's last revision and a newer one came from ${entry.machine}, move it out of the plans directory and run checkout again`,
    };

  return {
    refusal: `${path} differs from its newest revision, a plans verb that reads it records it`,
  };
}

function restoreNewest(store: Store, root: string, key: string, copies: Copies): Restored {
  const entry = storedCopies(store, copies).at(-1);
  if (!entry) return { refusal: `no revisions of ${key} in ${copies.folders[0]}` };

  const path = join(root, entry.path);
  try {
    const elsewhere = diskCopies(root, copies).filter((copy) => copy !== path);
    if (elsewhere.length > 0)
      return { refusal: `${elsewhere.join(", ")} holds ${key}, not ${path}` };

    const newest = revisionText(store, entry.sha256);
    if (newest !== undefined)
      return restore(path, entry, newest, latestRevision(store, entry.path));

    const disk = readWorkingCopy(path);
    if (disk !== undefined && sha256(disk) === entry.sha256) return { line: `${path} current` };

    return { refusal: fetching(entry) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === undefined) throw error;
    return { refusal: `${path}: ${code}` };
  }
}

export async function checkoutVerb(args: readonly string[], text: string, io: Io): Promise<number> {
  const parsed = parseKey(args);
  if (!parsed) return usage(io, text);

  try {
    projectDir(parsed.project, io.env);
  } catch (error) {
    return refuse(io, "checkout", (error as Error).message);
  }

  const root = plansDir(io.env);
  const copies = copiesOf(parsed.project, parsed.key);

  let restored: Restored;
  try {
    const store = await openPlansStore(root);
    try {
      restored = write(store, () => restoreNewest(store, root, parsed.key, copies));
    } finally {
      store.db.close();
    }
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return refuse(io, "checkout", error.message);
  }

  if ("refusal" in restored) return refuse(io, "checkout", restored.refusal);

  io.out(`${restored.line}\n`);
  return 0;
}
