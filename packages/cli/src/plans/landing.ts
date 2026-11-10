import { existsSync, mkdirSync, renameSync } from "node:fs";
import { basename, dirname, join, sep } from "node:path";
import { compareEvents, type Stamp } from "skills-core";
import { createDurably, replaceDurably } from "./index-tsv.ts";
import { recordConflict } from "./outbox.ts";
import {
  counterparts,
  isCopyKey,
  planOfCopy,
  readCopy,
  revisionText,
  sha256,
  write,
  type Store,
} from "./store.ts";

export type Landed = {
  readonly path: string;
  readonly author: string | null;
  readonly replaced: boolean;
};

export type Conflicted = { readonly path: string; readonly project: string; readonly plan: string };

export type Landings = { readonly landed: Landed[]; readonly conflicts: Conflicted[] };

type Node = Lineage & { readonly path: string };

type Pending = Node & {
  readonly project: string;
  readonly author: string | null;
  readonly stored: number;
};

const NODE = `e.id, e.machine, e.wall, e.counter, r.path, r.sha256,
  json_extract(e.payload, '$.base') AS base`;

function pending(store: Store): Pending[] {
  return store.db
    .query(
      `SELECT ${NODE}, r.project, e.author,
         EXISTS (SELECT 1 FROM blobs b WHERE b.sha256 = r.sha256) AS stored
       FROM landings l
       JOIN revisions r ON r.event = l.event
       JOIN events e ON e.id = l.event AND e.quarantined IS NULL
       WHERE l.state IS NULL`,
    )
    .all() as Pending[];
}

function settle(store: Store, event: string, state: "landed" | "conflict" | "superseded"): void {
  store.db.run("UPDATE landings SET state = ? WHERE event = ?", [state, event]);
}

function fileKey(path: string): string {
  const parts = path.split(sep);
  return `${parts[0]}${sep}${basename(path)}`;
}

export type Lineage = Stamp & {
  readonly id: string;
  readonly sha256: string;
  readonly base: string | null;
};

export function newest<T extends Stamp>(nodes: readonly T[]): T {
  return nodes.reduce((best, node) => (compareEvents(node, best) > 0 ? node : best));
}

export function earliest<T extends Stamp>(candidates: readonly T[], node: Stamp): T | undefined {
  const earlier = candidates.filter((candidate) => compareEvents(candidate, node) < 0);
  return earlier.length === 0 ? undefined : newest(earlier);
}

export function lineage<T extends Lineage>(
  node: T,
  parentOf: (node: T, base: string) => T | undefined,
): T[] {
  const chain: T[] = [];
  const visited = new Set<string>();
  for (let current: T | undefined = node; current !== undefined;) {
    if (visited.has(current.id)) break;

    visited.add(current.id);
    chain.push(current);
    current = current.base === null ? undefined : parentOf(current, current.base);
  }

  return chain;
}

export function ancestryOf<T extends Lineage>(
  node: T,
  parentOf: (node: T, base: string) => T | undefined,
): Set<string> {
  const chain = lineage(node, parentOf);
  return new Set(
    chain.flatMap((link) => (link.base === null ? [link.sha256] : [link.sha256, link.base])),
  );
}

function parentOf(store: Store, node: Node, base: string): Node | undefined {
  const candidates = store.db
    .query(
      `SELECT ${NODE} FROM revisions r JOIN events e ON e.id = r.event AND e.quarantined IS NULL
       WHERE r.sha256 = ? AND r.path IN (SELECT value FROM json_each(?))`,
    )
    .all(base, JSON.stringify(counterparts(node.path))) as Node[];

  return earliest(candidates, node);
}

function ancestry(store: Store, node: Node): Set<string> {
  return ancestryOf(node, (current, base) => parentOf(store, current, base));
}

type Outcome = { kind: "landed"; replaced: boolean } | { kind: "conflict"; local: string };

function land(store: Store, root: string, pulled: Pending, text: Uint8Array): Outcome {
  const [project = "", folder] = pulled.path.split(sep);
  const name = basename(pulled.path);
  const target = join(root, pulled.path);
  const rootCopy = join(root, project, name);
  const doneCopy = join(root, project, "done", name);

  const closing = folder === "done";
  if (!closing && existsSync(doneCopy)) {
    const done = readCopy(doneCopy);
    return { kind: "conflict", local: done === undefined ? "" : sha256(done) };
  }

  const moving = closing && !existsSync(doneCopy) && existsSync(rootCopy);
  const disk = readCopy(moving ? rootCopy : target);
  if (disk === undefined) {
    mkdirSync(dirname(target), { recursive: true });
    createDurably(target, text);
    return { kind: "landed", replaced: false };
  }

  const digest = sha256(disk);
  if (digest !== pulled.sha256 && !ancestry(store, pulled).has(digest))
    return { kind: "conflict", local: digest };

  if (moving) {
    mkdirSync(dirname(target), { recursive: true });
    renameSync(rootCopy, target);
  }

  if (digest !== pulled.sha256) replaceDurably(target, text);
  return { kind: "landed", replaced: digest !== pulled.sha256 || moving };
}

export function landWorkingCopies(store: Store, root: string): Landings {
  const landed: Landed[] = [];
  const conflicts: Conflicted[] = [];

  write(store, () => {
    const groups = new Map<string, Pending[]>();
    for (const node of pending(store)) {
      if (!isCopyKey(node.path)) {
        settle(store, node.id, "superseded");
        continue;
      }

      const key = fileKey(node.path);
      groups.set(key, [...(groups.get(key) ?? []), node]);
    }

    const conflict = (node: Pending, local: string) => {
      const plan = planOfCopy(node.path);
      recordConflict(store, {
        project: node.project,
        plan,
        path: node.path,
        sha256: node.sha256,
        event: node.id,
        local,
      });

      settle(store, node.id, "conflict");
      conflicts.push({ path: node.path, project: node.project, plan });
    };

    for (const nodes of groups.values()) {
      const chosen = newest(nodes);
      const text = chosen.stored === 1 ? revisionText(store, chosen.sha256) : undefined;
      if (text === undefined) continue;

      let outcome: Outcome;
      try {
        outcome = land(store, root, chosen, text);
      } catch {
        continue;
      }

      const local = outcome.kind === "landed" ? chosen.sha256 : outcome.local;
      const ancestors = ancestry(store, chosen);
      const others = nodes.filter((node) => node !== chosen);
      const concurrent = others.filter(
        (node) => !ancestors.has(node.sha256) && node.sha256 !== local,
      );

      for (const node of others)
        if (!concurrent.includes(node)) settle(store, node.id, "superseded");

      if (outcome.kind === "landed") {
        settle(store, chosen.id, "landed");
        landed.push({ path: chosen.path, author: chosen.author, replaced: outcome.replaced });
      } else conflict(chosen, outcome.local);

      for (const node of concurrent) conflict(node, local);
    }
  });

  return { landed, conflicts };
}
