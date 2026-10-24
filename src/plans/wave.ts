import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import { processIo, type Io } from "../io.ts";
import { checkoutIs, gitOutput } from "../project.ts";
import { read, within } from "../read.ts";
import { frontier } from "./frontier.ts";
import { indexPath, missingIndex, readIndex, type IndexRow } from "./index-tsv.ts";
import { waveSettingsFrom } from "./wave-settings.ts";

export type ShellWord = { value: string; unquotedGlob: boolean };
export type Parsed<Value> = { ok: true; value: Value } | { ok: false; reason: string };
export type WaveProbe =
  | { row: IndexRow; kind: "probed"; hits: string[] }
  | { row: IndexRow; kind: "unprobed"; reason: string };

export type WaveSelection = {
  launch: IndexRow[];
  held: { row: IndexRow; path: string; owner: IndexRow }[];
  unprobed: Extract<WaveProbe, { kind: "unprobed" }>[];
};

export function splitProbeWords(command: string): Parsed<ShellWord[]> {
  const words: ShellWord[] = [];

  let value = "";
  let started = false;
  let unquotedGlob = false;
  let quote = "";
  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (character === "\\" && quote !== "'") {
      const escaped = command[++index];
      if (escaped === undefined) return { ok: false, reason: "unfinished escape" };
      if (escaped === "\n") continue;

      value += quote === '"' && !'$`"\\'.includes(escaped) ? `\\${escaped}` : escaped;

      started = true;
      continue;
    }

    if (quote) {
      if (character === quote) quote = "";
      else value += character;

      continue;
    }

    if (character === "|" && command[index + 1] === "|")
      return { ok: false, reason: "unquoted shell operator ||" };

    if (character === "|" || (character === "#" && !started)) break;
    if (/[;&><`$]/.test(character))
      return { ok: false, reason: `unquoted shell operator ${character}` };

    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }

    if (/\s/.test(character)) {
      if (started) words.push({ value, unquotedGlob });
      value = "";
      started = false;
      unquotedGlob = false;
      continue;
    }

    value += character;
    started = true;
    if ("*?[".includes(character)) unquotedGlob = true;
  }

  if (quote) return { ok: false, reason: "unfinished quote" };
  if (started) words.push({ value, unquotedGlob });
  return { ok: true, value: words };
}

const booleanFlags = new Set([
  "--line-number",
  "--ignore-case",
  "--smart-case",
  "--case-sensitive",
  "--word-regexp",
  "--line-regexp",
  "--fixed-strings",
  "--pcre2",
  "--multiline",
  "--multiline-dotall",
  "--hidden",
  "--files-with-matches",
]);

const valueFlags = new Set(["--regexp", "--type", "--type-not", "--glob", "--iglob"]);
export function validateProbeCommand(
  command: string,
  top?: string,
): Parsed<{ argv: string[]; paths: string[] }> {
  const split = splitProbeWords(command);
  if (!split.ok) return split;
  if (split.value[0]?.value !== "rg") return { ok: false, reason: "not an rg command" };

  const words = split.value.slice(1);
  const positionals: ShellWord[] = [];

  let flags = true;
  let explicitPattern = false;
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (flags && word.value === "--") {
      flags = false;
      continue;
    }

    if (!flags || !word.value.startsWith("-") || word.value === "-") {
      positionals.push(word);
      continue;
    }

    const [name] = word.value.split("=", 1);
    if (booleanFlags.has(word.value)) continue;
    if (valueFlags.has(name!)) {
      if (name === "--regexp") explicitPattern = true;
      if (!word.value.includes("=") && !words[++index])
        return { ok: false, reason: `missing value for ${name}` };

      continue;
    }

    if (!word.value.startsWith("--")) {
      const cluster = word.value.slice(1);

      let valid = true;
      for (let offset = 0; offset < cluster.length; offset++) {
        const flag = cluster[offset]!;
        if ("niSswxFPUl".includes(flag)) continue;
        if ("etTg".includes(flag)) {
          if (flag === "e") explicitPattern = true;
          if (offset === cluster.length - 1 && !words[++index])
            return { ok: false, reason: `missing value for -${flag}` };

          break;
        }

        valid = false;
        break;
      }

      if (valid && cluster) continue;
    }

    return { ok: false, reason: `unsupported flag ${word.value}` };
  }

  if (!explicitPattern && positionals.length === 0)
    return { ok: false, reason: "missing rg pattern" };

  const paths = explicitPattern ? positionals : positionals.slice(1);
  for (const path of paths) {
    if (
      path.value === "-" ||
      isAbsolute(path.value) ||
      path.value.startsWith("~") ||
      path.value.split("/").includes("..")
    )
      return { ok: false, reason: `unsafe path ${path.value}` };

    if (path.unquotedGlob) return { ok: false, reason: `unquoted glob in path ${path.value}` };
    if (top && normalizePath(path.value, top) === undefined)
      return { ok: false, reason: `unsafe path ${path.value}` };
  }

  return {
    ok: true,
    value: {
      argv: [
        "rg",
        "--no-config",
        "-l",
        ...words.map((word) => word.value),
        ...(paths.length ? [] : ["."]),
      ],
      paths: paths.length ? paths.map((path) => path.value) : ["."],
    },
  };
}

export function probeCommands(markdown: string): string[] {
  const commands: string[] = [];

  let inProbe = false;
  let fenced = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (line.startsWith("## ")) {
      if (inProbe) break;
      inProbe = line.trim() === "## Probe";
      continue;
    }

    if (!inProbe) continue;
    if (/^\s*```/.test(line)) {
      fenced = !fenced;
      continue;
    }

    if ((fenced || /^ {4}/.test(line)) && /^rg(?:\s|$)/.test(line.trim()))
      commands.push(line.trim());
  }

  return commands;
}

