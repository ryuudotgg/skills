import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function registered(gitDir: string, branch: string): boolean {
  const path = join(gitDir, "gh-stack");

  if (!statSync(path, { throwIfNoEntry: false })?.isFile()) return false;

  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch {
    throw new Error(`cannot read ${path}`);
  }

  try {
    const state = object(JSON.parse(content));
    if (!Array.isArray(state?.stacks)) throw new Error("invalid stacks");

    return state.stacks.some((stack: unknown) => {
      const branches = object(stack)?.branches;
      return Array.isArray(branches) && branches.some((layer: unknown) => object(layer)?.branch === branch);
    });
  } catch {
    throw new Error(`cannot read ${path}`);
  }
}

export function stackLayers(viewJson: string): string[] | undefined {
  try {
    const view = object(JSON.parse(viewJson));
    if (!Array.isArray(view?.branches)) return undefined;

    const layers: string[] = [];
    for (const branch of view.branches) {
      const name = object(branch)?.name;
      if (typeof name !== "string" || !name) return undefined;
      layers.push(name);
    }

    return layers;
  } catch {
    return undefined;
  }
}

export function asciiTrim(value: string): string {
  return value.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, "");
}

export function stripFrontmatter(value: string): string {
  const lines = value.split("\n");
  if (!/^---\r?$/.test(lines[0] ?? "")) return asciiTrim(value);

  const end = lines.findIndex((line, index) => index > 0 && /^---\r?$/.test(line));
  return end < 0 ? "" : asciiTrim(lines.slice(end + 1).join("\n"));
}

export function templateBody(root: string): string | undefined {
  for (const directory of [join(root, ".github"), root, join(root, "docs")]) {
    let entries: string[];
    try {
      entries = readdirSync(directory).filter((name) => !name.startsWith("."))
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw new Error(`cannot read ${directory}`);
    }

    for (const name of entries) {
      if (!/^pull[_-]request[_-]template(\.|$)/i.test(name)) continue;
      const path = join(directory, name);
      try {
        if (statSync(path, { throwIfNoEntry: false })?.isFile()) return stripFrontmatter(readFileSync(path, "utf8"));
      } catch {
        throw new Error(`cannot read ${path}`);
      }
    }
  }

  return undefined;
}

export function clearGeneratedBody(existing: string, body: string, template: string | undefined): boolean {
  return !existing || body.includes("github.com/github/gh-stack")
    || (template !== undefined && asciiTrim(body) === template);
}
