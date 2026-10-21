import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  canonical,
  expandEntry,
  readRuleGroups,
  type Placeholder,
  type RuleGroup,
} from "../deny-set.ts";
import { confIn, type DeliveryConfig, type DeliveryMode } from "../delivery.ts";
import { parseLevels, terminalFailures } from "./claude-rules.ts";
import { object, type Json } from "./json.ts";
import { editJsoncArrays, parseJsonc, type JsoncDocument } from "./jsonc.ts";
import { ownedFile } from "./opencode.ts";
import { placement, type ChangeClass, type Levels, type Placement } from "./rules.ts";
import {
  checkTargetWrite,
  osReason,
  readTarget,
  writeTarget,
  type TargetFile,
} from "./settings-file.ts";

export type OpenCodeKey = { action: "shell" | "edit"; resource: string };
type Effect = "allow" | "ask" | "deny";
type Rule = { action: string; resource: string; effect: Effect };
type Policy = { action: "tool.use"; resource: string; effect: "deny" };
type OwnedValue = (OpenCodeKey & { effect: "ask" | "deny" }) | Policy;

type List = "permissions" | "policies";
type Entry = {
  value: Json;
  file: number;
  index: number;
  list: List;
  rule?: Rule;
  group?: string;
  legacy?: boolean;
};
type File = { target: TargetFile; document: JsoncDocument };
type State = "absent" | "ask" | "deny";
type Slot = {
  group: RuleGroup;
  level: string;
  cell: Placement;
  keys: OpenCodeKey[];
  old: Entry[];
  rules: OwnedValue[];
};

export type OpenCodeChange = {
  group: string;
  from: State;
  to: State;
  class: ChangeClass;
  rules: OwnedValue[];
  was: { file: string; list: List; value: Json }[];
};

export type OpenCodeRulesInput = {
  root: string;
  config: DeliveryConfig;
  mode: DeliveryMode;
  home: string;
  opencode: string;
  current: Record<Placeholder, string>;
  env: NodeJS.ProcessEnv;
  stdin: { isTTY?: boolean };
  stdout: { isTTY?: boolean };
  noCli?: boolean;
  noBun?: boolean;
  hooksPending?: boolean;
};

type Input = OpenCodeRulesInput & { levels?: Levels; release?: boolean };

const lists: List[] = ["permissions", "policies"];
const strength = { allow: 0, absent: 0, ask: 1, deny: 2 };
const patterns = new Map<string, RegExp>();
export function openCodeMatch(resource: string, pattern: string): boolean {
  const cached = patterns.get(pattern);
  if (cached) return cached.test(resource.replaceAll("\\", "/"));

  let escaped = pattern
    .replaceAll("\\", "/")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  if (escaped.endsWith(" .*")) escaped = escaped.slice(0, -3) + "( .*)?";

  const compiled = new RegExp(`^${escaped}$`, process.platform === "win32" ? "si" : "s");
  patterns.set(pattern, compiled);
  return compiled.test(resource.replaceAll("\\", "/"));
}

function pathResource(resource: string, home: string): string {
  if (resource.startsWith("~/")) return join(home, resource.slice(2));
  if (resource.startsWith("$HOME/")) return join(home, resource.slice(6));
  return resource;
}

export function openCodeKeys(
  entry: string,
  values: Record<Placeholder, string>,
  home: string,
): OpenCodeKey[] {
  const shell = canonical(entry).match(/^Bash\((.*)\)$/);
  if (shell)
    return expandEntry(canonical(entry), values, home).map((text) => ({
      action: "shell",
      resource: text.slice(5, -1),
    }));

  const edit = entry.match(/^Edit\((.*)\)$/);
  if (!edit) return [];

  const resource = pathResource(
    edit[1]!.replace(/\{([^{}]+)\}/g, (_, name: Placeholder) => values[name]),
    home,
  );

  const relative =
    home && resource.startsWith(`${home}/`) ? resource.slice(home.length + 1) : undefined;

  return [...new Set([resource, ...(relative ? [relative, `*/${relative}`] : [])])].map(
    (resource) => ({ action: "edit", resource }),
  );
}

function keyOf(key: { action: string; resource: string }): string {
  return JSON.stringify([key.action, key.resource]);
}

