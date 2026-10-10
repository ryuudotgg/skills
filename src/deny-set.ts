import { readFileSync } from "node:fs";
import { join } from "node:path";

export const cells = ["deny", "ask", "allow", "absent", "deny-until-guard"] as const;
export type Cell = (typeof cells)[number];
export const placeholders = ["claude", "agents", "conf", "checkout", "codex"] as const;
export type Placeholder = (typeof placeholders)[number];
type Cells = Record<"hands-off" | "prs", Cell>;
export type RuleGroup =
  | { kind: "deny"; id: string; label: string; entries: string[]; cells: Cells }
  | { kind: "allow"; id: string; label: string; entries: string[]; cells: Cells }
  | { kind: "retired"; id: string; label: string; entries: string[] };

const heading = "## Rule groups";
const header = "| id | label | entries | hands-off | prs |";
const separator = "| --- | --- | --- | --- | --- |";

function refuse(reason: string, line: string): never {
  throw new Error(`deny-set: delivery.md ${reason}: ${line}`);
}

export function readRuleGroups(root: string): RuleGroup[] {
  const content = readFileSync(join(root, "playbook/references/delivery.md"), "utf8");
  const lines = content.split(/\r?\n/);
  const start = lines.indexOf(heading);
  if (start === -1) refuse("missing heading", heading);

  const table: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("## ")) break;
    if (line.startsWith("|")) table.push(line);
  }

  if (!table.length) refuse("no rule rows", heading);
  if (table[0] !== header) refuse("invalid header", table[0]!);
  if (table[1] !== separator) refuse("invalid separator", table[1] ?? heading);

  const groups: RuleGroup[] = [];
  const ids = new Set<string>();
  const seenEntries = new Set<string>();
  for (const line of table.slice(2)) {
    const columns = line.split("|");
    if (columns.length !== 7 || columns[0] !== "" || columns[6] !== "")
      refuse("rule row must have five cells", line);

    const [idCell, label, entryCell, handsOff, prs] = columns
      .slice(1, -1)
      .map((value) => value.trim());

    const id = idCell!.match(/^`([a-z0-9]+(?:-[a-z0-9]+)*)`$/)?.[1];
    if (!id) refuse("invalid group id", line);
    if (ids.has(id)) refuse("duplicate group id", line);
    if (!label) refuse("empty group label", line);

    const entries = Array.from(entryCell!.matchAll(/`([^`]+)`/g), (match) => match[1]!);
    if (!entries.length || entries.map((entry) => `\`${entry}\``).join(", ") !== entryCell)
      refuse("invalid backticked entries", line);

    if (!cells.includes(handsOff as Cell) || !cells.includes(prs as Cell))
      refuse("invalid mode cell", line);

    if (handsOff === "deny-until-guard") refuse("guard cell is prs only", line);

    const modeCells: Cells = { "hands-off": handsOff as Cell, prs: prs as Cell };
    const actions = Object.values(modeCells);
    if (
      actions.includes("allow") &&
      actions.some((action) => action !== "allow" && action !== "absent")
    )
      refuse("allow group mixes deny or ask", line);

    const kind = actions.every((action) => action === "absent")
      ? "retired"
      : actions.includes("allow")
        ? "allow"
        : "deny";

    for (const entry of entries) {
      const canonical = entry.replace(/:\*\)$/, " *)");
      if (seenEntries.has(canonical)) refuse("duplicate entry", line);
      if (entry.replace(/:\*\)$/, ")").includes(":*")) refuse("misplaced :*", line);
      if (kind !== "retired" && entry.startsWith("Write("))
        refuse("live Write rule is ignored", line);

      for (const match of entry.matchAll(/\{([^{}]+)\}/g))
        if (!placeholders.includes(match[1] as Placeholder)) refuse("unknown placeholder", line);

      seenEntries.add(canonical);
    }

    ids.add(id);
    groups.push(
      kind === "retired"
        ? { kind, id, label, entries }
        : { kind, id, label, entries, cells: modeCells },
    );
  }

  if (!groups.length) refuse("no rule rows", heading);

  return groups;
}

export function expandEntry(
  entry: string,
  values: Record<Placeholder, string>,
  home: string,
): string[] {
  if (!/\{[^{}]+\}/.test(entry)) return [entry];

  const bash = entry.startsWith("Bash(");
  const tilde = entry.replace(/\{([^{}]+)\}/g, (_, name: Placeholder) => {
    const value = values[name];
    const underHome = home !== "" && (value === home || value.startsWith(`${home}/`));
    return underHome ? `~${value.slice(home.length)}` : bash ? value : `/${value}`;
  });

  if (!bash) return [tilde];

  const absolute = entry.replace(/\{([^{}]+)\}/g, (_, name: Placeholder) => values[name]);
  return absolute === tilde ? [absolute] : [absolute, tilde];
}