export function selectWave(probes: readonly WaveProbe[]): WaveSelection {
  const result: WaveSelection = { launch: [], held: [], unprobed: [] };
  const owners = new Map<string, IndexRow>();
  for (const probe of probes) {
    const inFlight = probe.row.status === "DOING" || probe.row.status === "REVIEW";

    if (probe.kind === "unprobed") {
      result.unprobed.push(probe);
      continue;
    }

    if (inFlight) {
      for (const path of probe.hits) if (!owners.has(path)) owners.set(path, probe.row);
      continue;
    }

    const shared = probe.hits.find((path) => owners.has(path));
    if (shared !== undefined) {
      result.held.push({ row: probe.row, path: shared, owner: owners.get(shared)! });
      continue;
    }

    result.launch.push(probe.row);
    for (const path of probe.hits) if (!owners.has(path)) owners.set(path, probe.row);
  }

  return result;
}

function normalizePath(path: string, top: string): string | undefined {
  const absolute = resolve(top, path);
  const canonical = existsSync(absolute) ? realpathSync(absolute) : absolute;
  const normalized = relative(top, canonical);
  if (normalized === ".." || normalized.startsWith("../") || isAbsolute(normalized)) return;

  return normalized;
}

export function normalizeHits(stdout: string, top: string): string[] {
  return [
    ...new Set(
      stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .map((path) => normalizePath(path, top))
        .filter((path) => path !== undefined),
    ),
  ].sort();
}

type RipgrepCommand = { executable: string; argv0?: string };

function resolveRipgrep(env: Io["env"]): RipgrepCommand | undefined {
  const executable = Bun.which("rg", { PATH: env.PATH ?? "" });
  if (executable) return { executable };

  const fallbacks = [env.CLAUDE_CODE_EXECPATH, env.HOME && join(env.HOME, ".local/bin/claude")];
  for (const fallback of fallbacks) {
    if (!fallback || !isAbsolute(fallback)) continue;

    try {
      accessSync(fallback, constants.X_OK);
      if (!statSync(fallback).isFile()) continue;
    } catch {
      continue;
    }

    // Claude Code ships ripgrep inside its own binary, selected by argv0.
    return { executable: fallback, argv0: "rg" };
  }
}

async function probeRow(
  row: IndexRow,
  directory: string,
  top: string,
  io: Io,
  ripgrep: RipgrepCommand,
): Promise<WaveProbe> {
  const hits = new Set<string>();
  const unprobed = (reason: string): WaveProbe => ({
    row,
    kind: "unprobed",
    reason,
  });

  let markdown: string;
  try {
    markdown = readFileSync(join(directory, `${row.id}-${row.slug}.md`), "utf8");
  } catch {
    return unprobed("missing or unreadable plan file");
  }

  const commands = probeCommands(markdown);
  if (!commands.length) return unprobed("Probe has no rg command");

  for (const command of commands) {
    const parsed = validateProbeCommand(command, top);
    if (!parsed.ok) return unprobed(parsed.reason);

    const result = await read([ripgrep.executable, ...parsed.value.argv.slice(1)], {
      cwd: top,
      env: io.env,
      deadline: 30_000,
      ...(ripgrep.argv0 === undefined ? {} : { argv0: ripgrep.argv0 }),
    });

    if (!result.ok) return unprobed(`rg ${result.failure.kind}`);

    for (const path of normalizeHits(result.stdout, top)) hits.add(path);

    for (const path of parsed.value.paths) {
      const absolute = resolve(top, path);
      if (existsSync(absolute) && statSync(absolute).isFile())
        for (const hit of normalizeHits(path, top)) hits.add(hit);
    }

    if (result.code !== 0 && result.code !== 1) return unprobed(`rg exited ${result.code}`);
  }

  return { row, kind: "probed", hits: [...hits].sort() };
}

