import {
  accessSync,
  chownSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  commandFor,
  failsClosedWithoutBun,
  hookTable,
  reachesCodexNames,
  retired,
  type HookEvent,
  type HookTarget,
} from "./hook-table.ts";
import { object, parseJson, stringifyJson, type Json, type JsonObject } from "./json.ts";

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
    for (const row of [...groups(data, event)]) {
      const group = object(row);
      if (!group || !Array.isArray(group.hooks) || reachesCodexNames(group.matcher, codexNames))
        continue;

      for (const hook of [...group.hooks]) {
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

export function resolveTarget(path: string): string {
  let target = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return target;
    target = resolve(dirname(target), readlinkSync(target));
  }

  throw new Error("dangling symlink or symlink loop");
}

function accessible(path: string, flag: number, mask: number): boolean {
  try {
    accessSync(path, flag);
    return (statSync(path).mode & mask) !== 0;
  } catch {
    return false;
  }
}

export class MetadataCopyError extends Error {
  constructor(source: string, path: string, reason: string) {
    super(`cannot copy metadata from ${source} to ${path}: ${reason}`);
    this.name = "MetadataCopyError";
  }
}

export function writeAtomic(
  path: string,
  content: string | Uint8Array,
  mode: number,
  metadataSource = path,
): void {
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}`);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    closeSync(descriptor);
    descriptor = undefined;

    if (existsSync(metadataSource)) {
      const copy = Bun.which("cp", { PATH: process.env.PATH });
      try {
        if (copy) {
          const result = Bun.spawnSync(
            process.platform === "linux"
              ? [copy, "--preserve=mode,ownership,timestamps,xattr", metadataSource, temporary]
              : [copy, "-p", metadataSource, temporary],
            {
              stdout: "ignore",
              stderr: "ignore",
            },
          );

          if (result.exitCode !== 0)
            throw new MetadataCopyError(metadataSource, path, `cp exited ${result.exitCode}`);
        } else copyFileSync(metadataSource, temporary);
      } catch (error) {
        if (error instanceof MetadataCopyError) throw error;
        throw new MetadataCopyError(metadataSource, path, osReason(error));
      }

      chmodSync(temporary, 0o600);

      try {
        chownSync(temporary, -1, statSync(metadataSource).gid);
      } catch {}
    }

    descriptor = openSync(temporary, "w");
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    chmodSync(temporary, mode);
    renameSync(temporary, path);

    try {
      descriptor = openSync(dirname(path), "r");
      fsyncSync(descriptor);
    } catch {}
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

function osReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const reasons: Record<string, string> = {
    EACCES: "Permission denied",
    EPERM: "Operation not permitted",
    ENOENT: "No such file or directory",
    ENOSPC: "No space left on device",
    EROFS: "Read-only file system",
    ELOOP: "Too many levels of symbolic links",
  };

  return (code && reasons[code]) || (error instanceof Error ? error.message : String(error));
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

  let real: string;
  try {
    real = resolveTarget(path);
  } catch {
    return skip("dangling symlink or symlink loop");
  }

  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(path))
    return skip("dangling symlink or symlink loop");

  const stats = existsSync(real) ? statSync(real) : undefined;
  if (stats?.isDirectory()) return skip("is a directory");

  const directory = dirname(real);
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return skip("parent directory does not exist");

  if (stats) {
    if (!stats.isFile()) return skip("is not a regular file");
    if (!accessible(real, constants.R_OK, 0o444)) return skip("is not readable");

    let bytes: Buffer;
    try {
      bytes = readFileSync(real);
    } catch (error) {
      return skip(`cannot read: ${osReason(error)}`);
    }

    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return skip("is not UTF-8");
    }

    try {
      data = parseJson(content);
    } catch (error) {
      return skip(error instanceof Error ? error.message : String(error));
    }
  }

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
  const record = object(data);
  if (!record) return skip("top level is not an object");

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

  if (stats && !accessible(real, constants.W_OK, 0o222)) return refusal("is not writable");
  if (stats && stats.uid !== process.geteuid?.()) return refusal("is owned by another user");
  if (stats && stats.nlink > 1) return refusal("has hard links a rewrite would split");
  if (!accessible(directory, constants.W_OK, 0o222))
    return refusal("parent directory is not writable");

  addEntries(record, missing);
  const content = `${stringifyJson(record)}\n`;
  if (/[\uD800-\uDFFF]/u.test(content)) return refusal("cannot encode as UTF-8");

  try {
    writeAtomic(real, content, stats ? stats.mode & 0o7777 : 0o666 & ~process.umask());
  } catch (error) {
    if (error instanceof MetadataCopyError) throw error;
    return refusal(`cannot write: ${osReason(error)}`);
  }

  output.push(...changes, ...missing.map(({ event, command }) => `codex  add ${event} ${command}`));

  if (missing.length || changes.some((line) => line.startsWith("codex  replace ")))
    output.push(`codex  ${path} (open codex, run /hooks, trust the new entries once)`);

  return `${output.join("\n")}\n`;
}
