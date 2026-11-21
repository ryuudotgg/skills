import { Glob } from "bun";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join, resolve, sep } from "node:path";
import type { Suite } from "../registry.ts";
import { worktreeFiles } from "./git.ts";

export type Change = { path: string; deleted: boolean };

type Scan = { importers: Map<string, Set<string>>; texts: Map<string, string> };

const importLine =
  /^(?:import|export)\s+(?:type\s+)?(?:[\w$]+\s*,?\s*)?(?:\{[^{}]*\}|\*(?:\s+as\s+[\w$]+)?)?\s*from\s*["'][^"']+["'];?[ \t]*$|^import\s*["'][^"']+["'];?[ \t]*$/gm;

const startedPath = /(?:\.ts|\.sh|bin\/skills)["'`]/;
const relativeModule = /(?<!\b(?:from|import)\s*\(?\s*)["'`](\.{1,2}\/[^"'`\s]+\.tsx?)["'`]/g;

const scanners: Record<string, Bun.Transpiler | undefined> = {
  ".ts": new Bun.Transpiler({ loader: "ts" }),
  ".tsx": new Bun.Transpiler({ loader: "tsx" }),
  ".js": new Bun.Transpiler({ loader: "js" }),
  ".jsx": new Bun.Transpiler({ loader: "jsx" }),
};

export function startsProcess(text: string): boolean {
  return startedPath.test(text.replaceAll(importLine, ""));
}

function matches(patterns: readonly string[], path: string): boolean {
  return patterns.some((pattern) => new Glob(pattern).match(path));
}

function scanImports(root: string, roots: readonly string[]): Scan | null {
  const importers = new Map<string, Set<string>>();
  const texts = new Map<string, string>();
  const pending = [...roots];
  const follow = (target: string, from: string) => {
    if (!target.startsWith(root + sep) || target.split(sep).includes("node_modules")) return;
    importers.set(target, (importers.get(target) ?? new Set()).add(from));
    pending.push(target);
  };

  while (pending.length > 0) {
    const file = pending.pop()!;
    const scanner = scanners[extname(file)];
    if (texts.has(file) || !scanner) continue;

    try {
      const text = readFileSync(file, "utf8");
      texts.set(file, text);

      for (const { path } of scanner.scanImports(text))
        if (!isBuiltin(path)) follow(realpathSync(Bun.resolveSync(path, dirname(file))), file);

      // A worker or child started from a relative path is no import, so the scanner does not report it.
      for (const [, path] of text.matchAll(relativeModule)) {
        const target = resolve(dirname(file), path!);
        if (existsSync(target)) follow(realpathSync(target), file);
      }
    } catch {
      return null;
    }
  }

  return { importers, texts };
}

function dependents(importers: Scan["importers"], changed: readonly string[]): Set<string> {
  const reached = new Set<string>();
  const pending = [...changed];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (reached.has(file)) continue;

    reached.add(file);
    pending.push(...(importers.get(file) ?? []));
  }

  return reached;
}

export async function affectedTests(
  repo: string,
  suite: Suite,
  changes: readonly Change[],
): Promise<string[] | null> {
  const { graph } = suite;
  if (!graph) return null;

  const isSource = ({ path }: Change) => matches(graph.sources, path);
  const watched = [...suite.watch, ...suite.files];
  const unreadable = changes.some((change) =>
    isSource(change) ? change.deleted : matches(watched, change.path),
  );

  if (unreadable) return null;

  const root = realpathSync(repo);
  const listed = await worktreeFiles(repo);
  const tests = listed.filter((path) => matches(suite.files, path)).sort();
  const unimported = graph.unimported.map((pattern) =>
    listed.filter((path) => matches([pattern], path)),
  );

  if (unimported.some((found) => found.length === 0)) return null;

  const scan = scanImports(
    root,
    [...tests, ...unimported.flat()].map((path) => join(root, path)),
  );

  if (!scan) return null;

  const unanswered = changes.some((change) => {
    const file = join(root, change.path);
    return isSource(change) ? !scan.texts.has(file) : scan.importers.has(file);
  });

  if (unanswered) return null;

  const reached = dependents(
    scan.importers,
    changes.filter(isSource).map(({ path }) => join(root, path)),
  );

  if (unimported.flat().some((path) => reached.has(join(root, path)))) return null;

  return tests.filter(
    (path) => reached.has(join(root, path)) || startsProcess(scan.texts.get(join(root, path))!),
  );
}
