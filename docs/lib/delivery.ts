import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import type { PhrasingContent, Root, Table, TableCell, TableRow } from "mdast";
import type {} from "mdast-util-mdx-jsx";
import type { VFile } from "vfile";

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

function command(script: string, args: string[], page: string): string[] {
  try {
    const output = execFileSync("sh", [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const lines = output.replace(/\n$/, "");
    return lines ? lines.split("\n") : [];
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
    throw new Error(`Delivery: ${script} failed in ${page}: ${stderr || String(error)}`);
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
    return ere.split("|").flatMap((word, index) => index ? [text(", "), code(word)] : [code(word)]);

  return [code(ere)];
}

function settingsTable(lines: string[], page: string): Table {
  if (!lines.length) throw new Error(`Delivery: no reviewer settings in ${page}`);

  const rows = lines.map((line): TableRow => {
    const fields = line.split("\t");
    if (fields.length !== 4) throw new Error(`Delivery: invalid reviewer setting in ${page}: ${line}`);
    const [reviewer, setting, defaultValue, ere] = fields as [string, string, string, string];
    const confKey = `${reviewer}_${setting}`.replaceAll("-", "_").toUpperCase();

    return {
      type: "tableRow",
      children: [
        cell([code(confKey)]),
        cell([code(`skills.${reviewer}.${setting}`)]),
        cell([code(defaultValue)]),
        cell(allowed(ere)),
      ],
    };
  });

  return table(["skills.conf key", "git config key", "default", "allowed"], rows);
}

function denyTable(lines: string[], page: string): Table {
  const rows = lines.map((line): TableRow => {
    const [handsOff, prs, ...entries] = line.split("\t");
    if (!handsOff || !prs || !entries.length)
      throw new Error(`Delivery: invalid deny row in ${page}: ${line}`);

    return {
      type: "tableRow",
      children: [
        cell(entries.flatMap((entry, index) => index ? [text(", "), code(entry)] : [code(entry)])),
        cell([text(handsOff)]),
        cell([text(prs)]),
      ],
    };
  });

  return table(["entry", "hands-off", "prs"], rows);
}

export function remarkDelivery() {
  return (tree: Root, file: VFile) => {
    for (const [index, node] of tree.children.entries()) {
      if (node.type !== "mdxJsxFlowElement") continue;
      if (node.name !== "ReviewerSettings" && node.name !== "DenySet") continue;

      const root = repoRoot(file.path);
      const scripts = resolve(root, "skills/playbook/scripts");

      if (node.name === "ReviewerSettings") {
        const lines = command(resolve(scripts, "reviewers.sh"), ["--settings"], file.path);
        tree.children[index] = settingsTable(lines, file.path);
      } else {
        const lines = command(resolve(scripts, "deny-set.sh"), [], file.path);
        tree.children[index] = denyTable(lines, file.path);
      }
    }
  };
}
