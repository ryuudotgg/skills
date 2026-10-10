import { canonical, expandEntry, type Placeholder, type RuleGroup } from "../deny-set.ts";
import type { DeliveryMode } from "../delivery.ts";
import { object, type Json, type JsonObject } from "./json.ts";

export type Level = "deny" | "ask" | "off" | "allow";
export type Levels = { global: Exclude<Level, "allow">; groups: Readonly<Record<string, Level>> };
export type RulesChoice = { levels: Levels; release: boolean };

export type List = "deny" | "ask" | "allow";
export type Placement = List | "absent";
export type ChangeClass = "strengthening" | "weakening" | "neutral";
export type Change = {
  group: string;
  text: string;
  from: List[];
  to: Placement;
  class: ChangeClass;
  spellings: string[];
};

export type Note =
  | { kind: "dead-allow"; text: string; guardrail: string; group: string }
  | {
      kind: "blocks";
      list: "deny" | "ask";
      text: string;
      needs: string;
      group: string;
      off?: string;
    };

export type RulesInput = {
  groups: readonly RuleGroup[];
  mode: DeliveryMode;
  levels: Levels;
  guard: boolean;
  settings: JsonObject;
  home: string;
  current: Record<Placeholder, string>;
  defaults: Record<Placeholder, string>;
  release?: boolean;
};

type Occurrence = { list: List; text: string };
type Unit = {
  group: RuleGroup;
  current: string;
  spellings: string[];
  level: Level;
  cell: Placement;
  target: Placement;
  occurrences: Occurrence[];
};

const lists: List[] = ["deny", "ask", "allow"];
const strength: Record<Placement, number> = { deny: 3, ask: 2, absent: 1, allow: 0 };

function owns(group: RuleGroup, list: List): boolean {
  return group.kind === "allow" ? list === "allow" : list !== "allow";
}

function resolvedCell(group: RuleGroup, mode: DeliveryMode, guard: boolean): Placement {
  if (group.kind === "retired") return "absent";
  const cell = group.cells[mode];
  return cell === "deny-until-guard" ? (guard ? "absent" : "deny") : cell;
}

function changeClass(unit: Unit, from: List[], text: string): ChangeClass {
  if (unit.group.kind === "retired") return "neutral";

  const difference = strength[unit.target] - strength[from[0] ?? "absent"];
  const respelled =
    unit.target !== "absent" &&
    unit.occurrences.some((occurrence) => canonical(occurrence.text) !== canonical(text));

  if (difference < 0 || respelled) return "weakening";

  return difference > 0 ? "strengthening" : "neutral";
}

function parseRule(text: string): { tool: string; spec?: string } | undefined {
  const match = canonical(text).match(/^([^()]+)(?:\((.*)\))?$/);
  return match ? { tool: match[1]!, spec: match[2] } : undefined;
}

function covers(pattern: string, entry: string): boolean {
  const rule = parseRule(pattern);
  const literal = parseRule(entry);
  if (!rule || !literal || rule.tool !== literal.tool) return false;
  if (rule.spec === undefined) return true;
  if (literal.spec === undefined) return false;

  const bash = rule.tool === "Bash";
  const optionalArguments = bash && rule.spec.endsWith(" *");
  const body = optionalArguments ? rule.spec.slice(0, -2) : rule.spec;
  const segment = "(?:[^/*]|(?<!\\*)\\*(?!\\*))*";
  const expression = body
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**" || (bash && part === "*")
        ? ".*"
        : part === "*"
          ? segment
          : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .join("");

  const matcher = new RegExp(`^${expression}${optionalArguments ? "( .*)?" : ""}$`);
  const bare = bash && literal.spec.endsWith(" *") ? [literal.spec.slice(0, -2)] : [];
  return [literal.spec, ...bare].every((spec) => matcher.test(spec));
}

function list(settings: JsonObject, name: List): Json[] {
  const value = object(settings.permissions)?.[name];
  return Array.isArray(value) ? value : [];
}

export function placement(
  group: RuleGroup,
  input: Pick<RulesInput, "mode" | "levels" | "guard" | "release">,
): { level: Level; cell: Placement; target: Placement } {
  const cell = resolvedCell(group, input.mode, input.guard);
  if (input.release) return { level: "deny", cell, target: "absent" };

  const level = Object.hasOwn(input.levels.groups, group.id)
    ? input.levels.groups[group.id]!
    : input.levels.global;

  return { level, cell, target: level === "ask" && cell === "deny" ? "ask" : cell };
}

