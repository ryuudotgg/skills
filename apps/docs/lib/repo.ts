import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { readFrontmatter } from "skills-cli/frontmatter";

export function repoRoot(path: string, label: string): string {
  if (!isAbsolute(path)) throw new Error(`${label}: expected absolute page path: ${path}`);

  let directory = dirname(path);
  while (true) {
    if (existsSync(resolve(directory, "install.sh")) && existsSync(resolve(directory, "skills")))
      return directory;

    const parent = dirname(directory);
    if (parent === directory) throw new Error(`${label}: could not find repo root from ${path}`);

    directory = parent;
  }
}

type NamedFrontmatter = Record<string, unknown> & { name: string; description: string };

export function readNamedFrontmatter(path: string, label: string, root?: string): NamedFrontmatter {
  const text = readFileSync(root ? resolve(root, path) : path, "utf8");
  const frontmatter = readFrontmatter(text, parse);
  const data = frontmatter.kind === "mapping" ? frontmatter.data : {};
  const { name, description } = data;
  if (
    typeof name !== "string" ||
    !name.trim() ||
    typeof description !== "string" ||
    !description.trim()
  )
    throw new Error(`${label}: missing name or description in ${path}`);

  return { ...data, name, description };
}
