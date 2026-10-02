import { join } from "node:path";
import { hooks } from "../areas/hooks.ts";
import { shellQuote } from "../shell.ts";

const events = {
  "session-start": "SessionStart",
  "pre-tool-use": "PreToolUse",
  "post-tool-use": "PostToolUse",
  stop: "Stop",
} as const;

export type HookEvent = (typeof events)[keyof typeof events];
export type HookTarget = `hook ${keyof typeof events}`;
export type HookRow = {
  event: HookEvent;
  target: HookTarget;
  matcher: { claude: string; codex: string } | undefined;
  codexNames: readonly string[];
};

const codexNames: Record<HookEvent, readonly string[]> = {
  SessionStart: ["startup", "resume", "clear", "compact"],
  PreToolUse: ["Bash"],
  PostToolUse: ["Bash", "apply_patch"],
  Stop: [],
};

export const hookTable: readonly HookRow[] = Object.entries(events).map(([name, event]) => {
  const verb = hooks.verbs.find((entry) => entry.name[1] === name);
  if (!verb) throw new Error(`missing hook verb: ${name}`);
  return {
    event,
    target: `hook ${name}` as HookTarget,
    matcher: verb.matcher,
    codexNames: codexNames[event],
  };
});

export function reachesCodexNames(matcher: unknown, names: readonly string[]): boolean {
  if (matcher === undefined || matcher === null || matcher === "" || matcher === "*")
    return true;

  if (typeof matcher !== "string") return false;

  try {
    const pattern = new RegExp(matcher);
    return names.every((name) => pattern.test(name));
  } catch {
    return false;
  }
}

export const retired: readonly (readonly [string, HookTarget])[] = [
  ["reply-guard.sh", "hook stop"],
  ["commit-guard.sh", "hook pre-tool-use"],
  ["session-brief.sh", "hook session-start"],
  ["no-em-dash.sh", "hook post-tool-use"],
  ["no-comments.sh", "hook post-tool-use"],
];

export const failsClosedWithoutBun: ReadonlySet<HookTarget> = new Set(["hook pre-tool-use"]);

function commandPath(path: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(path) ? path : shellQuote(path);
}

export function commandFor(target: HookTarget, agentsDir: string): string {
  return `${commandPath(join(agentsDir, "playbook/bin/skills"))} ${target}`;
}

export function hookBlock(agentsDir: string, host: "claude" | "codex"): string {
  const rows = hookTable.map(({ event, target, matcher }) => {
    const path = join(agentsDir, "playbook/bin/skills");
    const command =
      agentsDir === "~/.agents/skills" ? `${path} ${target}` : commandFor(target, agentsDir);

    const entry = `{ "type": "command", "command": ${JSON.stringify(command)} }`;
    const match = matcher ? `"matcher": ${JSON.stringify(matcher[host])}, ` : "";
    const body = event === "PostToolUse" ? `\n      ${entry} ]` : `${entry}]`;
    return `    "${event}": [{ ${match}"hooks": [${body} }]${event === "Stop" ? "" : ","}`;
  });

  return `{\n  "hooks": {\n${rows.join("\n")}\n  }\n}`;
}

export function claudeBlock(agentsDir: string): string {
  return hookBlock(agentsDir, "claude");
}
