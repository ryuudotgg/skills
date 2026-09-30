import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Code, List, Root, Table, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import { repoRoot } from "./delivery";

function section(path: string, heading: "Playbooks" | "Layout"): string {
  const source = readFileSync(path, "utf8");
  const match = new RegExp(`^## ${heading}\\r?$`, "m").exec(source);
  if (!match) throw new Error(`Workflow: missing ${heading} section in ${path}`);

  return source.slice(match.index + match[0].length).split(/^## /m)[0];
}

function playbookLead(path: string): string {
  const lead = /^\*\*([^*]+)\*\*/m.exec(readFileSync(path, "utf8"))?.[1];
  if (!lead?.trim()) throw new Error(`Workflow: missing bold lead paragraph in ${path}`);

  return lead;
}

function playbooks(root: string): List {
  const path = resolve(root, "skills/playbook/SKILL.md");
  const bullets = section(path, "Playbooks").split(/\r?\n/).filter((line) => /^\s*[-*+]\s/.test(line));
  if (!bullets.length) throw new Error(`Workflow: no playbook bullets in ${path}`);

  return {
    type: "list",
    ordered: false,
    spread: false,
    children: bullets.map((bullet) => {
      const match = /^- \*\*([^*]+)\*\*(?: \([^)]*\))?\.?\s+(.*?)`(playbooks\/[a-z0-9-]+\.md)`\.$/.exec(bullet);
      if (!match) throw new Error(`Workflow: invalid bullet or missing playbooks path in ${path}: ${bullet}`);

      const name = match[1].replace(/\.$/, "").trim();
      const relativePath = match[3];
      const description = match[2].trim() || playbookLead(resolve(root, "skills/playbook", relativePath));
      if (!name) throw new Error(`Workflow: missing playbook name in ${path}: ${bullet}`);

      return {
        type: "listItem",
        spread: false,
        children: [{
          type: "paragraph",
          children: [
            {
              type: "link",
              url: `https://github.com/ryuudotgg/skills/blob/main/skills/playbook/${relativePath}`,
              children: [{ type: "text", value: name }],
            },
            { type: "text", value: `. ${description}` },
          ],
        }],
      };
    }),
  };
}

function codexTiers(root: string): Table {
  const path = resolve(root, "skills/playbook/references/codex-arms.md");
  const blocks = readFileSync(path, "utf8").split(/\r?\n[ \t]*\r?\n/).filter((block) => /^\|/m.test(block));
  if (blocks.length !== 1) throw new Error(`Workflow: expected one tier table in ${path}`);

  const lines = blocks[0].split(/\r?\n/);
  const rows = lines.map((line) => {
    if (!line.startsWith("|") || !line.endsWith("|"))
      throw new Error(`Workflow: invalid tier table row in ${path}: ${line}`);

    return line.slice(1, -1).split("|").map((value) => value.trim());
  });
  const [headers, separator, ...tiers] = rows;
  const tierIndex = headers?.indexOf("tier") ?? -1;
  const useIndex = headers?.indexOf("use") ?? -1;
  if (!headers || tierIndex < 0 || useIndex < 0 || !separator || !tiers.length)
    throw new Error(`Workflow: missing tier or use table in ${path}`);
  if (separator.length !== headers.length || separator.some((value) => !/^:?-+:?$/.test(value)))
    throw new Error(`Workflow: invalid tier table separator in ${path}`);

  const selected = [["tier", "use"], ...tiers.map((fields) => {
    if (fields.length !== headers.length || fields.some((value) => !value))
      throw new Error(`Workflow: invalid tier table fields in ${path}: ${fields.join(" | ")}`);

    return [fields[tierIndex], fields[useIndex]];
  })];

  return {
    type: "table",
    children: selected.map((fields): TableRow => ({
      type: "tableRow",
      children: fields.map((value) => ({
        type: "tableCell",
        children: [{ type: "text", value }],
      })),
    })),
  };
}

function plansLayout(root: string): Code {
  const path = resolve(root, "skills/plans/SKILL.md");
  const fence = /^\s*```([^\r\n`]*)\r?\n([\s\S]*?)\r?\n```(?:\r?\n|$)/.exec(section(path, "Layout"));
  if (!fence?.[2]?.trim()) throw new Error(`Workflow: missing fenced layout in ${path}`);

  return { type: "code", lang: fence[1] || undefined, value: fence[2] };
}

export function remarkWorkflow() {
  return (tree: Root, file: VFile) => {
    for (const [index, node] of tree.children.entries()) {
      if (node.type !== "mdxJsxFlowElement") continue;
      if (node.name !== "Playbooks" && node.name !== "CodexTiers" && node.name !== "PlansLayout") continue;

      const root = repoRoot(file.path);

      switch (node.name) {
        case "Playbooks":
          tree.children[index] = playbooks(root);
          break;
        case "CodexTiers":
          tree.children[index] = codexTiers(root);
          break;
        case "PlansLayout":
          tree.children[index] = plansLayout(root);
          break;
      }
    }
  };
}