async function exportTree(top: string, ref: string, directory: string, io: Io): Promise<void> {
  const children: Pick<Bun.Subprocess, "kill" | "exited" | "exitCode" | "unref">[] = [];
  try {
    const archive = Bun.spawn(["git", "archive", "--format=tar", ref], {
      cwd: top,
      env: io.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });

    children.push(archive);
    const archiveError = new Response(archive.stderr).text();
    const extract = Bun.spawn(["tar", "-x", "-C", directory], {
      cwd: top,
      env: io.env,
      stdin: archive.stdout,
      stdout: "ignore",
      stderr: "pipe",
    });

    children.push(extract);
    const result = await within(
      Promise.all([
        archive.exited,
        extract.exited,
        archiveError,
        new Response(extract.stderr).text(),
      ]),
      60_000,
    );

    if (!result) throw new Error("export exceeded 60 s deadline");

    const [archiveCode, extractCode, archiveStderr, extractStderr] = result;
    if (archiveCode !== 0)
      throw new Error(`git archive exited ${archiveCode}: ${archiveStderr.trim()}`);

    if (extractCode !== 0) throw new Error(`tar exited ${extractCode}: ${extractStderr.trim()}`);
  } finally {
    for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
    await Promise.all(children.map((child) => child.exited));
    for (const child of children) child.unref();
  }
}

export async function waveVerb(
  args: readonly string[],
  usage: string,
  io: Io = processIo(),
): Promise<number> {
  const positionals = args.filter((arg) => arg !== "--dry-run");
  if (positionals.length !== 1 || !positionals[0] || positionals[0].startsWith("-")) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  const project = positionals[0];
  const refuse = (reason: string): number => {
    io.err(`wave: ${reason}\n`);
    return 1;
  };

  const mismatch = await checkoutIs(io.cwd, project, io);
  if (mismatch) return refuse(mismatch);

  const ripgrep = resolveRipgrep(io.env);
  if (!ripgrep) return refuse("rg is not on PATH and no Claude Code executable was found");

  let index: string;
  let rows: IndexRow[];
  try {
    index = indexPath(project, io.env);
    rows = readIndex(index);
  } catch {
    return refuse(missingIndex(project));
  }

  const toplevel = (await gitOutput(io.cwd, ["rev-parse", "--show-toplevel"], {}, io))?.trim();
  if (!toplevel) return refuse("cannot read git toplevel");

  const top = realpathSync(toplevel);

  const localDefault = (
    await gitOutput(top, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], {}, io)
  )?.trim();

  let exported: string | undefined;
  try {
    if (localDefault) {
      try {
        exported = await mkdtemp(join(tmpdir(), "plans-wave-"));
        await exportTree(top, localDefault, exported, io);
      } catch (error) {
        return refuse(`cannot export ${localDefault}: ${String(error)}`);
      }
    }

    const probeRoot = exported ? realpathSync(exported) : top;
    const settings = waveSettingsFrom(readDeliveryConfig(io.env));
    for (const note of settings.notes) io.err(`wave: ${note}\n`);

    const probes: WaveProbe[] = [];
    for (const row of rows)
      if (row.status === "DOING" || row.status === "REVIEW")
        probes.push(await probeRow(row, dirname(index), probeRoot, io, ripgrep));

    for (const { row } of frontier(rows).ready)
      probes.push(await probeRow(row, dirname(index), probeRoot, io, ripgrep));

    const selected = selectWave(probes);
    io.out(`model ${settings.model}\neffort ${settings.effort}\n`);
    for (const row of selected.launch) io.out(`launch ${row.id} ${row.slug}\n`);

    for (const { row, path, owner } of selected.held)
      io.out(`held ${row.id}: shares ${path} with ${owner.id}\n`);

    for (const { row, reason } of selected.unprobed) io.out(`unprobed ${row.id}: ${reason}\n`);
    return 0;
  } finally {
    if (exported) await rm(exported, { recursive: true, force: true });
  }
}
