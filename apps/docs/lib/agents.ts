import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Root, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import { code, row, table, text } from "./mdast";
import { readNamedFrontmatter, repoRoot } from "./repo";

function agentRow(path: string): TableRow {
  const { name, description } = readNamedFrontmatter(path, "Agents");
  return row([[code(name)], [text(description)]]);
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

      tree.children[index] = table(["agent", "what it does"], rows);
    }
  };
}
