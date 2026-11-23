import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import type { PhrasingContent, Root, RootContent, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";
import { code, row, table, text } from "./mdast";
import { readNamedFrontmatter, repoRoot } from "./repo";

const groups = [
  {
    title: "The Loop",
    skills: ["plans", "playbook", "figure-it-out", "blast-radius", "tdd", "show-me-your-work"],
  },
  { title: "Panels", skills: ["architect", "how", "interrogate"] },
  { title: "Writing", skills: ["technical-writing", "unslop", "no-comments"] },
  { title: "Review Extensions", skills: ["coderabbit", "greptile", "macroscope"] },
  { title: "Tracker Extensions", skills: ["linear"] },
  { title: "Sync Extensions", skills: ["hub"] },
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
  if (!existsSync(resolve(root, path)))
    throw new Error(`Skills: missing ${path} named in the group map`);

  const metadata = readNamedFrontmatter(path, "Skills", root);

  const description: PhrasingContent[] = [text(metadata.description)];
  if (metadata.requires)
    description.push(
      text(" Needs "),
      { type: "link", url: "/delivery", children: [text(`${metadata.requires} mode`)] },
      text("."),
    );

  return row([
    [
      {
        type: "link",
        url: `https://github.com/ryuudotgg/skills/blob/main/${path}`,
        children: [
          {
            ...code(`/${metadata.name}`),
            data: { hProperties: { className: ["whitespace-nowrap"] } },
          },
        ],
      },
    ],
    description,
  ]);
}

export function remarkSkills() {
  return (tree: Root, file: VFile) => {
    for (let index = 0; index < tree.children.length; index++) {
      const node = tree.children[index];
      if (node.type !== "mdxJsxFlowElement" || node.name !== "SkillsCatalog") continue;

      const root = repoRoot(file.path, "Skills");
      const mapped = new Set<string>();
      for (const group of groups)
        for (const directory of group.skills) {
          if (mapped.has(directory))
            throw new Error(`Skills: skills/${directory}/SKILL.md named in more than one group`);

          mapped.add(directory);
        }

      for (const directory of readdirSync(resolve(root, "skills"), { withFileTypes: true }))
        if (
          directory.isDirectory() &&
          existsSync(resolve(root, "skills", directory.name, "SKILL.md")) &&
          !mapped.has(directory.name)
        )
          throw new Error(
            `Skills: skills/${directory.name}/SKILL.md is ungrouped; add it to the group map in apps/docs/lib/skills.ts`,
          );

      const nodes: RootContent[] = groups.flatMap((group): RootContent[] => [
        {
          type: "heading",
          depth: 2,
          data: { hProperties: { id: group.title.toLowerCase().replaceAll(" ", "-") } },
          children: [text(group.title)],
        },
        table(
          ["skill", "what it does"],
          group.skills.map((directory) => skillRow(root, directory)),
        ),
      ]);

      tree.children.splice(index, 1, ...nodes);
      index += nodes.length - 1;
    }
  };
}