function decode(value: Json, list: List, home: string): Rule | undefined {
  const item = object(value);
  if (
    !item ||
    typeof item.action !== "string" ||
    typeof item.resource !== "string" ||
    !["allow", "ask", "deny"].includes(String(item.effect))
  )
    return;

  if (list === "policies" && (item.action !== "tool.use" || item.effect === "ask")) return;

  const split = list === "policies" ? item.resource.indexOf(":") : -1;
  if (list === "policies" && split < 0)
    return { action: "tool.use", resource: item.resource, effect: item.effect as Effect };

  const action = list === "policies" ? item.resource.slice(0, split) : item.action;
  const resource = list === "policies" ? item.resource.slice(split + 1) : item.resource;
  return {
    action,
    resource: action === "edit" ? pathResource(resource, home) : resource,
    effect: item.effect as Effect,
  };
}

function owned(
  value: Json,
  list: List,
  rule: Rule | undefined,
  claims: Map<string, string>,
): string | undefined {
  const item = object(value);
  if (!item || !rule || Object.keys(item).length !== 3 || rule.effect === "allow") return;
  if (list === "policies" && item.effect !== "deny") return;
  return claims.get(keyOf(rule));
}

function matches(entry: Entry, probe: { action: string; resource: string }): boolean {
  const rule = entry.rule;
  if (!rule) return false;
  if (entry.list === "policies")
    return openCodeMatch(
      `${probe.action}:${probe.resource}`,
      object(entry.value)!.resource as string,
    );

  return openCodeMatch(probe.action, rule.action) && openCodeMatch(probe.resource, rule.resource);
}

function winningPolicy(
  entries: Entry[],
  probe: { action: string; resource: string },
): Entry | undefined {
  const policies = entries
    .filter((entry) => entry.list === "policies")
    .toSorted((left, right) => right.file - left.file);

  return policies.findLast((entry) => matches(entry, probe));
}

function winner(entries: Entry[], probe: { action: string; resource: string }): Entry | undefined {
  const policy = winningPolicy(entries, probe);
  if (policy?.rule?.effect === "deny") return policy;

  return (
    entries.findLast((entry) => entry.list === "permissions" && matches(entry, probe)) ?? policy
  );
}

function evaluate(entries: Entry[], probe: { action: string; resource: string }): Effect {
  return winner(entries, probe)?.rule?.effect ?? "allow";
}

function renderedEntries(
  rules: OwnedValue[],
  group: string,
  target: number,
  policyTarget: number,
  home: string,
): Entry[] {
  return rules.map((value) => {
    const list = value.action === "tool.use" ? "policies" : "permissions";
    const file = list === "policies" ? policyTarget : target;
    return { value, file, index: -1, list, rule: decode(value, list, home), group };
  });
}

function stateOf(rules: readonly { effect: Effect }[]): State {
  return rules.reduce<State>(
    (state, rule) => (strength[rule.effect] > strength[state] ? (rule.effect as State) : state),
    "absent",
  );
}

function ruleValues(keys: OpenCodeKey[], target: Placement): OwnedValue[] {
  if (target === "deny")
    return keys.map(({ action, resource }) => ({
      action: "tool.use",
      resource: `${action}:${resource}`,
      effect: "deny",
    }));

  return target === "ask" ? keys.map((key) => ({ ...key, effect: "ask" })) : [];
}

function readFiles(
  directory: string,
): { files: File[]; target: number } | { path: string; reason: string } {
  const files: File[] = [];
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const path = join(directory, name);
    try {
      const target = readTarget(path);
      if ("refused" in target) return { path, reason: target.refused };

      const document = parseJsonc(target.text ?? "{}\n");
      for (const list of lists)
        if (Object.hasOwn(document.data, list) && !Array.isArray(document.data[list]))
          return { path, reason: `${list} is not an array` };

      files.push({ target, document });
    } catch (error) {
      return { path, reason: osReason(error) };
    }
  }

  return {
    files,
    target: files[1]!.target.text !== undefined || files[0]!.target.text === undefined ? 1 : 0,
  };
}

