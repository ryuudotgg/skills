import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonical,
  expandEntry,
  readRuleGroups,
  type Placeholder,
  type RuleGroup,
} from "../deny-set.ts";
import type { DeliveryConfig, DeliveryMode } from "../delivery.ts";
import { commitGuardWired, parseLevels, terminalFailures } from "./claude-rules.ts";
import { placement, type ChangeClass, type Levels } from "./rules.ts";
import {
  osReason,
  readSettings,
  readTarget,
  writeTarget,
  type TargetFile,
} from "./settings-file.ts";

export const rulesHeader = "# Written by skills install. Edits are replaced on the next run.";
export const handEdits = "hand edits";

type Decision = "forbidden" | "prompt";
type State = Decision | "absent";
type Pattern = string[][];

type Rule = { pattern: Pattern; decision: Decision };
type Block = { id: string; label: string; rules: Rule[]; lines: string[] };
type Slot = { fresh?: Block; old?: Block; change?: CodexChange };

export type CodexChange = {
  group: string;
  from: State;
  to: State;
  class: ChangeClass;
  lines: string[];
  was: string[];
};

type Terminal = { isTTY?: boolean };
export type CodexRulesInput = {
  root: string;
  config: DeliveryConfig;
  mode: DeliveryMode;
  home: string;
  codex: string;
  agents: string;
  current: Record<Placeholder, string>;
  env: NodeJS.ProcessEnv;
  stdin: Terminal;
  stdout: Terminal;
  noCli?: boolean;
  hooksPending?: boolean;
};

const strength: Record<State, number> = { forbidden: 2, prompt: 1, absent: 0 };
const ruleLine =
  /^prefix_rule\(pattern = (\[.*\]), decision = "(forbidden|prompt)", justification = "(?:[^"\\]|\\.)*"\)$/;

function prefixTokens(entry: string): string[] | undefined {
  const prefix = canonical(entry).match(/^Bash\(([^*]+) \*\)$/)?.[1];
  return prefix?.split(" ");
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((token) => right.includes(token));
}

function mergeOnce(patterns: Pattern[]): boolean {
  for (const [index, left] of patterns.entries())
    for (const [offset, right] of patterns.slice(index + 1).entries()) {
      if (left.length !== right.length) continue;

      const differing = left.flatMap((tokens, position) =>
        sameSet(tokens, right[position]!) ? [] : [position],
      );

      if (differing.length !== 1) continue;

      const position = differing[0]!;
      left[position] = [...new Set([...left[position]!, ...right[position]!])];
      patterns.splice(index + offset + 1, 1);
      return true;
    }

  return false;
}

export function prefixPatterns(
  group: RuleGroup,
  values: Record<Placeholder, string>,
  home: string,
): { patterns: Pattern[]; skipped: string[] } {
  const patterns: Pattern[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const entry of group.entries) {
    const tokens = prefixTokens(entry);
    if (!tokens) {
      skipped.push(entry);
      continue;
    }

    const spellings = tokens.map((token) =>
      expandEntry(`Bash(${token})`, values, home).map((text) => text.slice(5, -1)),
    );

    const count = Math.max(...spellings.map((options) => options.length));
    for (let index = 0; index < count; index++) {
      const pattern = spellings.map((options) => [options[Math.min(index, options.length - 1)]!]);
      const key = JSON.stringify(pattern);
      if (seen.has(key)) continue;

      seen.add(key);
      patterns.push(pattern);
    }
  }

  while (mergeOnce(patterns));

  return { patterns, skipped };
}

function renderRule({ pattern, decision }: Rule, label: string): string {
  const elements = pattern.map((tokens) =>
    tokens.length === 1
      ? JSON.stringify(tokens[0])
      : `[${tokens.map((token) => JSON.stringify(token)).join(", ")}]`,
  );

  return `prefix_rule(pattern = [${elements.join(", ")}], decision = "${decision}", justification = ${JSON.stringify(label)})`;
}

