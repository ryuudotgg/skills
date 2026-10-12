import { isAbsolute, join, relative, sep } from "node:path";
import { lines } from "../delivery.ts";
import {
  claudeBlock,
  agentsSpelling,
  commandFor,
  hookOverrideKey,
  hookTable,
  reachesClaudeNames,
  retired,
  type HookTarget,
} from "./hook-table.ts";
import {
  hookChangeLine,
  reconcileHooks,
  type HookChange,
  type HookHost,
  type HookOptions,
  type MissingEntry,
} from "./hooks-file.ts";
import { object, type JsonObject } from "./json.ts";

export type ClaudeHooksInput = HookOptions & { home: string; agents: string; hooksDir: string };

export function declinedHooks(content: string): { declined: HookTarget[]; notes: string[] } {
  const values = new Set<string>();
  const declined: HookTarget[] = [];
  const notes: string[] = [];
  for (const line of lines(content)) {
    const match = line.match(/^(CLAUDE_HOOK_[^=]*)=(.*)$/);
    if (!match) continue;

    const key = match[1]!;
    if (values.has(key)) {
      notes.push(`${key} is set more than once, later values skipped`);
      continue;
    }

    values.add(key);
    const row = hookTable.find(({ target }) => hookOverrideKey(target) === key);
    if (!row) notes.push(`${key} names an unknown target, skipped`);
    else if (match[2] !== "off") notes.push(`${key}=${match[2]} is not off, skipped`);
    else declined.push(row.target);
  }

  return {
    declined: hookTable.map(({ target }) => target).filter((target) => declined.includes(target)),
    notes,
  };
}

export function claudeHost(input: ClaudeHooksInput): HookHost {
  const agents = agentsSpelling(input.agents, input.home);

  const command = (target: HookTarget) =>
    agents === "~/.agents/skills"
      ? `${agents}/playbook/bin/skills ${target}`
      : commandFor(target, agents);

  const hooksRelative = relative(input.home, input.hooksDir);
  const underHome =
    hooksRelative !== ".." && !hooksRelative.startsWith(`..${sep}`) && !isAbsolute(hooksRelative);

  return {
    label: "claude",
    names: (row) => row.claudeNames,
    reaches: reachesClaudeNames,
    matcher: (row) => row.matcher?.claude,
    command,
    isCommand: (text, target) =>
      text === commandFor(target, input.agents) || text === command(target),
    retiredCommands: (name) => [
      join(input.hooksDir, name),
      ...(underHome ? [`~/${join(hooksRelative, name)}`] : []),
    ],
  };
}

export function hookSummary(change: HookChange): string {
  return `Claude ${change.target}: ${change.kind}${change.kind === "add" ? "" : ` ${change.old}`}`;
}

export function claudeHooksFallback(
  input: ClaudeHooksInput,
  path: string,
  reasons: readonly string[],
  wanted: readonly MissingEntry[],
): string[] {
  const skips = [...new Set(reasons)].map((reason) => `skip   ${path} (${reason})`);
  if (!wanted.length) return skips;

  const table = hookTable.filter(({ event }) => wanted.some((entry) => entry.event === event));
  return [
    ...skips,
    "Paste the Claude Code hooks block: https://skills.ryuu.gg/agents/claude-code",
    claudeBlock(agentsSpelling(input.agents, input.home), table),
  ];
}

export function planClaudeHooks(
  data: JsonObject | undefined,
  input: ClaudeHooksInput,
  path: string,
) {
  const host = claudeHost(input);
  const skips: string[] = [];
  const declined = [...(input.declined ?? [])];
  for (const { event, target } of hookTable) {
    const groups = object(data?.hooks)?.[event];
    if (!Array.isArray(groups)) continue;

    for (const group of groups) {
      const entries = object(group)?.hooks;
      if (!Array.isArray(entries)) continue;

      for (const entry of entries) {
        const command = object(entry)?.command;
        if (typeof command !== "string") continue;

        const name = retired.find(
          ([name, current]) => current === target && command.endsWith(`/hooks/${name}`),
        )?.[0];

        if (!name || host.retiredCommands(name).includes(command) || declined.includes(target))
          continue;

        declined.push(target);
        skips.push(
          `skip   ${target} Claude entry (${path} already runs ${command}, which this repo did not install)`,
        );
      }
    }
  }

  const applied = reconcileHooks(data ?? {}, host, path, { ...input, declined });
  const notices = [...skips, ...applied.output];
  const refusal = applied.kind === "refused" ? applied.reason : undefined;
  const result = { changes: applied.changes, notices, wanted: applied.wanted, refusal };
  if (!data) return { ...result, changes: [], output: notices };

  if (applied.kind === "refused")
    return {
      ...result,
      output: [...notices, ...claudeHooksFallback(input, path, [applied.reason], applied.wanted)],
    };

  return {
    ...result,
    output: [...notices, ...applied.changes.map((change) => hookChangeLine(change, "claude"))],
  };
}