function legacyRules(data: JsoncDocument["data"]): Rule[] {
  const normalize = (action: string) =>
    (({ bash: "shell", write: "edit", patch: "edit", task: "subagent" }) as Record<string, string>)[
      action
    ] ?? action;

  const permission = (action: string, resource: string, effect: Json): Rule[] =>
    effect === "allow" || effect === "ask" || effect === "deny"
      ? [{ action: normalize(action), resource, effect }]
      : [];

  const tools = Object.entries(object(data.tools) ?? {}).flatMap(([action, enabled]) =>
    typeof enabled === "boolean" ? permission(action, "*", enabled ? "allow" : "deny") : [],
  );

  const permissions =
    typeof data.permission === "string"
      ? permission("*", "*", data.permission)
      : Object.entries(object(data.permission) ?? {}).flatMap(([action, value]) =>
          typeof value === "string"
            ? permission(action, "*", value)
            : Object.entries(object(value) ?? {}).flatMap(([resource, effect]) =>
                permission(action, resource, effect),
              ),
        );

  return [...tools, ...permissions];
}

function positions(entries: Entry[], group: string) {
  const personal = new Map<string, number>();
  return entries
    .flatMap((entry) => {
      const list = `${entry.file}:${entry.list}`;
      if (!entry.group) personal.set(list, (personal.get(list) ?? 0) + 1);
      return entry.group === group
        ? [
            {
              file: entry.file,
              list: entry.list,
              before: personal.get(list) ?? 0,
              value: [
                object(entry.value)!.action,
                object(entry.value)!.resource,
                object(entry.value)!.effect,
              ],
            },
          ]
        : [];
    })
    .sort((left, right) => left.file - right.file || left.list.localeCompare(right.list));
}

function resolveChanges(
  input: Input,
  files: File[],
  entries: Entry[],
  slots: Slot[],
  target: number,
  policyTarget: number,
  confirmed: readonly OpenCodeChange[],
) {
  const probes = [
    ...new Map(
      [...slots.flatMap((slot) => slot.keys), ...entries.flatMap((entry) => entry.rule ?? [])]
        .flatMap((key) => [
          key,
          ...(key.resource.endsWith(" *") ? [{ ...key, resource: key.resource.slice(0, -2) }] : []),
        ])
        .map((probe) => [keyOf(probe), probe]),
    ).values(),
  ];

  const coverage = new Map<Entry, boolean[]>();
  const covers = (entry: Entry) => {
    const cached = coverage.get(entry);
    if (cached) return cached;

    const result = probes.map((probe) => matches(entry, probe));
    coverage.set(entry, result);
    return result;
  };

  const decisions = (state: Entry[]) => {
    const policies = state
      .filter((entry) => entry.list === "policies")
      .toSorted((left, right) => right.file - left.file);

    const permissions = state.filter((entry) => entry.list === "permissions");
    return probes.map((_, index) => {
      const policy = policies.findLast((entry) => covers(entry)[index]);
      if (policy?.rule?.effect === "deny") return strength.deny;
      return strength[
        permissions.findLast((entry) => covers(entry)[index])?.rule?.effect ?? "allow"
      ];
    });
  };

  const candidates = new Map(
    slots.map((slot) => [
      slot.group.id,
      renderedEntries(slot.rules, slot.group.id, target, policyTarget, input.home),
    ]),
  );

  const original = decisions(entries);
  const blocked = new Set<string>();
  const atTerminal = !terminalFailures(input.env, input.stdin, input.stdout).length;
  for (;;) {
    let final = entries;
    let current = original;
    const changes: OpenCodeChange[] = [];
    const accepted = new Set<string>();
    const touches: { group: string; confirmed: boolean; probes: boolean[] }[] = [];
    for (const slot of slots) {
      if (slot.level === "off" || slot.group.kind === "allow") continue;

      const added = candidates.get(slot.group.id)!;
      const next = [...final.filter((entry) => entry.group !== slot.group.id), ...added].sort(
        (left, right) => left.file - right.file,
      );

      if (isDeepStrictEqual(positions(final, slot.group.id), positions(next, slot.group.id)))
        continue;

      const after = decisions(next);
      const differences = after.map((decision, index) => decision - current[index]!);
      const classification =
        slot.group.kind === "retired"
          ? "neutral"
          : differences.some((difference) => difference < 0) || blocked.has(slot.group.id)
            ? "weakening"
            : differences.some((difference) => difference > 0)
              ? "strengthening"
              : "neutral";

      const change: OpenCodeChange = {
        group: slot.group.id,
        from: stateOf(slot.old.flatMap((entry) => entry.rule ?? [])),
        to: stateOf(slot.rules),
        class: classification,
        rules: slot.rules,
        was: slot.old.map((entry) => ({
          file: files[entry.file]!.target.path,
          list: entry.list,
          value: entry.value,
        })),
      };

      changes.push(change);

      const authorized = atTerminal && confirmed.some((shown) => isDeepStrictEqual(shown, change));
      if (classification === "weakening" && !authorized) continue;

      touches.push({
        group: slot.group.id,
        confirmed: authorized || slot.group.kind === "retired",
        probes: probes.map((_, index) =>
          [...slot.old, ...added].some((entry) => covers(entry)[index]),
        ),
      });

      accepted.add(slot.group.id);
      final = next;
      current = after;
    }

    const unsafe = new Set<string>();
    for (const [index, decision] of current.entries()) {
      if (decision >= original[index]!) continue;
      const cause = touches.findLast((touch) => touch.probes[index]);
      if (cause && !cause.confirmed) unsafe.add(cause.group);
    }

    if (!unsafe.size) return { final, changes, accepted };

    for (const group of unsafe) blocked.add(group);
  }
}

