import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Root, Table, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import { readNamedFrontmatter, repoRoot } from "./repo";

function agentRow(path: string): TableRow {
  const { name, description } = readNamedFrontmatter(path, "Agents");
  return {
    type: "tableRow",
    children: [
      { type: "tableCell", children: [{ type: "inlineCode", value: name }] },
      { type: "tableCell", children: [{ type: "text", value: description }] },
    ],
  };
}

export function remarkAgents() {
  return (tree: Root, file: VFile) => {
    for (const [index, node] of tree.children.entries()) {
      if (node.type !== "mdxJsxFlowElement" || node.name !== "ClaudeAgents") continue;

      const directory = resolve(repoRoot(file.path, "Agents"), "agents");
      const rows = readdirSync(directory)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => agentRow(resolve(directory, name)));

      const table: Table = {
        type: "table",
        children: [
          {
            type: "tableRow",
            children: [
              { type: "tableCell", children: [{ type: "text", value: "agent" }] },
              { type: "tableCell", children: [{ type: "text", value: "what it does" }] },
            ],
          },
          ...rows,
        ],
      };

      tree.children[index] = table;
    }
  };
}
