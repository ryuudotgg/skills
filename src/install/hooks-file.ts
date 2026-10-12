import { basename, join } from "node:path";
import {
  commandFor,
  failsClosedWithoutBun,
  hookTable,
  reachesCodexNames,
  retired,
  type HookEvent,
  type HookRow,
  type HookTarget,
} from "./hook-table.ts";
import { object, stringifyJson, type Json, type JsonObject } from "./json.ts";

export type HookHost = {
  label: "claude" | "codex";
  names(row: HookRow): readonly string[];
  reaches(matcher: unknown, names: readonly string[]): boolean;
  matcher(row: HookRow): string | undefined;
  command(target: HookTarget): string;
  isCommand(text: string, target: HookTarget): boolean;
  retiredCommands(name: string): readonly string[];
};

export type MissingEntry = { event: HookEvent; matcher: string | undefined; command: string };
export type OwnedEntry = {
  event: HookEvent;
  target: HookTarget;
  group: JsonObject;
  entry: JsonObject;
  old: string;
};

export type HookChange =
  | { kind: "add"; target: HookTarget; event: HookEvent; command: string }
  | { kind: "replace"; target: HookTarget; event: HookEvent; old: string; command: string }
  | { kind: "drop"; target: HookTarget; event: HookEvent; old: string; why?: string };

export type HookOptions = {
  noCli?: boolean;
  noBun?: boolean;
  personal?: readonly string[];
  declined?: readonly HookTarget[];
};

export function codexHost(hooksDir: string, agentsDir: string): HookHost {
  return {
    label: "codex",
    names: (row) => row.codexNames,
    reaches: reachesCodexNames,
    matcher: (row) => row.matcher?.codex,
    command: (target) => commandFor(target, agentsDir),
    isCommand: (text, target) => text === commandFor(target, agentsDir),
    retiredCommands: (name) => [join(hooksDir, name)],
  };
}

function groups(data: Json, event: HookEvent): Json[] {
  const rows = object(object(data)?.hooks)?.[event];
  return Array.isArray(rows) ? rows : [];
}

export function ownedEntries(
  data: Json,
  host: HookHost,
  personal: readonly string[],
): OwnedEntry[] {
  const result: OwnedEntry[] = [];
  for (const { event, target } of hookTable) {
    const commands = new Set(
      retired
        .filter(([name, current]) => current === target && !personal.includes(name))
        .flatMap(([name]) => host.retiredCommands(name)),
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
  host: HookHost,
  unwired: ReadonlySet<HookTarget> = new Set(),
): MissingEntry[] {
  return hookTable
    .filter(
      (row) =>
        !unwired.has(row.target) &&
        !groups(data, row.event).some((value) => {
          const group = object(value);
          const entries = group?.hooks;
          return (
            group !== undefined &&
            host.reaches(group.matcher, host.names(row)) &&
            Array.isArray(entries) &&
            entries.some((entry) => {
              const command = object(entry)?.command;
              return typeof command === "string" && host.isCommand(command, row.target);
            })
          );
        }),
    )
    .map((row) => ({
      event: row.event,
      matcher: host.matcher(row),
      command: host.command(row.target),
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
  host: HookHost,
  unwired: ReadonlySet<HookTarget>,
): HookChange[] {
  const changes: HookChange[] = [];
  for (const row of hookTable) {
    const { event, target } = row;
    if (unwired.has(target)) continue;

    const names = host.names(row);
    for (const value of groups(data, event).slice()) {
      const group = object(value);
      if (!group || !Array.isArray(group.hooks) || host.reaches(group.matcher, names)) continue;

      for (const hook of group.hooks.slice()) {
        const entry = object(hook);
        const old = entry?.command;
        if (!entry || typeof old !== "string" || !host.isCommand(old, target)) continue;

        dropEntry(data, event, group, entry);
        changes.push({
          kind: "drop",
          target,
          event,
          old,
          why: `matcher ${typeof group.matcher === "string" ? group.matcher : stringifyJson(group.matcher!)} misses ${names.join(", ")}`,
        });
      }
    }
  }

  return changes;
}

function replaceRetired(
  data: JsonObject,
  owned: readonly OwnedEntry[],
  host: HookHost,
): HookChange[] {
  const absent = new Set(missingEntries(data, host).map(({ event }) => event));
  const changes: HookChange[] = [];
  for (const { event, target, group, entry, old } of owned) {
    const command = host.command(target);
    const names = host.names(hookTable.find((row) => row.target === target)!);
    if (absent.has(event) && host.reaches(group.matcher, names)) {
      entry.command = command;
      absent.delete(event);
      changes.push({ kind: "replace", event, target, old, command });
    } else {
      dropEntry(data, event, group, entry);
      changes.push({ kind: "drop", event, target, old });
    }
  }

  return changes;
}

export function hookChangeLine(change: HookChange, label: HookHost["label"]): string {
  const prefix = `${label.padEnd(6)} ${change.kind} ${change.event}`;
  if (change.kind === "add") return `${prefix} ${change.command}`;
  if (change.kind === "replace") return `${prefix} ${change.old} with ${change.command}`;
  return `${prefix} ${change.old}${change.why ? ` (${change.why})` : ""}`;
}

export function reconcileHooks(
  data: JsonObject,
  host: HookHost,
  path: string,
  options: HookOptions = {},
) {
  const output: string[] = [];
  const name = host.label === "claude" ? "Claude" : "Codex";
  const unwired = new Set(options.declined);
  for (const { target } of hookTable)
    if (options.noCli) {
      unwired.add(target);
      output.push(
        `skip   ${target} ${name} entry (the repo's ${target} is not what runs, so none is added)`,
      );
    } else if (options.noBun && !failsClosedWithoutBun.has(target)) {
      unwired.add(target);
      output.push(`skip   ${target} ${name} entry (Bun is missing, so none is added)`);
    }

  if (options.noBun && !options.noCli)
    for (const target of failsClosedWithoutBun)
      if (!unwired.has(target))
        output.push(
          `${host.label.padEnd(6)} Bun is missing, so ${target} denies every ${name} shell command until Bun is installed`,
        );

  const personalTargets = new Map<HookTarget, string>();
  for (const { target, old } of ownedEntries(data, host, []))
    if (options.personal?.includes(basename(old))) personalTargets.set(target, old);

  for (const [target, old] of personalTargets) {
    unwired.add(target);
    output.push(
      `skip   ${target} ${name} entry (${path} already runs ${old}, which this repo did not install)`,
    );
  }

  const owned = ownedEntries(data, host, options.personal ?? []).filter(
    ({ target }) => !unwired.has(target),
  );

  const wanted = missingEntries(data, host, unwired);
  const hooks = object(data.hooks);
  const refusal = (reason: string) => ({
    kind: "refused" as const,
    reason,
    output,
    wanted,
    owned,
    changes: [] as HookChange[],
  });

  if (Object.hasOwn(data, "hooks") && !hooks) return refusal("hooks is not an object");

  for (const { event } of wanted)
    if (hooks && Object.hasOwn(hooks, event) && !Array.isArray(hooks[event]))
      return refusal(`${event} is not a list`);

  const changes = [...dropUnreachable(data, host, unwired), ...replaceRetired(data, owned, host)];
  const missing = missingEntries(data, host, unwired);
  if (missing.length) addEntries(data, missing);

  changes.push(
    ...missing.map(({ event, command }): HookChange => ({
      kind: "add",
      event,
      target: hookTable.find((row) => row.event === event)!.target,
      command,
    })),
  );

  return { kind: "plan" as const, output, wanted, owned, changes };
}