function parseRule(line: string): Rule | undefined {
  const match = line.match(ruleLine);
  if (!match) return;

  try {
    const value: unknown = JSON.parse(match[1]!);
    if (!Array.isArray(value) || !value.length) return;

    const pattern = value.map((element: unknown) => (Array.isArray(element) ? element : [element]));
    if (
      !pattern.every(
        (tokens) => tokens.length && tokens.every((token) => typeof token === "string"),
      )
    )
      return;

    return { pattern: pattern as Pattern, decision: match[2] as Decision };
  } catch {
    return;
  }
}

function parseRules(text: string): { blocks: Block[]; edits: string[] } {
  const blocks: Block[] = [];
  const edits: string[] = [];
  for (const line of text.split("\n").slice(1)) {
    if (!line) continue;

    const opening = line.match(/^# ([a-z0-9]+(?:-[a-z0-9]+)*): (.+)$/);
    const rule = parseRule(line);
    const block = blocks.at(-1);
    const repeated = opening && blocks.find(({ id }) => id === opening[1]);
    if (repeated) blocks.push(blocks.splice(blocks.indexOf(repeated), 1)[0]!);
    else if (opening) blocks.push({ id: opening[1]!, label: opening[2]!, rules: [], lines: [] });
    else if (rule && block) {
      block.rules.push(rule);
      block.lines.push(line);
    } else edits.push(line);
  }

  return { blocks, edits };
}

function renderFile(edits: readonly string[], blocks: readonly Block[]): string {
  return [
    rulesHeader,
    ...(edits.length ? [edits.join("\n")] : []),
    ...blocks
      .filter((block) => block.lines.length)
      .map((block) => `\n# ${block.id}: ${block.label}\n${block.lines.join("\n")}`),
    "",
  ].join("\n");
}

function stateOf(rules: readonly Rule[]): State {
  return rules.reduce<State>(
    (state, { decision }) => (strength[decision] > strength[state] ? decision : state),
    "absent",
  );
}

function prefixes(pattern: Pattern): string[][] {
  return pattern.reduce<string[][]>(
    (heads, tokens) => heads.flatMap((head) => tokens.map((token) => [...head, token])),
    [[]],
  );
}

function covered(rule: Rule, by: readonly Rule[]): boolean {
  return prefixes(rule.pattern).every((prefix) =>
    by.some(
      (other) =>
        strength[other.decision] >= strength[rule.decision] &&
        other.pattern.length <= prefix.length &&
        other.pattern.every((tokens, position) => tokens.includes(prefix[position]!)),
    ),
  );
}

function classify(from: readonly Rule[], to: readonly Rule[]): ChangeClass {
  if (!from.every((rule) => covered(rule, to))) return "weakening";
  return to.every((rule) => covered(rule, from)) ? "neutral" : "strengthening";
}

function emptyTarget(path: string): TargetFile {
  return { path, real: resolve(path), stats: undefined, text: undefined, bytes: undefined };
}

export function planCodexRules(input: CodexRulesInput & { levels?: Levels; release?: boolean }) {
  const path = join(input.codex, "rules/skills.rules");
  const skip = (reason: string) => ({ kind: "skip" as const, path, reason });

  const groups = readRuleGroups(input.root);
  if (input.config.invalid) return skip(`${input.config.path} is invalid`);

  const levels = input.levels ?? parseLevels(input.config.content, groups).levels;
  if (!levels) return { kind: "unmanaged" as const, path };

  let file: ReturnType<typeof readTarget>;
  try {
    file = lstatSync(join(input.codex, "rules"), { throwIfNoEntry: false })
      ? readTarget(path)
      : emptyTarget(path);
  } catch (error) {
    return skip(`cannot read its directory: ${osReason(error)}`);
  }

  if ("refused" in file) return skip(file.refused);
  if (file.text !== undefined && file.text.split("\n")[0] !== rulesHeader)
    return skip(`its first line is not "${rulesHeader}", so skills does not own it`);

  const parsed = parseRules(file.text ?? "");
  const hooks = readSettings(join(input.codex, "hooks.json"));
  const guard =
    !input.noCli &&
    !("refused" in hooks) &&
    (!!input.hooksPending ||
      commitGuardWired(
        hooks.data,
        input.home,
        join(input.root, "playbook/bin/skills"),
        [],
        join(input.agents, "playbook/bin/skills"),
      ));

  const options = { mode: input.mode, levels, guard, release: input.release };
  const managed = input.release || levels.global !== "off";
  const slots: Slot[] = [];
  const skipped: { group: string; entries: string[] }[] = [];
  const blocking: { group: string; state: State }[] = [];
  for (const group of groups) {
    if (group.kind !== "deny") continue;

    const old = parsed.blocks.find((block) => block.id === group.id);
    const { level, cell, target } = placement(group, options);
    if (level === "off") {
      if (old?.rules.length && (cell === "absent" || cell === "allow"))
        blocking.push({ group: group.id, state: stateOf(old.rules) });

      slots.push({ fresh: old });
      continue;
    }

    const decision: Decision | undefined =
      target === "deny" ? "forbidden" : target === "ask" ? "prompt" : undefined;

    const { patterns, skipped: entries } = prefixPatterns(group, input.current, input.home);
    if (decision && entries.length) skipped.push({ group: group.id, entries });

    const rules = decision ? patterns.map((pattern) => ({ pattern, decision })) : [];
    const lines = rules.map((rule) => renderRule(rule, group.label));
    if (isDeepStrictEqual(old?.lines ?? [], lines)) {
      slots.push({ fresh: old });
      continue;
    }

    const fresh: Block = { id: group.id, label: group.label, rules, lines };
    const change: CodexChange = {
      group: group.id,
      from: stateOf(old?.rules ?? []),
      to: stateOf(rules),
      class: classify(old?.rules ?? [], rules),
      lines,
      was: old?.lines ?? [],
    };

    slots.push({ fresh, old, change });
  }

  for (const block of parsed.blocks) {
    const group = groups.find(({ id }) => id === block.id);
    if (group?.kind === "deny") continue;

    if (!managed) {
      slots.push({ fresh: block });
      continue;
    }

    slots.push({
      old: block,
      change: {
        group: block.id,
        from: stateOf(block.rules),
        to: "absent",
        class: classify(block.rules, []),
        lines: [],
        was: block.lines,
      },
    });
  }

  const edits: CodexChange | undefined =
    parsed.edits.length && managed
      ? {
          group: handEdits,
          from: "absent",
          to: "absent",
          class: parsed.edits.some((line) => /prefix_rule/.test(line)) ? "weakening" : "neutral",
          lines: [],
          was: parsed.edits,
        }
      : undefined;

  return {
    kind: "plan" as const,
    path,
    file,
    slots,
    edits,
    changes: [...slots.flatMap((slot) => slot.change ?? []), ...(edits ? [edits] : [])],
    skipped,
    blocking,
    keptEdits: managed ? [] : parsed.edits,
  };
}

function describe(change: CodexChange): string {
  if (change.group === handEdits) return "remove";
  if (change.from === "absent") return `add ${change.to}`;
  if (change.to === "absent") return `remove ${change.from}`;
  if (change.from === change.to) return `rewrite ${change.to}`;
  return `${change.from} to ${change.to}`;
}

export function codexSummaries(
  changes: readonly CodexChange[],
): { change: CodexChange; summary: string }[] {
  return changes.map((change) => ({ change, summary: describe(change) }));
}

function verify(binary: string, content: string, probe: Rule | undefined): string | undefined {
  const directory = mkdtempSync(join(tmpdir(), "skills-rules-"));
  try {
    const path = join(directory, "skills.rules");
    writeFileSync(path, content);

    const check = (tokens: string[]) => {
      const result = Bun.spawnSync(
        [binary, "execpolicy", "check", "--rules", path, "--", ...tokens],
        { stdout: "pipe", stderr: "pipe", timeout: 10_000 },
      );

      if (result.exitCode === null) return { failed: "did not finish within 10 s" };
      if (result.exitCode !== 0) {
        const error = result.stderr.toString().trim().split("\n")[0];
        return { failed: error || `exited ${result.exitCode}` };
      }

      try {
        return JSON.parse(result.stdout.toString()) as { matchedRules?: unknown[] };
      } catch {
        return { failed: "printed no JSON" };
      }
    };

    if (probe) {
      const tokens = probe.pattern.map((alternatives) => alternatives[0]!);
      const result = check(tokens);
      if ("failed" in result) return `failed: ${result.failed}`;

      const expected = { prefixRuleMatch: { matchedPrefix: tokens, decision: probe.decision } };
      const matched = (result.matchedRules ?? []).some((rule) => {
        const match = (rule as { prefixRuleMatch?: Record<string, unknown> }).prefixRuleMatch;
        return isDeepStrictEqual(
          { matchedPrefix: match?.matchedPrefix, decision: match?.decision },
          expected.prefixRuleMatch,
        );
      });

      if (!matched) return `found no ${probe.decision} match for ${tokens.join(" ")}`;
    }

    const control = check(["git", "status"]);
    if ("failed" in control) return `failed: ${control.failed}`;
    if (control.matchedRules?.length) return "matched git status";

    return;
  } catch (error) {
    return `failed: ${osReason(error)}`;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function applyCodexRules(
  input: CodexRulesInput & { levels?: Levels; release?: boolean; confirmed?: CodexChange[] },
): string[] {
  const plan = planCodexRules(input);
  if (plan.kind === "unmanaged") return [];
  if (plan.kind === "skip") return [`skip   ${plan.path} (${plan.reason})`];

  const failures = terminalFailures(input.env, input.stdin, input.stdout);
  const applies = (change: CodexChange) =>
    change.class !== "weakening" ||
    (!failures.length && (input.confirmed ?? []).some((shown) => isDeepStrictEqual(shown, change)));

  const blocks = plan.slots.flatMap(
    ({ fresh, old, change }) => (change && !applies(change) ? old : fresh) ?? [],
  );

  const edits = plan.edits && !applies(plan.edits) ? plan.edits.was : plan.keptEdits;
  const content = renderFile(edits, blocks);
  const applied = plan.changes.filter(applies);
  const condition =
    input.confirmed !== undefined && !failures.length
      ? "the rule plan changed after the preview"
      : failures.join(" and ") || "not confirmed";

  const notes = [
    ...plan.blocking.map(
      ({ group, state }) =>
        `note   codex ${group} is off, and its ${state} rules in ${plan.path} block what ${input.mode} mode needs`,
    ),
    ...plan.skipped.map(
      ({ group, entries }) =>
        `skip   codex ${group} ${entries.join(", ")} (no Codex prefix rule can express ${entries.length > 1 ? "these" : "this"})`,
    ),
    ...plan.changes
      .filter((change) => !applies(change))
      .map(
        (change) =>
          `left   codex ${change.group} ${describe(change)} (weakening, ${condition}; rerun ./install.sh in a terminal to apply it)`,
      ),
  ];

  const empty = !blocks.some((block) => block.lines.length) && !edits.length;
  if (plan.file.text === undefined ? empty : !applied.length || content === plan.file.text)
    return plan.file.text === undefined
      ? notes
      : [...notes, `codex  ${plan.path} already holds every skills rule`];

  const binary = Bun.which("codex", { PATH: input.env.PATH ?? "" });
  const probe = blocks.find((block) => block.rules.length)?.rules[0];
  const rejected = binary && verify(binary, content, probe);
  if (rejected)
    return [
      ...notes,
      `skip   ${plan.path} (codex execpolicy check ${rejected}, so the old file is kept)`,
    ];

  try {
    mkdirSync(join(input.codex, "rules"), { recursive: true });
  } catch (error) {
    return [...notes, `skip   ${plan.path} (cannot create its directory: ${osReason(error)})`];
  }

  const written = writeTarget(plan.file, content);
  if (written.outcome === "refused") return [...notes, `skip   ${plan.path} (${written.reason})`];

  return [
    ...notes,
    ...applied.map((change) => `codex  ${change.group} ${describe(change)}`),
    `codex  ${plan.path} (restart Codex to load the rules)`,
  ];
}