function collectUnits(input: RulesInput): Map<string, Unit> | { refused: string } {
  const claims = new Map<string, Unit>();
  const defaults: [Unit, string][] = [];
  for (const group of input.groups) {
    const { level, cell, target } = placement(group, input);

    for (const entry of group.entries) {
      const rendered = expandEntry(entry, input.current, input.home).map((current): Unit => ({
        group,
        current,
        spellings: [canonical(current)],
        level,
        cell,
        target,
        occurrences: [],
      }));

      for (const unit of rendered) {
        if (claims.has(unit.spellings[0]!))
          return { refused: `two rules render as ${unit.spellings[0]}` };

        claims.set(unit.spellings[0]!, unit);
      }

      for (const [index, text] of expandEntry(entry, input.defaults, input.home).entries())
        defaults.push([rendered[Math.min(index, rendered.length - 1)]!, canonical(text)]);
    }
  }

  for (const [unit, text] of defaults) {
    if (claims.has(text)) continue;
    claims.set(text, unit);
    unit.spellings.push(text);
  }

  return claims;
}

function planChange(unit: Unit): Change | undefined {
  const { occurrences, target } = unit;
  const acceptable = occurrences.filter(({ text }) => canonical(text) === canonical(unit.current));

  if (unit.level === "off") return;
  if (target === "absent" && !occurrences.length) return;
  if (occurrences.length === 1 && acceptable[0]?.list === target) return;

  const text =
    target === "absent"
      ? occurrences[0]!.text
      : (acceptable.find(({ list }) => list === target)?.text ??
        acceptable[0]?.text ??
        unit.current);

  const from = lists.filter((name) => occurrences.some(({ list }) => list === name));
  return {
    group: unit.group.id,
    text,
    from,
    to: target,
    class: changeClass(unit, from, text),
    spellings: [...unit.spellings],
  };
}

function collectNotes(units: Unit[], personal: Occurrence[]): Note[] {
  const notes = new Map<string, Note>();
  const add = (note: Note) => notes.set(JSON.stringify(note), note);
  const guardrails = units.filter(
    (unit) => unit.level !== "off" && (unit.target === "deny" || unit.target === "ask"),
  );

  const needs = units.filter(
    (unit) => unit.group.kind !== "retired" && (unit.cell === "absent" || unit.cell === "allow"),
  );

  const blockers = [
    ...personal.map((occurrence) => ({ ...occurrence, off: undefined })),
    ...units
      .filter((unit) => unit.level === "off")
      .flatMap((unit) =>
        unit.occurrences.map((occurrence) => ({ ...occurrence, off: unit.group.id })),
      ),
  ];

  for (const { list, text } of personal)
    if (list === "allow")
      for (const unit of guardrails)
        if (covers(unit.current, text))
          add({ kind: "dead-allow", text, guardrail: unit.current, group: unit.group.id });

  for (const { list, text, off } of blockers)
    if (list !== "allow")
      for (const unit of needs)
        if (covers(text, unit.current))
          add({
            kind: "blocks",
            list,
            text,
            needs: unit.current,
            group: unit.group.id,
            ...(off ? { off } : {}),
          });

  return [...notes.values()];
}

export function reconcileRules(
  input: RulesInput,
): { changes: Change[]; notes: Note[] } | { refused: string } {
  const permissions = object(input.settings.permissions);
  if (Object.hasOwn(input.settings, "permissions") && !permissions)
    return { refused: "permissions is not an object" };

  for (const name of lists)
    if (permissions && Object.hasOwn(permissions, name) && !Array.isArray(permissions[name]))
      return { refused: `${name} is not a list` };

  const claims = collectUnits(input);
  if (!(claims instanceof Map)) return claims;

  const personal: Occurrence[] = [];
  for (const name of lists)
    for (const text of list(input.settings, name)) {
      if (typeof text !== "string") continue;

      const unit = claims.get(canonical(text));
      if (unit && owns(unit.group, name)) unit.occurrences.push({ list: name, text });
      else personal.push({ list: name, text });
    }

  const units = [...new Set(claims.values())];
  const changes = units.flatMap((unit) => planChange(unit) ?? []);
  return { changes, notes: collectNotes(units, personal) };
}

export function applyRuleChanges(settings: JsonObject, changes: readonly Change[]): void {
  for (const change of changes) {
    const permissions = object(settings.permissions ?? {});
    if (!permissions) throw new Error("permissions is not an object");

    let insertion: number | undefined;
    const touched = change.to === "absent" ? change.from : [...change.from, change.to];
    for (const name of new Set(touched)) {
      const rows = permissions[name] ?? [];
      if (!Array.isArray(rows)) throw new Error(`${name} is not a list`);

      for (let index = 0; index < rows.length;) {
        const text = rows[index];
        if (typeof text !== "string" || !change.spellings.includes(canonical(text))) {
          index++;
          continue;
        }

        if (name === change.to) insertion ??= index;
        rows.splice(index, 1);
      }

      if (name === change.to) {
        rows.splice(insertion ?? rows.length, 0, change.text);
        permissions[name] = rows;
        settings.permissions = permissions;
      }
    }
  }
}
