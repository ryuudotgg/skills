import { realpathSync } from "node:fs";
import { join } from "node:path";
import { expandEntry, readRuleGroups, type Placeholder, type RuleGroup } from "../deny-set.ts";
import { confIn, lines, type DeliveryConfig, type DeliveryMode } from "../delivery.ts";
import { shellQuote } from "../shell.ts";
import { reachesCodexNames } from "./hook-table.ts";
import { object, type JsonObject } from "./json.ts";
import {
  applyRuleChanges,
  placement,
  reconcileRules,
  type Change,
  type Level,
  type Levels,
  type List,
  type RulesInput,
} from "./rules.ts";
import { readSettings, writeSettings } from "./settings-file.ts";

const managedPaths = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
];

type Terminal = { isTTY?: boolean };
export type ClaudeRulesInput = {
  root: string;
  config: DeliveryConfig;
  mode: DeliveryMode;
  home: string;
  path: string;
  current: Record<Placeholder, string>;
  env: NodeJS.ProcessEnv;
  stdin: Terminal;
  stdout: Terminal;
  managedPaths?: readonly string[];
};

export function parseLevels(
  content: string,
  groups: readonly RuleGroup[],
): { levels?: Levels; notes: string[] } {
  const notes: string[] = [];
  const values = new Map<string, string>();
  for (const line of lines(content)) {
    const match = line.match(/^(AGENT_RULES(?:_[A-Z0-9]+)*)=(.*)$/);
    if (!match) continue;

    const key = match[1]!;
    if (values.has(key)) notes.push(`${key} is set more than once, later values skipped`);
    else values.set(key, match[2]!);
  }

  const global = values.get("AGENT_RULES");
  if (global === undefined) {
    if (values.size) notes.push("AGENT_RULES is unset, group overrides skipped");
    return { notes };
  }

  if (global !== "deny" && global !== "ask" && global !== "off") {
    notes.push(`AGENT_RULES=${global} is not deny, ask or off, skipped`);
    return { notes };
  }

  const overrides: Record<string, Level> = {};
  for (const [key, value] of values) {
    if (key === "AGENT_RULES") continue;

    const id = key.slice("AGENT_RULES_".length).toLowerCase().replaceAll("_", "-");
    const group = groups.find((group) => group.id === id);
    if (!group || group.kind === "retired") {
      notes.push(`${key} names ${group ? "a retired" : "an unknown"} group, skipped`);
      continue;
    }

    const accepted = group.kind === "allow" ? ["allow", "off"] : ["deny", "ask", "off"];
    if (!accepted.includes(value)) {
      notes.push(
        `${key}=${value} is not ${accepted.join(", ").replace(/, ([^,]+)$/, " or $1")}, skipped`,
      );

      continue;
    }

    overrides[id] = value as Level;
  }

  return { levels: { global, groups: overrides }, notes };
}

function managedWith(paths: readonly string[], flags: readonly string[]): string[] {
  return paths.filter((path) => {
    try {
      const file = readSettings(path);
      return !("refused" in file) && flags.some((flag) => file.data[flag] === true);
    } catch {
      return false;
    }
  });
}

export function managedRulesOnly(paths: readonly string[] = managedPaths): string[] {
  return managedWith(paths, ["allowManagedPermissionRulesOnly"]);
}

export function commitGuardWired(
  data: JsonObject,
  home: string,
  cli: string,
  paths: readonly string[] = managedPaths,
): boolean {
  try {
    if (
      data.disableAllHooks === true ||
      managedWith(paths, ["allowManagedHooksOnly", "disableAllHooks"]).length
    )
      return false;

    const groups = object(data.hooks)?.PreToolUse;
    if (!Array.isArray(groups)) return false;

    return groups.some((row) => {
      const group = object(row);
      if (!group || !Array.isArray(group.hooks)) return false;

      const matcher = group.matcher;
      const reachesBash =
        typeof matcher === "string" && /^[A-Za-z0-9_|]+$/.test(matcher)
          ? matcher.split("|").includes("Bash")
          : reachesCodexNames(matcher, ["Bash"]);

      if (!reachesBash) return false;

      return group.hooks.some((hook) => {
        const entry = object(hook);
        if (
          entry?.type !== "command" ||
          entry.async === true ||
          Object.hasOwn(entry, "if") ||
          typeof entry.command !== "string"
        )
          return false;

        const command = entry.command;
        const suffix = " hook pre-tool-use";
        if (!command.endsWith(suffix)) return false;

        let path = command.slice(0, -suffix.length);
        if (path.startsWith("'") && path.endsWith("'")) {
          const unquoted = path.slice(1, -1).replaceAll("'\\''", "'");
          if (shellQuote(unquoted) !== path) return false;
          path = unquoted;
        } else if (!/^[A-Za-z0-9_@%+=:,./~-]+$/.test(path)) return false;
        else if (path.startsWith("~/")) path = join(home, path.slice(2));

        if (!path.startsWith("/")) return false;

        try {
          return realpathSync(path) === realpathSync(cli);
        } catch {
          return false;
        }
      });
    });
  } catch {
    return false;
  }
}