export function planOpenCodeRules(input: Input) {
  return buildOpenCodeRules(input, []);
}

function buildOpenCodeRules(input: Input, confirmed: readonly OpenCodeChange[]) {
  const groups = readRuleGroups(input.root);
  const path = join(input.opencode, "opencode.jsonc");
  const parsed = parseLevels(input.config.content, groups);
  const levels = input.levels ?? parsed.levels;

  if (input.config.invalid)
    return {
      kind: "skip" as const,
      path,
      reason: `${input.config.path} is invalid`,
      paste: [] as OwnedValue[],
    };

  if (!levels) return { kind: "unmanaged" as const, path };

  const read = readFiles(input.opencode);
  const fallback = (reason: string, path: string) => ({
    kind: "skip" as const,
    path,
    reason,
    paste: groups
      .filter((group) => group.kind !== "allow")
      .flatMap((group) => {
        const { level, target } = placement(group, {
          mode: input.mode,
          levels,
          guard: false,
          release: input.release,
        });

        return level === "off"
          ? []
          : ruleValues(
              group.entries.flatMap((entry) => openCodeKeys(entry, input.current, input.home)),
              target,
            );
      }),
  });

  if ("reason" in read) return fallback(read.reason, read.path);

  const { files, target } = read;
  const policyTarget = files[0]!.target.text !== undefined ? 0 : target;
  const removedPlugin = files.some(({ document }) =>
    [document.data.plugin, document.data.plugins].some(
      (plugins) =>
        Array.isArray(plugins) &&
        plugins.some(
          (item) =>
            typeof item === "string" &&
            item.startsWith("-") &&
            (item === "-*" ||
              item.slice(1) === "skills-guard" ||
              (item.endsWith(".*") && "skills-guard".startsWith(item.slice(1, -1)))),
        ),
    ),
  );

  const guard =
    !input.noCli &&
    !input.noBun &&
    !removedPlugin &&
    (!!input.hooksPending || ownedFile(input.opencode, "plugins/skills.ts"));

  const defaults: Record<Placeholder, string> = {
    claude: join(input.home, ".claude"),
    agents: join(input.home, ".agents/skills"),
    conf: confIn(input.home),
    codex: join(input.home, ".codex"),
    checkout: input.current.checkout,
  };

  const claims = new Map<string, string>();
  const currentKeys = new Set<string>();
  for (const values of [input.current, defaults])
    for (const group of groups.filter((group) => group.kind !== "allow"))
      for (const key of group.entries.flatMap((entry) => openCodeKeys(entry, values, input.home))) {
        const claimed = claims.get(keyOf(key));
        if (values === defaults && claimed && currentKeys.has(keyOf(key))) continue;
        if (claimed && claimed !== group.id)
          return fallback(
            `two rules render as ${key.action}:${key.resource}`,
            files[target]!.target.path,
          );

        claims.set(keyOf(key), group.id);
        if (values === input.current) currentKeys.add(keyOf(key));
      }

  const entries: Entry[] = files.flatMap(({ document }, file) => [
    ...legacyRules(document.data).map((value): Entry => ({
      value,
      file,
      list: "permissions",
      index: -1,
      rule: decode(value, "permissions", input.home),
      legacy: true,
    })),
    ...lists.flatMap((list) =>
      ((document.data[list] as Json[] | undefined) ?? []).map((value, index): Entry => {
        const rule = decode(value, list, input.home);
        return { value, file, list, index, rule, group: owned(value, list, rule, claims) };
      }),
    ),
  ]);

  const skipped: { group: string; entries: string[] }[] = [];
  const slots: Slot[] = groups.map((group) => {
    const { level, cell, target } = placement(group, {
      mode: input.mode,
      levels,
      guard,
      release: input.release,
    });

    const keys = group.entries.flatMap((entry) => openCodeKeys(entry, input.current, input.home));
    const unsupported = group.entries.filter(
      (entry) => !openCodeKeys(entry, input.current, input.home).length,
    );

    if (level !== "off" && (target === "deny" || target === "ask") && unsupported.length)
      skipped.push({ group: group.id, entries: unsupported });

    return {
      group,
      level,
      cell,
      keys,
      old: entries.filter((entry) => entry.group === group.id),
      rules: group.kind === "allow" ? [] : ruleValues(keys, target),
    };
  });

  return {
    kind: "plan" as const,
    path: files[target]!.target.path,
    files,
    target,
    policyTarget,
    entries,
    slots,
    ...resolveChanges(input, files, entries, slots, target, policyTarget, confirmed),
    skipped,
  };
}

