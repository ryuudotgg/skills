import { resolve } from "node:path";
import type { PhrasingContent, Root, Table } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import {
  levelsFor,
  overrideKey,
  readRuleGroups,
  type Cell,
  type RuleGroup,
} from "skills-cli/deny-set";
import { readDeclarations, type Declaration } from "skills-cli/reviewers/declaration";
import { code, row, table, text } from "./mdast";
import { repoRoot } from "./repo";

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
    declaration.settings.map((setting) =>
      row([
        [code(setting.key)],
        [code(`skills.${declaration.name}.${setting.name}`)],
        [code(setting.defaultValue)],
        allowed(setting.pattern),
      ]),
    ),
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
    .map(({ id, label, cells, entries }) =>
      row([
        [code(id)],
        [text(label)],
        entries.flatMap((entry, index) => (index ? [text(", "), code(entry)] : [code(entry)])),
        [text(modeCell(cells["hands-off"]))],
        [text(modeCell(cells.prs))],
      ]),
    );

  return table(["id", "group", "entries", "hands-off", "prs"], rows);
}

function cliAllow(groups: RuleGroup[]): Root["children"][number] {
  const group = groups.find((group) => group.id === "skills-cli");
  const verbs = [
    ...new Set(
      (group?.entries ?? []).flatMap((entry) => {
        const match = /^Bash\(\{agents\}\/playbook\/bin\/skills ([^*]+) \*\)$/.exec(entry);
        return match ? [match[1]!] : [];
      }),
    ),
  ];

  return {
    type: "list",
    ordered: false,
    children: verbs.map((verb) => ({
      type: "listItem",
      children: [{ type: "paragraph", children: [code(`skills ${verb}`)] }],
    })),
  };
}

function ruleLevelsTable(groups: RuleGroup[]): Table {
  const rows = groups
    .filter((group) => group.kind !== "retired")
    .map(({ id, label, kind }) =>
      row([[code(overrideKey(id))], [text(label)], allowed(levelsFor(kind).join("|"))]),
    );

  return table(["skills.conf key", "group", "allowed"], rows);
}

export function remarkDelivery() {
  return (tree: Root, file: VFile) => {
    for (const [index, node] of tree.children.entries()) {
      if (node.type !== "mdxJsxFlowElement") continue;
      if (!["ReviewerSettings", "DenySet", "RuleLevels", "CliAllow"].includes(node.name ?? ""))
        continue;

      const root = repoRoot(file.path, "Delivery");
      try {
        tree.children[index] =
          node.name === "ReviewerSettings"
            ? settingsTable(readDeclarations(resolve(root, "skills")))
            : node.name === "RuleLevels"
              ? ruleLevelsTable(readRuleGroups(resolve(root, "skills")))
              : node.name === "CliAllow"
                ? cliAllow(readRuleGroups(resolve(root, "skills")))
                : denyTable(readRuleGroups(resolve(root, "skills")));
      } catch (error) {
        throw new Error(
          `Delivery: ${error instanceof Error ? error.message : String(error)} in ${file.path}`,
        );
      }
    }
  };
}
