import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PhrasingContent, Root, Table, TableCell, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import { readRuleGroups, type Cell, type RuleGroup } from "../../src/deny-set";
import { readDeclarations, type Declaration } from "../../src/reviewers/declaration";

export function repoRoot(path: string): string {
  if (!isAbsolute(path)) throw new Error(`Delivery: expected absolute page path: ${path}`);

  let directory = dirname(path);
  while (true) {
    if (existsSync(resolve(directory, "install.sh")) && existsSync(resolve(directory, "skills")))
      return directory;

    const parent = dirname(directory);
    if (parent === directory) throw new Error(`Delivery: could not find repo root from ${path}`);

    directory = parent;
  }
}

function cell(children: PhrasingContent[]): TableCell {
  return { type: "tableCell", children };
}

function text(value: string): PhrasingContent {
  return { type: "text", value };
}

function code(value: string): PhrasingContent {
  return { type: "inlineCode", value };
}

function table(headers: string[], rows: TableRow[]): Table {
  return {
    type: "table",
    children: [
      { type: "tableRow", children: headers.map((header) => cell([text(header)])) },
      ...rows,
    ],
  };
}

function allowed(ere: string): PhrasingContent[] {
  const digits = /^\[([0-9])-([0-9])\]$/.exec(ere);
  if (digits) return [text(`${digits[1]} to ${digits[2]}`)];

  if (/^[a-z]+(?:\|[a-z]+)*$/.test(ere))
    return ere
      .split("|")
      .flatMap((word, index) => (index ? [text(", "), code(word)] : [code(word)]));

  return [code(ere)];
}

function settingsTable(declarations: Declaration[]): Table {
  const rows = declarations.flatMap((declaration) =>
    declaration.settings.map((setting): TableRow => ({
      type: "tableRow",
      children: [
        cell([code(setting.key)]),
        cell([code(`skills.${declaration.name}.${setting.name}`)]),
        cell([code(setting.defaultValue)]),
        cell(allowed(setting.pattern)),
      ],
    })),
  );

  if (!rows.length) throw new Error("no reviewer settings");

  return table(["skills.conf key", "git config key", "default", "allowed"], rows);
}

function modeCell(value: Cell): string {
  if (value === "absent") return "no rule";
  if (value === "deny-until-guard") return "deny until the commit guard is wired";
  return value;
}

function denyTable(groups: RuleGroup[]): Table {
  const rows = groups
    .filter((group) => group.kind !== "retired")
    .map(({ id, label, cells, entries }): TableRow => ({
      type: "tableRow",
      children: [
        cell([code(id)]),
        cell([text(label)]),
        cell(
          entries.flatMap((entry, index) => (index ? [text(", "), code(entry)] : [code(entry)])),
        ),
        cell([text(modeCell(cells["hands-off"]))]),
        cell([text(modeCell(cells.prs))]),
      ],
    }));

  return table(["id", "group", "entries", "hands-off", "prs"], rows);
}

export function remarkDelivery() {
  return (tree: Root, file: VFile) => {
    for (const [index, node] of tree.children.entries()) {
      if (node.type !== "mdxJsxFlowElement") continue;
      if (node.name !== "ReviewerSettings" && node.name !== "DenySet") continue;

      const root = repoRoot(file.path);
      try {
        tree.children[index] =
          node.name === "ReviewerSettings"
            ? settingsTable(readDeclarations(resolve(root, "skills")))
            : denyTable(readRuleGroups(resolve(root, "skills")));
      } catch (error) {
        throw new Error(
          `Delivery: ${error instanceof Error ? error.message : String(error)} in ${file.path}`,
        );
      }
    }
  };
}
