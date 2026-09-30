import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PhrasingContent, Root, RootContent, Table, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import { parse } from "yaml";
import { repoRoot } from "./delivery";

const groups = [
  { title: "The Loop", skills: ["plans", "playbook", "figure-it-out", "blast-radius", "tdd", "show-me-your-work"] },
  { title: "Panels", skills: ["architect", "how", "interrogate"] },
  { title: "Writing", skills: ["technical-writing", "unslop", "no-comments"] },
  { title: "Review Extensions", skills: ["coderabbit", "greptile", "macroscope"] },
  {
    title: "Principles",
    skills: [
      "principle-boundary-discipline",
      "principle-build-the-lever",
      "principle-encode-lessons-in-structure",
      "principle-exhaust-the-design-space",
      "principle-experience-first",
      "principle-fix-root-causes",
      "principle-foundational-thinking",
      "principle-guard-the-context-window",
      "principle-laziness-protocol",
      "principle-make-operations-idempotent",
      "principle-migrate-callers-then-delete-legacy-apis",
      "principle-minimize-reader-load",
      "principle-model-the-domain",
      "principle-never-block-on-the-human",
      "principle-outcome-oriented-execution",
      "principle-prove-it-works",
      "principle-redesign-from-first-principles",
      "principle-separate-before-serializing-shared-state",
      "principle-sequence-verifiable-units",
      "principle-subtract-before-you-add",
      "principle-type-system-discipline",
    ],
  },
];

function skillRow(root: string, directory: string): TableRow {
  const path = `skills/${directory}/SKILL.md`;
  if (!existsSync(resolve(root, path))) throw new Error(`Skills: missing ${path} named in the group map`);

  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(readFileSync(resolve(root, path), "utf8"))?.[1];
  const metadata = frontmatter ? parse(frontmatter) : undefined;
  const name = metadata?.name;
  const description = metadata?.description;
  if (typeof name !== "string" || !name.trim() || typeof description !== "string" || !description.trim())
    throw new Error(`Skills: missing name or description in ${path}`);

  const children: PhrasingContent[] = [{ type: "text", value: description }];
  if (metadata.requires) children.push(
    { type: "text", value: " Needs " },
    { type: "link", url: "/delivery", children: [{ type: "text", value: `${metadata.requires} mode` }] },
    { type: "text", value: "." },
  );

  return {
    type: "tableRow",
    children: [
      {
        type: "tableCell",
        children: [{
          type: "link",
          url: `https://github.com/ryuudotgg/skills/blob/main/${path}`,
          children: [{ type: "inlineCode", value: `/${name}`, data: { hProperties: { className: ["whitespace-nowrap"] } } }],
        }],
      },
      { type: "tableCell", children },
    ],
  };
}

export function remarkSkills() {
  return (tree: Root, file: VFile) => {
    for (let index = 0; index < tree.children.length; index++) {
      const node = tree.children[index];
      if (node.type !== "mdxJsxFlowElement" || node.name !== "SkillsCatalog") continue;

      const root = repoRoot(file.path);
      const mapped = new Set<string>();
      for (const group of groups)
        for (const directory of group.skills) {
          if (mapped.has(directory)) throw new Error(`Skills: skills/${directory}/SKILL.md named in more than one group`);
          mapped.add(directory);
        }

      for (const directory of readdirSync(resolve(root, "skills"), { withFileTypes: true }))
        if (directory.isDirectory() && existsSync(resolve(root, "skills", directory.name, "SKILL.md")) && !mapped.has(directory.name))
          throw new Error(`Skills: skills/${directory.name}/SKILL.md is ungrouped; add it to the group map in docs/lib/skills.ts`);

      const nodes: RootContent[] = groups.flatMap((group) => {
        const table: Table = {
          type: "table",
          children: [
            {
              type: "tableRow",
              children: [
                { type: "tableCell", children: [{ type: "text", value: "skill" }] },
                { type: "tableCell", children: [{ type: "text", value: "what it does" }] },
              ],
            },
            ...group.skills.map((directory) => skillRow(root, directory)),
          ],
        };

        return [
          {
            type: "heading",
            depth: 2,
            data: { hProperties: { id: group.title.toLowerCase().replaceAll(" ", "-") } },
            children: [{ type: "text", value: group.title }],
          },
          table,
        ];
      });
      tree.children.splice(index, 1, ...nodes);
      index += nodes.length - 1;
    }
  };
}
