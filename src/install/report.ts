import { basename, dirname } from "node:path";
import { tilde } from "./tilde.ts";

export type Section = "setup" | "skills" | "claude" | "codex" | "opencode";

export type Output = (line: string, same?: boolean) => void;

type Kind = "header" | "change" | "same" | "quiet" | "attention";

type Noun =
  | "saved"
  | "linked"
  | "unlinked"
  | "removed"
  | "plugin"
  | "agent"
  | "command"
  | "hook"
  | "rule group";

type Entry = {
  section: Section;
  line: string;
  kind: Kind;
  noun?: Noun;
  collapse?: boolean;
  body: string[];
};

export type ReportOptions = {
  write: (text: string) => void;
  pretty: boolean;
  verbose: boolean;
  color: boolean;
  width: number;
  home: string;
};

const rows: readonly [Section, string][] = [
  ["setup", "Config"],
  ["skills", "Skills"],
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["opencode", "OpenCode"],
];

const column = 2 + Math.max(...rows.map(([, title]) => title.length)) + 2;

function tool(rest: string): Pick<Entry, "kind" | "noun"> {
  if (/^(add|replace|drop) [A-Z]/.test(rest)) return { kind: "change", noun: "hook" };
  if (/Bun is missing|by hand$/.test(rest)) return { kind: "attention" };
  if (!rest.startsWith("/")) return { kind: "change", noun: "rule group" };
  if (rest.includes(" already holds ")) return { kind: "quiet" };
  if (rest.includes(" (")) return { kind: "attention" };

  const folder = basename(dirname(rest));
  if (folder === "plugins") return { kind: "change", noun: "plugin" };
  if (folder === "agents") return { kind: "change", noun: "agent" };
  if (folder === "commands") return { kind: "change", noun: "command" };

  return { kind: "quiet" };
}

