import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { isDirectory, isFile } from "../io.ts";
import { prune, type history } from "./files.ts";
import { parseJson } from "./json.ts";

export type HookHomes = {
  claude: string;
  claudeConfig: string;
  claudeState: string;
  codex: string;
};

function referencesCopies(
  value: unknown,
  directories: readonly string[],
  names: readonly string[],
): boolean {
  if (Array.isArray(value))
    return value.some((entry) => referencesCopies(entry, directories, names));

  if (!value || typeof value !== "object") return false;

  for (const [key, entry] of Object.entries(value)) {
    if (key === "command" && typeof entry === "string") {
      const command = entry.replaceAll(/\/+/g, "/");
      if (names.some((name) => command.includes(name))) return true;
      if (directories.some((directory) => command.includes(directory))) return true;
    }

    if (referencesCopies(entry, directories, names)) return true;
  }

  return false;
}

export async function pruneHooks(
  repo: string,
  env: HookHomes,
  versions: Awaited<ReturnType<typeof history>>,
  output: (line: string) => void,
): Promise<void> {
  const directory = join(env.claude, "hooks");
  if (!isDirectory(directory)) return;

  const names = readdirSync(directory);
  const directories = [directory, realpathSync(directory), "/.claude/hooks"];
  const read = (path: string) =>
    parseJson(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));

  const registrations = [
    join(env.claude, "settings.json"),
    join(env.claude, "settings.local.json"),
    join(env.claudeConfig, "settings.json"),
    join(env.claudeConfig, "settings.local.json"),
    join(env.codex, "hooks.json"),
  ];

  try {
    if (lstatSync(env.claudeState, { throwIfNoEntry: false })) {
      const projects = (read(env.claudeState) as { projects?: unknown }).projects;
      if (projects !== undefined && (!projects || typeof projects !== "object")) return;

      for (const project of Object.keys(projects ?? {}))
        registrations.push(
          join(project, ".claude/settings.json"),
          join(project, ".claude/settings.local.json"),
        );
    }
  } catch {
    return;
  }

  for (const path of registrations) {
    try {
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      if (!isFile(path) || referencesCopies(read(path), directories, names)) return;
    } catch {
      return;
    }
  }

  const deleted = new Set(await versions.deleted("hooks/*"));
  for (const name of readdirSync(directory).sort()) {
    if (!deleted.has(`hooks/${name}`)) continue;

    const path = join(directory, name);
    const entry = lstatSync(path);
    const judged =
      entry.isFile() && !existsSync(join(repo, "hooks", name))
        ? await versions.shipped(`hooks/${name}`, path)
        : undefined;

    if (judged) prune(name, path, judged, output);
    else if (entry.isSymbolicLink()) output(`skip   ${name} (${path} is a link, left in place)`);
    else output(`skip   ${name} (${path} ${versions.unmatched}, left in place)`);
  }
}
