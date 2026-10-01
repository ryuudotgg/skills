import { readFileSync } from "node:fs";
import { join } from "node:path";

export type DenyRow = {
  handsOff: "deny" | "allow";
  prs: "deny" | "allow";
  entries: string[];
};

export function readDenySet(root: string): DenyRow[] {
  const content = readFileSync(join(root, "playbook/references/delivery.md"), "utf8");
  const rows: DenyRow[] = [];

  let table = false;
  for (const line of content.split(/\r?\n/)) {
    if (line === "## Deny set per mode") {
      table = true;
      continue;
    }

    if (table && line.startsWith("## ")) break;
    if (!table || !line.startsWith("| ") || /^\| (entry|---) /.test(line)) continue;

    const cells = line.split("|");
    const handsOff = (cells[2] ?? "").replace(/^ +| +$/g, "");
    const prs = (cells[3] ?? "").replace(/^ +| +$/g, "");
    if ((handsOff !== "deny" && handsOff !== "allow") || (prs !== "deny" && prs !== "allow"))
      throw new Error(`deny-set: delivery.md deny row is neither deny nor allow: ${line}`);

    const entries = Array.from((cells[1] ?? "").matchAll(/`[^`]+`/g), (match) =>
      match[0].slice(1, -1),
    );

    if (!entries.length)
      throw new Error(`deny-set: delivery.md deny row has no backticked entry: ${line}`);

    rows.push({ handsOff, prs, entries });
  }

  if (!rows.length)
    throw new Error("deny-set: no deny rows under ## Deny set per mode in delivery.md");

  return rows;
}
