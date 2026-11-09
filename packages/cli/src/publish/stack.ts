import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function registered(common: string, branch: string): boolean {
  const worktrees = join(common, "worktrees");

  // gh stack 0.2.0 folds these older per worktree catalogs into the common one only on its next write.
  const legacy = statSync(worktrees, { throwIfNoEntry: false })?.isDirectory()
    ? readdirSync(worktrees, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(worktrees, entry.name, "gh-stack"))
    : [];

  return [join(common, "gh-stack"), ...legacy].some((path) => listed(path, branch));
}

function listed(path: string, branch: string): boolean {
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
      return (
        Array.isArray(branches) &&
        branches.some((layer: unknown) => object(layer)?.branch === branch)
      );
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
      entries = readdirSync(directory)
        .filter((name) => !name.startsWith("."))
        .sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    } catch (error) {
      if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue;
      throw new Error(`cannot read ${directory}`);
    }

    for (const name of entries) {
      if (!/^pull[_-]request[_-]template(\.|$)/i.test(name)) continue;

      const path = join(directory, name);
      try {
        if (statSync(path, { throwIfNoEntry: false })?.isFile())
          return stripFrontmatter(readFileSync(path, "utf8"));
      } catch {
        throw new Error(`cannot read ${path}`);
      }
    }
  }

  return undefined;
}

const stackFooter = '<sub>Stack created with <a href="https://github.com/github/gh-stack">';

function settled(value: string): string {
  return value.replaceAll("\r\n", "\n").replace(/\s+$/u, "");
}

export function agentBodyAction(
  current: string,
  agent: string,
  template: string | undefined,
): "set" | "same" | "keep" {
  if (settled(current) === settled(agent)) return "same";

  const generated =
    !asciiTrim(current) ||
    (asciiTrim(current).startsWith(stackFooter) && !asciiTrim(current).includes("\n")) ||
    (template !== undefined && asciiTrim(current.replaceAll("\r\n", "\n")) === template);

  return generated ? "set" : "keep";
}

export function clearGeneratedBody(
  existing: string,
  body: string,
  template: string | undefined,
): boolean {
  return (
    !existing ||
    body.includes("github.com/github/gh-stack") ||
    (template !== undefined && asciiTrim(body) === template)
  );
}
