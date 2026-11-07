import {
  hookChangeLine,
  codexHost,
  reconcileHooks,
  ownedEntries as ownedHooks,
  missingEntries as missingHooks,
  addEntries,
  type MissingEntry,
  type OwnedEntry,
  type HookOptions,
} from "./hooks-file.ts";
import type { HookTarget } from "./hook-table.ts";
import { stringifyJson, type Json, type JsonObject } from "./json.ts";
import { readSettings, writeSettings } from "./settings-file.ts";

export { addEntries };
export type { MissingEntry, OwnedEntry, HookOptions };

export function ownedEntries(
  data: Json,
  hooksDir: string,
  personal: readonly string[],
): OwnedEntry[] {
  return ownedHooks(data, codexHost(hooksDir, ""), personal);
}

export function missingEntries(
  data: Json,
  agentsDir: string,
  unwired: ReadonlySet<HookTarget> = new Set(),
): MissingEntry[] {
  return missingHooks(data, codexHost("", agentsDir), unwired);
}

export function skipHooks(
  path: string,
  reason: string,
  missing: readonly MissingEntry[],
  owned: readonly OwnedEntry[] = [],
): string {
  if (!missing.length) return `skip   ${path} (${reason})\n`;

  const handAdd: JsonObject = { hooks: {} };
  addEntries(handAdd, missing);

  return `skip   ${path} (${reason}), Codex runs none of the missing skills hooks until you add them:\n${stringifyJson(handAdd)}\n${owned.map(({ event, old }) => `codex  remove ${event} ${old} by hand\n`).join("")}`;
}

export function writeCodexHooks(
  path: string,
  hooksDir: string,
  agentsDir: string,
  options: HookOptions = {},
): string {
  const host = codexHost(hooksDir, agentsDir);
  const file = readSettings(path);
  const result = reconcileHooks("refused" in file ? {} : file.data, host, path, options);
  const refusal = (reason: string) =>
    `${result.output.map((line) => `${line}\n`).join("")}${skipHooks(path, reason, result.wanted, result.owned)}`;

  if ("refused" in file) return refusal(file.refused);
  if (result.kind === "refused") return refusal(result.reason);
  if (!result.changes.length)
    return `${[...result.output, `codex  ${path} already holds every skills hook`].join("\n")}\n`;

  const written = writeSettings(file, file.data);
  if (written.outcome === "refused") return refusal(written.reason);
  if (written.outcome === "unchanged")
    return `${[...result.output, `codex  ${path} already holds every skills hook`].join("\n")}\n`;

  const output = [
    ...result.output,
    ...result.changes.map((change) => hookChangeLine(change, "codex")),
  ];

  if (result.changes.some((change) => change.kind === "add" || change.kind === "replace"))
    output.push(`codex  ${path} (open codex, run /hooks, trust the new entries once)`);

  return `${output.join("\n")}\n`;
}