export function openCodeSummaries(
  changes: readonly OpenCodeChange[],
): { change: OpenCodeChange; summary: string }[] {
  return changes.map((change) => ({
    change,
    summary:
      change.from === "absent"
        ? `add ${change.to}`
        : change.to === "absent"
          ? `remove ${change.from}`
          : change.from === change.to
            ? `rewrite ${change.to}`
            : `${change.from} to ${change.to}`,
  }));
}

type Plan = Extract<ReturnType<typeof planOpenCodeRules>, { kind: "plan" }>;

function notesFor(plan: Plan, final: Entry[], mode: DeliveryMode): string[] {
  const notes = new Set<string>();
  const guardrails = final.flatMap((entry) =>
    entry.group &&
    entry.rule &&
    plan.slots.some((slot) => slot.group.id === entry.group && slot.level !== "off")
      ? [{ group: entry.group, rule: entry.rule }]
      : [],
  );

  const needs = plan.slots
    .filter(
      (slot) => slot.group.kind !== "retired" && (slot.cell === "absent" || slot.cell === "allow"),
    )
    .flatMap((slot) => slot.keys);

  for (const entry of plan.entries) {
    const rule = entry.rule;
    if (!rule) continue;

    const off = plan.slots.find((slot) => slot.group.id === entry.group)?.level === "off";
    if (entry.group && !off) continue;

    if (!entry.group)
      for (const guardrail of guardrails) {
        if (
          !openCodeMatch(rule.action, guardrail.rule.action) ||
          !openCodeMatch(rule.resource, guardrail.rule.resource)
        )
          continue;

        const effective = evaluate(final, rule);
        if (
          strength[rule.effect] < strength[guardrail.rule.effect] &&
          strength[effective] >= strength[guardrail.rule.effect]
        )
          notes.add(
            `note   opencode ${rule.effect} ${rule.action} ${rule.resource} never applies under ${guardrail.group} ${guardrail.rule.effect}`,
          );

        if (
          entry.list === "policies" &&
          rule.effect === "allow" &&
          strength[effective] < strength[guardrail.rule.effect] &&
          winningPolicy(final, rule) === entry
        )
          notes.add(
            `note   opencode personal allow policy ${rule.action} ${rule.resource} blocks ${guardrail.group} ${guardrail.rule.effect}`,
          );

        if (
          rule.effect === "deny" &&
          guardrail.rule.effect === "ask" &&
          evaluate(final, rule) === "ask"
        )
          notes.add(
            `note   opencode personal deny ${rule.action} ${rule.resource} is overridden by ${guardrail.group} ask; set the group to deny or off`,
          );
      }

    if (rule.effect === "allow") continue;

    for (const need of needs)
      if (
        [
          need.resource,
          ...(need.resource.endsWith(" *") ? [need.resource.slice(0, -2)] : []),
        ].every((resource) => matches(entry, { ...need, resource }))
      )
        notes.add(
          `note   opencode ${entry.group ? `${entry.group} is off, and its` : "personal"} ${rule.effect} ${rule.action} ${rule.resource} blocks what ${mode} mode needs`,
        );
  }

  if (guardrails.some(({ rule }) => rule.effect === "ask"))
    notes.add('note   opencode saved "always" approvals and --auto approve asks; only deny holds');

  return [...notes];
}

