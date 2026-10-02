import { describe, readSync } from "../read.ts";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { added, clip, restored, RULE, skipPath, specFor } from "./comment-scan.ts";
import { object, parsePayload, type Edit } from "./payload.ts";
import {
  basename,
  codePointOrder,
  dirname,
  jsonBlock,
  PY_SPACE,
  splitlines,
  textMode,
} from "./python-text.ts";

let headFailed = false;

function headText(path: string, env: NodeJS.ProcessEnv): string | undefined {
  if (headFailed) return undefined;

  try {
    const directory = dirname(resolve(path));
    if (!statSync(directory, { throwIfNoEntry: false })?.isDirectory()) return "";

    const gitEnv = { ...process.env, ...env };
    delete gitEnv.GIT_DIR;
    delete gitEnv.GIT_WORK_TREE;
    const result = readSync(["git", "show", `HEAD:./${basename(path)}`], {
      cwd: directory,
      env: gitEnv,
      deadline: 5000,
    });

    if (!result.ok) {
      headFailed = true;
      process.stderr.write(describe(result.failure) + "\n");
      return undefined;
    }

    return result.code === 0 ? textMode(result.bytes) : "";
  } catch {
    return "";
  }
}

const EXTS = [".md", ".ts", ".tsx", ".js", ".jsx", ".css", ".json", ".sh", ".py", ".html"];
const DASH_RULE =
  " No em dashes, en dashes or hyphen as dash in anything you write. Rewrite with a comma, colon, parenthesis or full stop, then continue.";

function dashCheck(
  path: string,
  env: NodeJS.ProcessEnv,
  read: (path: string) => string | undefined,
): string | undefined {
  if (!path || skipPath(path, env) || !EXTS.some((ext) => path.endsWith(ext))) return undefined;

  try {
    if (!statSync(path).isFile()) return undefined;
  } catch {
    return undefined;
  }

  const text = read(path);
  if (text === undefined) return undefined;

  const stripped = text
    .replace(/```[\s\S]*?```/g, (match) => "\n".repeat(match.split("\n").length - 1))
    .replace(/`[^`\n]*`/g, "")
    .replace(new RegExp(`https?://[^${PY_SPACE}]+`, "gu"), "");

  const names: string[] = [];
  if (stripped.includes("\u2014")) names.push("an em dash (U+2014)");
  if (stripped.includes("\u2013")) names.push("an en dash (U+2013)");
  if (!names.length) return undefined;

  const lines = splitlines(stripped)
    .flatMap((line, index) => (/[\u2014\u2013]/.test(line) ? [String(index + 1)] : []))
    .slice(0, 5);

  return `${basename(path)} contains ${names.join(" and ")} (line${lines.length > 1 ? "s" : ""} ${lines.join(", ")}).`;
}

type Hit = { path: string; scope: string; line: number; text: string };

function scan(
  edit: Edit,
  env: NodeJS.ProcessEnv,
  read: (path: string) => string | undefined,
): Hit[] | undefined {
  const { path, mode } = edit;
  const spec = specFor(path);
  if (!path || !spec || skipPath(path, env)) return [];

  const fromDisk = read(path);
  const text = fromDisk ?? edit.new;
  const scope = fromDisk === undefined ? edit.new : "";

  let { old, new: fresh } = edit;
  if (mode === "write") {
    old = headText(path, env);
    if (old === undefined) return undefined;
    fresh = text;
  } else if (mode === "edit" && !fresh) {
    const head = headText(path, env);
    if (head === undefined) return undefined;

    const before = restored(text, head, old ?? "");
    if (before === undefined) return [];

    old = before;
    fresh = text;
  }

  return added(text, old, fresh, spec).map(([line, content]) => ({
    path,
    scope,
    line,
    text: content,
  }));
}

export function check(payload: unknown, env: NodeJS.ProcessEnv): string | undefined {
  if (env.AGENT_HOOKS === "0") return undefined;

  const data = object(payload);
  if (!data) return undefined;

  const { paths, edits, reason } = parsePayload(data);
  if (reason) return reason;

  const cache = new Map<string, string | undefined>();
  const read = (path: string): string | undefined => {
    if (!cache.has(path)) {
      try {
        cache.set(path, textMode(readFileSync(path)));
      } catch {
        cache.set(path, undefined);
      }
    }

    return cache.get(path);
  };

  const seen = new Map<string, Hit>();
  for (const edit of edits)
    for (const hit of scan(edit, env, read) ?? []) {
      const key = JSON.stringify([hit.path, hit.scope, hit.line]);
      if (!seen.has(key)) seen.set(key, hit);
    }

  const found = paths
    .map((path) => dashCheck(path, env, read))
    .filter((item) => item !== undefined);

  const reasons = found.length ? [found.join(" ") + DASH_RULE] : [];

  const hits = [...seen.values()].sort(
    (left, right) =>
      codePointOrder(left.path, right.path) ||
      codePointOrder(left.scope, right.scope) ||
      left.line - right.line,
  );

  if (hits.length) {
    const shown = hits
      .slice(0, 6)
      .map((hit) => `  ${basename(hit.path)}: ${clip(hit.text)}`)
      .join("\n");

    const more = hits.length > 6 ? `\n  ... and ${hits.length - 6} more` : "";
    reasons.push(
      `${hits.length} comment line${hits.length > 1 ? "s" : ""} added:\n${shown}${more}\n${RULE}`,
    );
  }

  return reasons.length ? reasons.join("\n\n") : undefined;
}

export async function postToolUse(): Promise<number> {
  if (process.env.AGENT_HOOKS === "0") return 0;

  let payload: unknown;
  try {
    payload = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(readFileSync(0)),
    );
  } catch {
    return 0;
  }

  const reason = check(payload, process.env);
  if (reason !== undefined) process.stdout.write(jsonBlock(reason));

  return 0;
}
