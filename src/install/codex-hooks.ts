import { basename, join } from "node:path";
import {
  commandFor,
  failsClosedWithoutBun,
  hookTable,
  reachesCodexNames,
  retired,
  type HookEvent,
  type HookTarget,
} from "./hook-table.ts";
import { object, stringifyJson, type Json, type JsonObject } from "./json.ts";
import { readSettings, writeSettings } from "./settings-file.ts";

export type MissingEntry = { event: HookEvent; matcher: string | undefined; command: string };
export type OwnedEntry = {
  event: HookEvent;
  target: HookTarget;
  group: JsonObject;
  entry: JsonObject;
  old: string;
};

export type HookOptions = { noCli?: boolean; noBun?: boolean; personal?: readonly string[] };

function groups(data: Json, event: HookEvent): Json[] {
  const rows = object(object(data)?.hooks)?.[event];
  return Array.isArray(rows) ? rows : [];
}

export function ownedEntries(
  data: Json,
  hooksDir: string,
  personal: readonly string[],
): OwnedEntry[] {
  const result: OwnedEntry[] = [];
  for (const { event, target } of hookTable) {
    const commands = new Set(
      retired
        .filter(([name, current]) => current === target && !personal.includes(name))
        .map(([name]) => join(hooksDir, name)),
    );

    for (const row of groups(data, event)) {
      const group = object(row);
      if (!group || !Array.isArray(group.hooks)) continue;

      for (const hook of group.hooks) {
        const entry = object(hook);
        if (entry && typeof entry.command === "string" && commands.has(entry.command))
          result.push({ event, target, group, entry, old: entry.command });
      }
    }
  }

  return result;
}

export function missingEntries(
  data: Json,
  agentsDir: string,
  unwired: ReadonlySet<HookTarget> = new Set(),
): MissingEntry[] {
  return hookTable
    .filter(
      ({ event, target, codexNames }) =>
        !unwired.has(target) &&
        !groups(data, event).some((row) => {
          const group = object(row);
          const entries = group?.hooks;
          return (
            group !== undefined &&
            reachesCodexNames(group.matcher, codexNames) &&
            Array.isArray(entries) &&
            entries.some((entry) => object(entry)?.command === commandFor(target, agentsDir))
          );
        }),
    )
    .map(({ event, target, matcher }) => ({
      event,
      matcher: matcher?.codex,
      command: commandFor(target, agentsDir),
    }));
}

export function addEntries(data: JsonObject, missing: readonly MissingEntry[]): void {
  const hooks = object(data.hooks) ?? {};
  data.hooks = hooks;

  for (const { event, matcher, command } of missing) {
    const rows = hooks[event] ?? [];
    if (!Array.isArray(rows)) throw new Error(`${event} is not a list`);

    rows.push({
      ...(matcher === undefined ? {} : { matcher }),
      hooks: [{ type: "command", command }],
    });

    hooks[event] = rows;
  }
}

function dropEntry(data: JsonObject, event: HookEvent, group: JsonObject, entry: JsonObject): void {
  const entries = group.hooks;
  if (!Array.isArray(entries)) throw new Error("owned hooks are not a list");

  entries.splice(entries.indexOf(entry), 1);

  if (!entries.length) {
    const rows = groups(data, event);
    rows.splice(rows.indexOf(group), 1);
  }
}

function dropUnreachable(
  data: JsonObject,
  agentsDir: string,
  unwired: ReadonlySet<HookTarget>,
): string[] {
  const changes: string[] = [];
  for (const { event, target, codexNames } of hookTable) {
    if (unwired.has(target)) continue;

    const command = commandFor(target, agentsDir);
    for (const row of groups(data, event).slice()) {
      const group = object(row);
      if (!group || !Array.isArray(group.hooks) || reachesCodexNames(group.matcher, codexNames))
        continue;

      for (const hook of group.hooks.slice()) {
        const entry = object(hook);
        if (entry?.command !== command) continue;

        dropEntry(data, event, group, entry);
        changes.push(
          `codex  drop ${event} ${command} (matcher ${typeof group.matcher === "string" ? group.matcher : stringifyJson(group.matcher!)} misses ${codexNames.join(", ")})`,
        );
      }
    }
  }

  return changes;
}