function pasteSet(path: string, reason: string, rules: OwnedValue[]): string[] {
  const policies = rules.filter((rule) => rule.action === "tool.use");
  const permissions = rules.filter((rule) => rule.action !== "tool.use");
  return [
    `skip   ${path} (${reason})`,
    `OpenCode rule set, not written. Add denies at the end of policies and asks at the end of permissions in ${path}:`,
    JSON.stringify({ policies, permissions }, null, 2),
  ];
}

export function applyOpenCodeRules(input: Input & { confirmed?: OpenCodeChange[] }): string[] {
  const plan = buildOpenCodeRules(input, input.confirmed ?? []);
  if (plan.kind === "unmanaged") return [];
  if (plan.kind === "skip") return pasteSet(plan.path, plan.reason, plan.paste);

  const failures = terminalFailures(input.env, input.stdin, input.stdout);
  const applies = (change: OpenCodeChange) => plan.accepted.has(change.group);
  const condition = (change: OpenCodeChange) =>
    failures.join(" and ") ||
    ((input.confirmed ?? []).some(
      (shown) => shown.group === change.group && !isDeepStrictEqual(shown, change),
    )
      ? "the rule plan changed after the preview"
      : "not confirmed");

  const paste = plan.slots.flatMap((slot) => slot.rules);

  const output = [
    ...notesFor(plan, plan.final, input.mode),
    ...plan.skipped.map(
      ({ group, entries }) =>
        `skip   opencode ${group} ${entries.join(", ")} (no OpenCode rule can express this)`,
    ),
    ...openCodeSummaries(plan.changes.filter((change) => !applies(change))).map(
      ({ change, summary }) =>
        `left   opencode ${change.group} ${summary} (weakening, ${condition(change)}; rerun ./install.sh in a terminal to apply it)`,
    ),
  ];

  const writes = plan.files
    .map((file, index) => {
      const updates = Object.fromEntries(
        lists
          .map((list) => ({
            list,
            kept: plan.final.filter(
              (entry) => entry.file === index && entry.list === list && entry.index >= 0,
            ),
            tail: plan.final.filter(
              (entry) =>
                entry.file === index && entry.list === list && entry.index < 0 && !entry.legacy,
            ),
          }))
          .map(({ list, kept, tail }) => [
            list,
            { keep: kept.map((entry) => entry.index), append: tail.map((entry) => entry.value) },
          ]),
      );

      const content = editJsoncArrays(file.document, updates);
      const gains = plan.final.filter(
        (entry) => entry.file === index && entry.index < 0 && !entry.legacy,
      ).length;

      return { ...file, content, gains };
    })
    .filter((file) => file.content !== (file.target.text ?? "{}\n"));

  for (const file of plan.files) {
    const current = readTarget(file.target.path);
    if (
      "refused" in current ||
      current.real !== file.target.real ||
      !isDeepStrictEqual(current.bytes, file.target.bytes)
    )
      return [...output, ...pasteSet(file.target.path, "changed on disk since it was read", paste)];
  }

  for (const { target, content } of writes) {
    const reason = checkTargetWrite(target, content);
    if (reason) return [...output, ...pasteSet(target.path, reason, paste)];
  }

  writes.sort((left, right) => right.gains - left.gains);

  for (const { target, content } of writes) {
    const result = writeTarget(target, content);
    if (result.outcome === "refused")
      return [...output, ...pasteSet(target.path, result.reason, paste)];

    if (result.outcome === "written") output.push(`opencode ${target.path}`);
  }

  return [
    ...openCodeSummaries(plan.changes.filter(applies)).map(
      ({ change, summary }) => `opencode ${change.group} ${summary}`,
    ),
    ...output,
  ];
}