export function terminalFailures(
  env: NodeJS.ProcessEnv,
  stdin: Terminal,
  stdout: Terminal,
): string[] {
  return [
    ...(!stdin.isTTY ? ["stdin is not a terminal"] : []),
    ...(!stdout.isTTY ? ["stdout is not a terminal"] : []),
    ...(env.CI !== undefined ? ["CI is set"] : []),
  ];
}

export function groupSummaries(changes: readonly Change[]): { group: string; summary: string }[] {
  const groups = new Map<string, Map<string, number>>();
  for (const change of changes) {
    const from = change.from.filter((list) => list !== change.to);
    const rewrite = change.from.length === 1 && change.from[0] === change.to;
    const phrase =
      change.to === "absent"
        ? `remove N from ${from.join("/")}`
        : !from.length
          ? `${rewrite ? "rewrite N in" : "add N to"} ${change.to}`
          : `move N from ${from.join("/")} to ${change.to}`;

    const counts = groups.get(change.group) ?? new Map<string, number>();
    counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    groups.set(change.group, counts);
  }

  return [...groups].map(([group, counts]) => ({
    group,
    summary: [...counts].map(([phrase, count]) => phrase.replace(" N ", ` ${count} `)).join(", "),
  }));
}

export function fallbackSet(input: RulesInput, path: string, reason: string): string[] {
  const result = reconcileRules({ ...input, settings: {} });
  const entries: Record<List, string[]> = { deny: [], ask: [], allow: [] };
  if ("refused" in result) {
    for (const group of input.groups) {
      const { level, target } = placement(group, input);
      if (level !== "off" && target !== "absent")
        entries[target].push(
          ...group.entries.flatMap((entry) => expandEntry(entry, input.current, input.home)),
        );
    }
  } else
    for (const change of result.changes)
      if (change.to !== "absent") entries[change.to].push(change.text);

  const blocks = (["deny", "ask", "allow"] as const)
    .filter((list) => entries[list].length)
    .map(
      (list) =>
        `"${list}": [\n${entries[list].map((entry) => `  ${JSON.stringify(entry)}`).join(",\n")}\n]`,
    );

  return blocks.length
    ? [
        `Rule set for ${input.mode} mode, not written (${reason}). Add it to permissions in ${path} yourself:`,
        blocks.join(",\n"),
      ]
    : [];
}

export function applyClaudeRules(input: ClaudeRulesInput): string[] {
  const groups = readRuleGroups(input.root);
  const parsed = parseLevels(input.config.content, groups);
  const conf = input.config.path || input.current.conf;
  const notes = parsed.notes.map((note) => `note   ${conf}: ${note}`);

  const paths = input.managedPaths ?? managedPaths;
  const warnings = managedRulesOnly(paths).map(
    (path) =>
      `warn   ${path} (allowManagedPermissionRulesOnly is true, user permission rules do not apply)`,
  );

  const file = readSettings(input.path);
  const rules: RulesInput = {
    groups,
    mode: input.mode,
    levels: (!input.config.invalid && parsed.levels) || { global: "deny", groups: {} },
    guard:
      !("refused" in file) &&
      commitGuardWired(file.data, input.home, join(input.root, "playbook/bin/skills"), paths),
    settings: "refused" in file ? {} : file.data,
    home: input.home,
    current: input.current,
    defaults: {
      claude: join(input.home, ".claude"),
      agents: join(input.home, ".agents/skills"),
      conf: confIn(input.home),
      codex: join(input.home, ".codex"),
      checkout: input.current.checkout,
    },
  };

  const fallback = (reason: string, shown = notes): string[] => {
    const set = fallbackSet(rules, input.path, reason);
    return [...warnings, ...(set.length ? set : [`note   ${reason}`]), ...shown];
  };

  if (input.config.invalid) return fallback(`${conf} is invalid`);
  if (!parsed.levels)
    return fallback(
      `${conf}: ${parsed.notes.at(-1) ?? "AGENT_RULES is unset"}`,
      notes.slice(0, -1),
    );

  if ("refused" in file) return fallback(`${input.path}: ${file.refused}`);

  const result = reconcileRules(rules);
  if ("refused" in result) return fallback(`${input.path}: ${result.refused}`);

  const applied = result.changes.filter((change) => change.class !== "weakening");
  const left = result.changes.filter((change) => change.class === "weakening");
  applyRuleChanges(file.data, applied);
  const written = writeSettings(file, file.data);
  if (written.outcome === "refused") return fallback(`${input.path}: ${written.reason}`);

  const condition =
    terminalFailures(input.env, input.stdin, input.stdout).join(" and ") || "not confirmed";

  return [
    ...warnings,
    ...groupSummaries(applied).map(({ group, summary }) => `rules  ${group} ${summary}`),
    ...groupSummaries(left).map(
      ({ group, summary }) =>
        `left   ${group} ${summary} (weakening, ${condition}; edit ${input.path} by hand to apply it)`,
    ),
    ...result.notes.map((note) =>
      note.kind === "dead-allow"
        ? `note   allow ${note.text} never applies, ${note.guardrail} from ${note.group} matches first`
        : `note   ${note.list} ${note.text} blocks ${note.needs}, which ${input.mode} mode needs${note.off ? ` (group ${note.off} is off)` : ""}`,
    ),
    ...notes,
  ];
}