function replaceRetired(
  data: JsonObject,
  owned: readonly OwnedEntry[],
  agentsDir: string,
): string[] {
  const absent = new Set(
    missingEntries(data, agentsDir).map(({ event, command }) => `${event}\t${command}`),
  );

  const changes: string[] = [];
  for (const { event, target, group, entry, old } of owned) {
    const command = commandFor(target, agentsDir);
    const key = `${event}\t${command}`;
    const names = hookTable.find((row) => row.target === target)!.codexNames;
    if (absent.has(key) && reachesCodexNames(group.matcher, names)) {
      entry.command = command;
      absent.delete(key);
      changes.push(`codex  replace ${event} ${old} with ${command}`);
    } else {
      dropEntry(data, event, group, entry);
      changes.push(`codex  drop ${event} ${old}`);
    }
  }

  return changes;
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
  const output: string[] = [];
  const unwired = new Set<HookTarget>();
  for (const { target } of hookTable)
    if (options.noCli) {
      unwired.add(target);
      output.push(
        `skip   ${target} Codex entry (the repo's ${target} is not what runs, so none is added)`,
      );
    } else if (options.noBun && !failsClosedWithoutBun.has(target)) {
      unwired.add(target);
      output.push(`skip   ${target} Codex entry (Bun is missing, so none is added)`);
    }

  if (options.noBun && !options.noCli)
    for (const target of failsClosedWithoutBun)
      output.push(
        `codex  Bun is missing, so ${target} denies every Codex shell command until Bun is installed`,
      );

  let data: Json = { hooks: {} };
  let owned: OwnedEntry[] = [];
  let missing = missingEntries(data, agentsDir, unwired);
  const skip = (reason: string): string =>
    `${output.map((line) => `${line}\n`).join("")}${skipHooks(path, reason, missing, owned)}`;

  const file = readSettings(path);
  if ("refused" in file) return skip(file.refused);

  data = file.data;

  const personalTargets = new Map<HookTarget, string>();
  for (const { target, old } of ownedEntries(data, hooksDir, []))
    if (options.personal?.includes(basename(old))) personalTargets.set(target, old);

  for (const [target, old] of personalTargets) {
    unwired.add(target);
    output.push(
      `skip   ${target} Codex entry (${path} already runs ${old}, which this repo did not install)`,
    );
  }

  owned = ownedEntries(data, hooksDir, options.personal ?? []).filter(
    ({ target }) => !unwired.has(target),
  );

  missing = missingEntries(data, agentsDir, unwired);
  const record = file.data;
  const hooks = object(record.hooks);
  if (Object.hasOwn(record, "hooks") && !hooks) return skip("hooks is not an object");

  for (const { event } of missing)
    if (hooks && Object.hasOwn(hooks, event) && !Array.isArray(hooks[event]))
      return skip(`${event} is not a list`);

  const wanted = missing;
  const changes = [
    ...dropUnreachable(record, agentsDir, unwired),
    ...replaceRetired(record, owned, agentsDir),
  ];

  missing = missingEntries(data, agentsDir, unwired);
  if (!missing.length && !changes.length)
    return `${[...output, `codex  ${path} already holds every skills hook`].join("\n")}\n`;

  const refusal = (reason: string): string =>
    `${output.map((line) => `${line}\n`).join("")}${skipHooks(path, reason, wanted, owned)}`;

  addEntries(record, missing);
  const result = writeSettings(file, record);
  if (result.outcome === "refused") return refusal(result.reason);
  if (result.outcome === "unchanged")
    return `${[...output, `codex  ${path} already holds every skills hook`].join("\n")}\n`;

  output.push(...changes, ...missing.map(({ event, command }) => `codex  add ${event} ${command}`));

  if (missing.length || changes.some((line) => line.startsWith("codex  replace ")))
    output.push(`codex  ${path} (open codex, run /hooks, trust the new entries once)`);

  return `${output.join("\n")}\n`;
}