function classify(line: string): Pick<Entry, "kind" | "noun" | "collapse"> | undefined {
  if (/^["{}[\]\s]/.test(line)) return undefined;
  if (line.startsWith("Rule set for ")) return { kind: "attention", collapse: true };

  const [, token, rest = ""] = /^(\S+) +(.*)$/.exec(line) ?? [];
  switch (token) {
    case "mode":
    case "with":
      return { kind: "header" };

    case "config":
      return { kind: "change", noun: "saved" };

    case "skill":
      return { kind: "change", noun: "linked" };

    case "unlink":
      return { kind: "change", noun: "unlinked" };

    case "prune":
      return { kind: "change", noun: "removed" };

    case "agent":
      return { kind: "change", noun: "agent" };

    case "rules":
      return { kind: "change", noun: "rule group" };

    case "claude":
    case "codex":
    case "opencode":
      return tool(rest);

    case "off":
    case "linked":
      return { kind: "quiet" };

    case "skip":
      return /\(no (Codex prefix|OpenCode) rule can express th(is|ese)\)$/.test(rest)
        ? { kind: "quiet" }
        : { kind: "attention" };

    case "note":
      return rest.startsWith('opencode saved "always" approvals')
        ? { kind: "quiet" }
        : { kind: "attention" };

    default:
      return { kind: "attention" };
  }
}

function painter(on: boolean) {
  const style = (open: number, close: number) => (text: string) =>
    on && text ? `\u001b[${open}m${text}\u001b[${close}m` : text;

  return {
    bold: style(1, 22),
    dim: style(2, 22),
    green: style(32, 39),
    yellow: style(33, 39),
    cyan: style(36, 39),
  };
}

function wrap(text: string, width: number): string[] {
  const lines: string[] = [];

  let line = "";
  for (const word of text.split(" "))
    if (line && line.length + 1 + word.length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;

  lines.push(line);
  return lines;
}

function shortRuleSet(line: string): string | undefined {
  const match =
    /^Rule set for (\S+) mode, not written \((.*)\)\. Add it to permissions in .* yourself:$/.exec(
      line,
    );

  return match
    ? `rules  ${match[1]} rule set not written (${match[2]}); ./install.sh --verbose prints it to paste`
    : undefined;
}

function plural(noun: Noun, count: number): string {
  if (noun === "linked" || noun === "unlinked" || noun === "removed") return `${count} ${noun}`;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function render(
  entries: readonly Entry[],
  entered: ReadonlySet<Section>,
  absent: ReadonlyMap<Section, string>,
  options: ReportOptions,
): string {
  const paint = painter(options.color);
  const rest = (entry: Entry) => entry.line.replace(/^\S+ +/, "");
  const mode = entries.find((entry) => entry.line.startsWith("mode "));
  const extensions = entries.filter((entry) => entry.line.startsWith("with ")).map(rest);
  const dot = paint.dim(" · ");
  const out = [
    "",
    [
      paint.bold("skills"),
      ...(mode ? [`${rest(mode)} mode`] : []),
      ...(extensions.length ? [extensions.join(", ")] : []),
    ].join(dot),
    "",
  ];

  const pad = " ".repeat(column);
  const width = Math.max(options.width, 60) - 1 - column;
  const tone = (entry: Entry, head: string) => {
    if (entry.kind === "change") return paint.green;
    if (entry.kind !== "attention") return paint.dim;
    return /^(note|claude|codex|opencode) /.test(head) ? paint.cyan : paint.yellow;
  };

  const item = (entry: Entry): string[] => {
    const short = entry.collapse && !options.verbose ? shortRuleSet(entry.line) : undefined;
    const line = tilde(short ?? entry.line, options.home);
    const [, head = "", tail = line] = /^([a-z]+ +)(.*)$/.exec(line) ?? [];
    const lines = wrap(tail, width - head.length);

    const muted = entry.kind === "same" || entry.kind === "quiet";
    const text = (part: string) => (muted ? paint.dim(part) : part);
    const shown = [
      `${pad}${tone(entry, head)(head)}${text(lines[0]!)}`,
      ...lines.slice(1).map((part) => `${pad}${" ".repeat(head.length)}${text(part)}`),
    ];

    if (!entry.body.length || short) return shown;
    if (entry.collapse && !options.verbose)
      return [...shown, `${pad}${paint.dim("./install.sh --verbose prints it")}`];

    return [...shown, ...entry.body.map((part) => `${pad}${part}`)];
  };

  const summary = (section: Section, own: readonly Entry[]): string => {
    const missing = absent.get(section);
    if (missing) return paint.dim(missing);

    if (section === "setup") {
      const saved = own.find((entry) => entry.noun === "saved");
      return saved
        ? paint.green(`${tilde(rest(saved), options.home)} saved`)
        : paint.dim("unchanged");
    }

    const counts = new Map<Noun, number>();
    for (const entry of own)
      if (entry.kind === "change" && entry.noun)
        counts.set(entry.noun, (counts.get(entry.noun) ?? 0) + 1);

    const removed = counts.get("removed");
    counts.delete("removed");

    const same = own.filter((entry) => entry.kind === "same").length;
    const changed = [...counts].map(([noun, count]) => plural(noun, count));
    const parts =
      section === "skills" || !changed.length ? changed : [`${changed.join(", ")} updated`];

    if (removed) parts.push(plural("removed", removed));

    const kept = section === "skills" && same ? `${same} up to date` : "";
    if (!parts.length) return paint.dim(kept || "up to date");

    return `${paint.green(parts.join(", "))}${kept ? paint.dim(`, ${kept}`) : ""}`;
  };

  for (const [section, title] of rows) {
    const own = entries.filter((entry) => entry.section === section && entry.kind !== "header");
    if (!own.length && !entered.has(section)) continue;

    out.push(`  ${paint.bold(title.padEnd(column - 2))}${summary(section, own)}`);

    for (const entry of own)
      if (options.verbose || entry.kind === "attention") out.push(...item(entry));
  }

  return `${out.join("\n")}\n`;
}

export function installReport(options: ReportOptions) {
  const entries: Entry[] = [];
  const entered = new Set<Section>();
  const absent = new Map<Section, string>();
  let current: Section = "setup";

  const take = (text: string, same = false) => {
    for (const line of text.split("\n")) {
      if (!line) continue;

      const classified = classify(line);
      const last = entries.at(-1);
      if (!classified && last) {
        last.body.push(line);
        continue;
      }

      const kind = classified?.kind ?? "attention";
      entries.push({
        section: classified?.noun === "saved" ? "setup" : current,
        line,
        kind: same && kind === "change" ? "same" : kind,
        noun: classified?.noun,
        collapse: classified?.collapse,
        body: [],
      });
    }
  };

  const line: Output = (text, same) => {
    if (options.pretty) take(text, same);
    else options.write(`${text}\n`);
  };

  return {
    line,
    text(chunk: string) {
      if (options.pretty) take(chunk);
      else options.write(chunk);
    },
    section(section: Section) {
      current = section;
      entered.add(section);
    },
    absent(section: Section, line: string, summary: string) {
      entered.add(section);
      absent.set(section, summary);
      if (!options.pretty) options.write(`${line}\n`);
    },
    end() {
      if (options.pretty && (entries.length || entered.size))
        options.write(render(entries, entered, absent, options));
    },
  };
}
