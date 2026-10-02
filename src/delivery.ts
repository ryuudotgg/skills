import { accessSync, constants, lstatSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readFrontmatter } from "./frontmatter.ts";

export type DeliveryMode = "prs" | "hands-off";
type Delivery = { mode: DeliveryMode; active: string[]; notes: string[] };
export type DeliveryConfig = {
  mode: DeliveryMode;
  names: string[];
  notes: string[];
  content: string;
  invalid: boolean;
  path: string;
};

export function confIn(home: string): string {
  return `${home}/.agents/skills.conf`;
}

export function confPath(env: NodeJS.ProcessEnv): string {
  return env.SKILLS_CONF || (env.HOME ? confIn(env.HOME) : "");
}

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

export function extensionVerdict(path: string): "not-extension" | "unknown" | "prs" | "none" {
  let text: string;
  try {
    accessSync(path, constants.R_OK);
    text = readFileSync(path, "utf8");
  } catch {
    return "not-extension";
  }

  const frontmatter = readFrontmatter(text, Bun.YAML.parse);
  if (frontmatter.kind === "invalid") return "unknown";
  if (frontmatter.kind !== "mapping") return "not-extension";

  const { data } = frontmatter;
  if (!Object.hasOwn(data, "optional")) return "not-extension";
  if (data.optional !== true) return "unknown";
  if (!Object.hasOwn(data, "requires")) return "none";

  return data.requires === "prs" ? "prs" : "unknown";
}

export function readDeliveryConfig(env: NodeJS.ProcessEnv): DeliveryConfig {
  const result: DeliveryConfig = {
    mode: "hands-off",
    names: [],
    notes: [],
    content: "",
    invalid: false,
    path: "",
  };

  const conf = confPath(env);
  if (!conf) return result;
  if (!conf.startsWith("/")) {
    result.notes.push(`config path is not absolute: ${conf}`);
    result.invalid = true;
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
    result.invalid = true;
    return result;
  }

  let seenMode = false;
  let seenWith = false;
  result.content = content;
  result.path = conf;

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
      result.names = line.slice(5).split(" ").filter(Boolean);
    } else
      return {
        mode: "hands-off",
        names: [],
        notes: [`${conf}: line ${index + 1}: malformed, ignoring the file`],
        content,
        invalid: true,
        path: conf,
      };
  }

  return result;
}

export function rewriteDelivery(
  config: DeliveryConfig,
  mode: DeliveryMode,
  names: readonly string[],
): string {
  let wroteMode = false;
  let wroteWith = false;
  const rows = lines(config.content).map((line) => {
    if (line.startsWith("DELIVERY=")) {
      wroteMode = true;
      return `DELIVERY=${mode}`;
    }

    if (line.startsWith("WITH=")) {
      wroteWith = true;
      return `WITH=${names.join(" ")}`;
    }

    return line;
  });

  if (!wroteMode) rows.push(`DELIVERY=${mode}`);
  if (!wroteWith) rows.push(`WITH=${names.join(" ")}`);

  return `${rows.join("\n").replace(/\n+$/, "")}\n`;
}

export function readDelivery(root: string, env: NodeJS.ProcessEnv): Delivery {
  return deliveryFrom(root, readDeliveryConfig(env));
}

export function deliveryFrom(root: string, config: DeliveryConfig): Delivery {
  const result: Delivery = { mode: config.mode, active: [], notes: [...config.notes] };
  if (config.invalid) return result;

  for (const name of new Set(config.names)) {
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
