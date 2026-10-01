import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

type Delivery = { mode: "prs" | "hands-off"; active: string[]; notes: string[] };

function lines(text: string): string[] {
  const rows = text.split("\n");
  if (rows.at(-1) === "") rows.pop();
  return rows.map((line) => line.replace(/\r$/, ""));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function extensionVerdict(path: string): "not-extension" | "unknown" | "prs" | "none" {
  let rows: string[];
  try {
    accessSync(path, constants.R_OK);
    rows = lines(readFileSync(path, "utf8"));
  } catch {
    return "not-extension";
  }

  if (rows.shift() !== "---") return "not-extension";

  let optional = false;
  let requires: "unknown" | "prs" | "none" = "none";
  for (const row of rows) {
    if (row === "---") return optional ? requires : "not-extension";
    if (row === "optional: true") optional = true;
    if (row.includes("requires"))
      if (row !== "requires: prs") requires = "unknown";
      else if (requires !== "unknown") requires = "prs";
  }

  return "not-extension";
}

export function readDelivery(root: string, env: NodeJS.ProcessEnv): Delivery {
  const result: Delivery = { mode: "hands-off", active: [], notes: [] };
  const conf = env.SKILLS_CONF || (env.HOME ? `${env.HOME}/.agents/skills.conf` : "");
  if (!conf) return result;
  if (!conf.startsWith("/")) {
    result.notes.push(`config path is not absolute: ${conf}`);
    return result;
  }

  try {
    lstatSync(conf);
  } catch {
    return result;
  }

  let content: string;
  try {
    if (!statSync(conf).isFile()) throw new Error("not a file");
    accessSync(conf, constants.R_OK);
    content = readFileSync(conf, "utf8");
  } catch {
    result.notes.push(`${conf}: not a readable regular file`);
    return result;
  }

  let seenMode = false;
  let seenWith = false;
  let names: string[] = [];
  for (const [index, line] of lines(content).entries()) {
    if (!line || line.startsWith("#") || /^[A-Z0-9]+(_[A-Z0-9]+)+=/.test(line)) continue;
    if (!seenMode && /^DELIVERY=(prs|hands-off)$/.test(line)) {
      seenMode = true;
      result.mode = line === "DELIVERY=prs" ? "prs" : "hands-off";
    } else if (
      !seenWith &&
      /^WITH=([a-z0-9]+(-[a-z0-9]+)*( [a-z0-9]+(-[a-z0-9]+)*)*)?$/.test(line)
    ) {
      seenWith = true;
      names = line.slice(5).split(" ").filter(Boolean);
    } else
      return {
        mode: "hands-off",
        active: [],
        notes: [`${conf}: line ${index + 1}: malformed, ignoring the file`],
      };
  }

  for (const name of new Set(names)) {
    const path = join(root, name, "SKILL.md");
    if (name === "prs") result.notes.push("prs dropped: prs is a mode, set DELIVERY=prs");
    else if (!isFile(path)) result.notes.push(`${name} dropped: not installed`);
    else {
      const verdict = extensionVerdict(path);
      if (verdict === "not-extension") result.notes.push(`${name} dropped: not an extension`);
      else if (verdict === "unknown") result.notes.push(`${name} dropped: unknown requires`);
      else if (verdict === "prs" && result.mode !== "prs")
        result.notes.push(`${name} dropped: requires DELIVERY=prs`);
      else result.active.push(name);
    }
  }

  return result;
}
