import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { codePointOrder, PY_SPACE, pyRstrip, pyStrip, splitlines, textMode } from "../hooks/python-text.ts";
import type { Verb } from "../registry.ts";
import { shlex } from "./shlex.ts";
import { describe, readSync, type ReadFailure } from "../read.ts";

type Registry = { verbs: readonly Verb[] };
type Report = (path: string, line: number, message: string) => void;
type Efforts = { models: Map<string, Set<string>>; review: string };
type Invocation = { line: number; start: number; tokens: string[] };

const retiredScripts: ReadonlyMap<string, string> = new Map([
  ["frontier.sh", "plans frontier"],
  ["validate.py", "check"],
  ["delivery-mode.sh", "delivery"],
  ["lease-rebase.sh", "lease-rebase"],
]);

const word = "[\\p{L}\\p{N}_]";
const space = `[${PY_SPACE}]`;
const boundary = `(?!${word})`;
const wordStart = `(?<!${word})`;
const codexLine = new RegExp(`${wordStart}codex${space}+(?:-\\S+${space}+\\S+${space}+)*(exec|review)${boundary}`, "gu");
const codexInvocation = new RegExp(`${wordStart}codex${boundary}(?!/)[^\x60\n]*?${wordStart}(exec|review)${boundary}`, "gu");
const hooksOffPrefix = new RegExp(`(?:^|[${PY_SPACE};&|(])AGENT_HOOKS=0(?:${space}+[A-Za-z_]${word}*=\\S*)*${space}+$`, "u");
const deliveryVerb = `(?:stages?|commits?${boundary}(?!${space}+to${boundary})|push(?:es)?${boundary}(?!${space}+back${boundary})|posts?)${boundary}(?!-)`;
const deliveryRestatement = new RegExp(`${wordStart}(?:never|do not|don't)${space}+${deliveryVerb}|${wordStart}the (?:operator|human) (?:${word}+, )*${deliveryVerb}|${wordStart}no commits?, no push(?:es)?${boundary}`, "iu");
const deliveryDelegate = new RegExp(`${wordStart}(?:delegates?|subagents?|arms?|workers?)${boundary}`, "iu");
const deliverySkipFiles = new Set([
  "skills/playbook/references/delivery.md",
  "skills/playbook/playbooks/handing-back.md",
  "skills/playbook/playbooks/babysit.md",
  "skills/playbook/playbooks/pause-safely.md",
]);
const deliverySkipDirs = ["agents/", "skills/how/", "skills/interrogate/", "skills/blast-radius/"];
const builtinAgents = new Set(["general-purpose", "Explore", "Plan", "claude"]);
const commandEnd = new RegExp(`^(?:<<|\x60|${space}-${space}|${space}>${space}|${space}2>|;|&&|\\|\\||${space}\\|${space})`, "u");
const helpCache = new Map<string, string | ReadFailure>();
let helpFailureReported = false;

function readText(path: string): string {
  return textMode(readFileSync(path));
}

function isFile(path: string): boolean {
  return statSync(path, { throwIfNoEntry: false })?.isFile() ?? false;
}

function isDirectory(path: string): boolean {
  return lstatSync(path, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

function listdir(path: string): string[] {
  return isDirectory(path) ? readdirSync(path).sort(codePointOrder) : [];
}

function* walk(path: string, extensions: readonly string[]): Generator<string> {
  const entries = listdir(path);
  for (const name of entries)
    if (isFile(join(path, name)) && extensions.some((extension) => name.endsWith(extension)))
      yield join(path, name);

  for (const name of entries)
    if (name !== "node_modules" && name !== ".git" && isDirectory(join(path, name)))
      yield* walk(join(path, name), extensions);
}

function* markdownFiles(root: string): Generator<string> {
  for (const base of ["skills", "agents"]) yield* walk(join(root, base), [".md"]);
  yield* walk(join(root, "docs/content"), [".md", ".mdx"]);

  for (const name of ["README.md", "CONTRIBUTING.md"])
    if (isFile(join(root, name))) yield join(root, name);
}

function repr(value: unknown): string {
  if (value === undefined || value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "string") {
    const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
    const escaped = value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t").replaceAll(quote, `\\${quote}`);
    return `${quote}${escaped}${quote}`;
  }

  if (Array.isArray(value)) return `[${value.map(repr).join(", ")}]`;
  if (typeof value === "object") return `{${Object.entries(value).map(([key, entry]) => `${repr(key)}: ${repr(entry)}`).join(", ")}}`;

  return String(value);
}

function parseFrontmatter(path: string, text: string, report: Report): Record<string, unknown> | undefined {
  if (!text.startsWith("---\n")) {
    report(path, 1, "no frontmatter");
    return;
  }

  const end = text.indexOf("\n---", 4);
  if (end < 0) {
    report(path, 1, "frontmatter never closes");
    return;
  }

  try {
    const data: unknown = Bun.YAML.parse(text.slice(4, end));
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      report(path, 1, "frontmatter is not a mapping");
      return;
    }

    return data as Record<string, unknown>;
  } catch (error) {
    report(path, 1, `frontmatter does not parse: ${splitlines(error instanceof Error ? error.message : String(error))[0]}`);
    return;
  }
}

function checkExtensionKeys(path: string, lines: string[], report: Report): void {
  const optional = lines.includes("optional: true");
  for (const [index, line] of lines.entries())
    if (line.startsWith("optional") && line !== "optional: true")
      report(path, index + 2, "optional must be exactly 'optional: true'");
    else if (!optional && line.startsWith("requires"))
      report(path, index + 2, "requires needs 'optional: true'");
    else if (line.includes("requires") && optional && line !== "requires: prs")
      report(path, index + 2, "an optional skill's requires line must be exactly 'requires: prs'");
}

function checkFrontmatter(path: string, expectedName: string, skill: boolean, report: Report): void {
  const text = readText(path);
  const data = parseFrontmatter(path, text, report);
  if (!data) return;

  for (const key of ["name", "description"])
    if (typeof data[key] !== "string" || !pyStrip(data[key])) report(path, 1, `frontmatter missing ${key}`);

  if (data.name !== expectedName) report(path, 1, `name is ${repr(data.name)}, directory says ${repr(expectedName)}`);

  for (const key of ["mode", "icon", "color", "reminder"])
    if (Object.hasOwn(data, key)) report(path, 1, `frontmatter key ${key} is a Cursor chat-mode key, unsupported here`);

  if (skill) checkExtensionKeys(path, splitlines(text.slice(4, text.indexOf("\n---", 4))), report);
}

function checkSkills(root: string, report: Report): void {
  for (const name of listdir(join(root, "skills"))) {
    const directory = join(root, "skills", name);
    if (!isDirectory(directory)) continue;

    const reviewer = join(directory, "reviewer.conf");
    if (isFile(reviewer) && !isFile(join(directory, "reviewer.ts"))) report(reviewer, 0, "no reviewer.ts");

    const skill = join(directory, "SKILL.md");
    if (!isFile(skill)) {
      report(directory, 0, "no SKILL.md");
      continue;
    }

    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) report(directory, 0, "directory name is not lowercase-hyphen");
    checkFrontmatter(skill, name, true, report);
  }
}

function agentNames(root: string, report: Report): Set<string> {
  const names = new Set<string>();
  for (const name of listdir(join(root, "agents")))
    if (name.endsWith(".md")) {
      checkFrontmatter(join(root, "agents", name), name.slice(0, -3), false, report);
      names.add(name.slice(0, -3));
    }

  return names;
}

function skillRoot(root: string, path: string): string {
  let directory = dirname(path);
  while (directory.startsWith(root) && directory !== root) {
    if (isFile(join(directory, "SKILL.md"))) return directory;
    directory = dirname(directory);
  }

  return root;
}

function checkPaths(root: string, path: string, text: string, report: Report): void {
  for (const [index, line] of splitlines(text).entries())
    for (const match of line.matchAll(/`([^`\n]+?\.(?:md|sh|tsv|ts|py|json))`/gu)) {
      const ref = match[1]!;
      if (!ref.includes("/") || /^(?:http|~|\$|\/|<|\.claude)/.test(ref) || /[<>*$ ]/.test(ref)) continue;

      const bases = [dirname(path), skillRoot(root, path), root, join(root, "skills/playbook")];
      const first = ref.split("/")[0]!;
      if ((first === ".." || bases.some((base) => isDirectory(join(base, first)))) && !bases.some((base) => existsSync(join(base, ref))))
        report(path, index + 1, `path \`${ref}\` does not resolve`);
    }
}

function checkAgents(path: string, text: string, known: Set<string>, report: Report): void {
  for (const [index, line] of splitlines(text).entries()) {
    const names = [
      ...line.matchAll(/`((?:codex|fable|opus)-[a-z0-9-]+)`/gu),
      ...line.matchAll(new RegExp(`subagent_type["'\x60]?:?${space}*["'\x60]([A-Za-z0-9-]+)`, "gu")),
    ];

    for (const match of names)
      if (!known.has(match[1]!) && !builtinAgents.has(match[1]!)) report(path, index + 1, `agent \`${match[1]}\` does not exist in agents/`);
  }
}

function checkDashes(path: string, text: string, report: Report): void {
  for (const [index, line] of splitlines(text).entries())
    for (const [char, name] of [["\u2014", "em dash"], ["\u2013", "en dash"]])
      if (line.includes(char!)) report(path, index + 1, name!);
}

function checkDeliveryRestatements(root: string, path: string, text: string, report: Report): void {
  const local = relative(root, path);
  if (deliverySkipFiles.has(local) || deliverySkipDirs.some((directory) => local.startsWith(directory))) return;

  let plansTail = false;
  for (const [index, line] of splitlines(text).entries()) {
    if (local === "skills/plans/SKILL.md" && line.startsWith("## ")) plansTail = /^## \/plans (?:do|review)(?![\p{L}\p{N}_])/u.test(line);
    if (plansTail) continue;

    for (const sentence of line.split(new RegExp(`(?<=[.;:])${space}+`, "u")))
      if (deliveryRestatement.test(sentence) && !deliveryDelegate.test(sentence)) {
        report(path, index + 1, "restates the owner delivery rule, point at references/delivery.md");
        break;
      }
  }
}

export function commandHead(command: string, bracketAlternatives = false, descriptionColumn = false): string {
  let quote: string | undefined;
  let brackets = 0;
  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    if (char === "\\" && quote !== "'") {
      index++;
      continue;
    }

    if (quote) {
      if (char === quote) quote = undefined;
    } else if (bracketAlternatives && char === "[") brackets++;
    else if (bracketAlternatives && char === "]") brackets = Math.max(0, brackets - 1);
    else if (descriptionColumn && index > 0 && /\S/u.test(command[index - 1]!) && command.slice(index).startsWith("  ")) return command.slice(0, index);
    else if (commandEnd.test(command.slice(index)) && !(brackets > 0 && new RegExp(`^${space}\\|${space}`, "u").test(command.slice(index)))) return command.slice(0, index);
    else if (char === '"' || char === "'") quote = char;
  }

  return command;
}

function* codexCommands(text: string, pattern: RegExp): Generator<Invocation> {
  const lines = splitlines(text);
  for (let index = 0; index < lines.length; index++) {
    let last = index;
    for (const match of lines[index]!.matchAll(pattern)) {
      let command = lines[index]!.slice(match.index);
      let next = index;
      while (pyRstrip(command).endsWith("\\") && next + 1 < lines.length) command = `${pyRstrip(command).slice(0, -1)} ${lines[++next]}`;
      last = Math.max(last, next);

      try {
        yield { line: index + 1, start: match.index, tokens: shlex(commandHead(command)) };
      } catch {
        continue;
      }
    }

    index = last;
  }
}

function flagKnown(flag: string, help: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[${PY_SPACE},])${escaped}([${PY_SPACE},=<]|$)`, "mu").test(help);
}

function codexHelp(sub: string): string | ReadFailure {
  const cached = helpCache.get(sub);
  if (cached !== undefined) return cached;

  const result = readSync(["codex", ...(sub ? [sub] : []), "--help"], { deadline: 5000 });
  const help = result.ok ? textMode(result.bytes) + result.stderr : result.failure;
  helpCache.set(sub, help);

  return help;
}

function checkCodex(path: string, text: string, report: Report): void {
  if (helpFailureReported || !Bun.which("codex")) return;

  for (const { line, tokens } of codexCommands(text, codexLine)) {
    let sub = "";
    for (const token of tokens.slice(1)) {
      if ((token === "exec" || token === "review") && !sub) {
        sub = token;
        continue;
      }

      if (!token.startsWith("-") || token === "-" || token === "--") continue;

      const flag = token.split("=")[0]!;
      const help = codexHelp(sub);
      if (typeof help !== "string") {
        helpFailureReported = true;
        report(path, line, describe(help));
        return;
      }

      if (!flagKnown(flag, help)) report(path, line, `${sub ? `codex ${sub}` : "codex (global)"} does not accept ${flag}`);
    }
  }
}

function configValue(tokens: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return tokens.find((token) => token.startsWith(prefix))?.slice(prefix.length).replace(/^["']+|["']+$/g, "");
}

function codexSubcommand(tokens: string[]): string | undefined {
  if (tokens.length < 2 || (!tokens[1]!.startsWith("-") && tokens[1] !== "exec" && tokens[1] !== "review")) return;
  return tokens.slice(1).find((token) => token === "exec" || token === "review");
}

function codexModel(tokens: string[]): string | undefined {
  for (const [index, token] of tokens.entries())
    if ((token === "-m" || token === "--model") && index + 1 < tokens.length) return tokens[index + 1];

  return configValue(tokens, "model");
}

function codexSandbox(tokens: string[]): string | undefined {
  for (const [index, token] of tokens.entries()) {
    if ((token === "-s" || token === "--sandbox") && index + 1 < tokens.length) return tokens[index + 1];
    if (token.startsWith("--sandbox=")) return token.slice("--sandbox=".length);
  }

  return;
}

function checkCodexHooks(path: string, text: string, report: Report): void {
  const lines = splitlines(text);
  for (const { line, start, tokens } of codexCommands(text, codexInvocation)) {
    if (codexSubcommand(tokens) !== "exec") continue;

    let before = lines[line - 1]!.slice(0, start);
    if (line >= 2 && !pyStrip(before) && pyRstrip(lines[line - 2]!).endsWith("\\")) before = `${pyRstrip(lines[line - 2]!).slice(0, -1)} `;

    const prefix = hooksOffPrefix.test(before);
    const sandbox = codexSandbox(tokens);
    if (sandbox === undefined) report(path, line, "codex exec invocation does not pin its sandbox with -s");
    if (sandbox === "read-only" && !prefix) report(path, line, "codex exec read-only invocation lacks the AGENT_HOOKS=0 prefix");
    if (sandbox === "workspace-write" && prefix) report(path, line, "codex exec workspace-write invocation carries AGENT_HOOKS=0, which turns its edit hooks off");
  }
}

function tableCells(line: string): string[] {
  return line.split("|").slice(1, -1).map((cell) => cell.replace(/^[ `]+|[ `]+$/g, ""));
}

function codexEfforts(root: string, report: Report): Efforts | undefined {
  const path = join(root, "skills/playbook/references/codex-arms.md");
  if (!isFile(path)) {
    report(path, 0, "reference file is missing");
    return;
  }

  const text = readText(path);
  const lines = splitlines(text);
  const header = lines.findIndex((line) => JSON.stringify(tableCells(line)) === JSON.stringify(["tier", "-m", "effort", "use"]));
  if (header === -1) {
    report(path, 0, "tier effort table is missing");
    return;
  }

  const models = new Map<string, Set<string>>();
  for (let index = header + 2; index < lines.length; index++) {
    const line = lines[index]!;
    if (!line.startsWith("|")) break;

    const cells = tableCells(line);
    if (cells.length < 4) {
      report(path, index + 1, "tier effort row needs four cells");
      continue;
    }

    const model = cells[1]!;
    const effort = cells[2]!;
    const expected = models.get(model) ?? new Set<string>();
    expected.add(effort);
    models.set(model, expected);
  }

  for (const { tokens } of codexCommands(text, codexInvocation))
    if (codexSubcommand(tokens) === "review") {
      const review = configValue(tokens, "model_reasoning_effort");
      if (review !== undefined) return { models, review };
    }

  report(path, 0, "review effort is missing");
  return;
}

function checkCodexEffort(path: string, text: string, efforts: Efforts, report: Report): void {
  for (const { line, tokens } of codexCommands(text, codexInvocation)) {
    const sub = codexSubcommand(tokens);
    if (sub === undefined) continue;

    const effort = configValue(tokens, "model_reasoning_effort");
    if (effort === undefined) {
      report(path, line, `codex ${sub} invocation does not pin model_reasoning_effort`);
      continue;
    }

    const model = codexModel(tokens);
    const expected = (model === undefined ? undefined : efforts.models.get(model)) ?? (sub === "review" && model === undefined ? new Set([efforts.review]) : undefined);
    if (expected && !expected.has(effort)) report(path, line, `codex ${sub} invocation pins ${effort}, but ${model || "review"} requires ${[...expected].sort(codePointOrder).join(" or ")}`);
  }
}

function checkCommand(command: string, verbs: readonly Verb[], fenced: boolean): string[] {
  let tokens: string[];
  try {
    tokens = shlex(commandHead(command, true, fenced));
  } catch {
    return [];
  }

  while (tokens[0] === "--help" || tokens[0] === "--root" || tokens[0]?.startsWith("--root=")) tokens = tokens.slice(tokens[0] === "--root" ? 2 : 1);

  const words: string[] = [];
  for (const token of tokens) {
    if (!/^[a-z][a-z-]*$/.test(token)) break;
    words.push(token);
  }

  if (words.length === 0) return [];

  const matches = verbs.filter((verb) => verb.name.every((part, index) => part === words[index])).sort((left, right) => right.name.length - left.name.length);
  const matched = matches[0];
  const namespace = verbs.filter((verb) => words.every((part, index) => part === verb.name[index]));
  if (!matched && namespace.length === 0) return [`unknown verb skills ${words.join(" ")}`];

  const name = matched ? matched.name.join(" ") : words.join(" ");
  const usage = matched ? matched.usage : namespace.map((verb) => verb.usage).join("\n");
  const flagUsage = usage.replace(/[\[()\]|]/g, " ");

  const errors: string[] = [];
  for (const token of tokens.slice(matched ? matched.name.length : words.length))
    for (const part of token.replace(/[\[()\],]/g, "").split("|")) {
      const flag = part.split("=")[0]!;
      if (flag === "--") return errors;
      if (flag.startsWith("-") && flag !== "-" && flag !== "--help" && !flagKnown(flag, flagUsage))
        errors.push(`skills ${name} does not accept ${flag}`);
    }

  return errors;
}

export function checkCommands(text: string, verbs: readonly Verb[]): { line: number; message: string }[] {
  const errors: { line: number; message: string }[] = [];
  const lines = splitlines(text);

  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const marker = line.match(/^\s*(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (fence === undefined) fence = marker[1]!;
      else if (marker[1]![0] === fence[0] && marker[1]!.length >= fence.length && pyStrip(marker[2]!) === "") fence = undefined;

      continue;
    }

    const starts: { start: number; command: string }[] = [];
    const bare = fence === undefined ? null : line.match(/^\s*skills ([a-z][^\n]*)/u);
    if (bare) starts.push({ start: line.indexOf("skills "), command: bare[1]! });

    for (const match of line.matchAll(/`skills ([a-z][^`\n]*)(?:`|(?<=\\)$)/gu))
      if ((line.slice(0, match.index).match(/`/g)?.length ?? 0) % 2 === 0) starts.push({ start: match.index, command: match[1]! });

    for (const match of line.matchAll(/(^|[\s`("])(?:["'](?:<[^>]+>|[^\s`"'])*bin\/skills["']|(?:<[^>]+>|[^\s`"'])*?bin\/skills)(?=\s|`|$)/gu)) {
      const position = match.index + match[1]!.length;
      const quoted = line[position - 1] === '"';
      const inline = (line.slice(0, position).match(/`/g)?.length ?? 0) % 2 === 1;
      if (!fence && !inline && !quoted && line[position] !== '"') continue;

      let command = line.slice(match.index + match[0].length);
      if (quoted) command = command.split('"', 1)[0]!;

      starts.push({ start: position, command });
    }

    let last = index;
    for (const start of starts.sort((left, right) => left.start - right.start)) {
      let command = start.command;
      let next = index;
      while (pyRstrip(command).endsWith("\\") && next + 1 < lines.length) command = `${pyRstrip(pyRstrip(command).slice(0, -1))} ${pyStrip(lines[++next]!)}`;
      last = Math.max(last, next);

      for (const message of checkCommand(command, verbs, fence !== undefined)) errors.push({ line: index + 1, message });
    }

    index = last;
  }

  return errors;
}

function checkScriptPaths(root: string, path: string, text: string, report: Report): void {
  for (const [index, line] of splitlines(text).entries())
    for (const match of line.matchAll(/(<[^>]+>|~\/\.agents\/skills)\/[^\s`"'(),;<>]+?\.(?:sh|py)(?![\p{L}\p{N}_\/]|\.[\p{L}\p{N}_\/])/gu)) {
      const ref = match[0];
      const base = match[1];
      const directory = base === "<skill>" ? skillRoot(root, path) : base === "<playbook>" ? join(root, "skills/playbook") : base === "~/.agents/skills" ? join(root, "skills") : ["<skills checkout>", "<repo>", "<root>"].includes(base!) ? root : undefined;
      if (directory === undefined) continue;

      const target = resolve(directory, ref.slice(base!.length + 1));
      if (existsSync(target)) continue;

      const verb = retiredScripts.get(basename(target));
      report(path, index + 1, `script ${ref} does not exist${verb ? `, ported to skills ${verb}` : ""}`);
    }
}

export function check(root: string, registry: Registry): string[] {
  root = resolve(root);
  helpFailureReported = false;
  for (const [sub, help] of helpCache) if (typeof help !== "string") helpCache.delete(sub);

  const errors: string[] = [];
  const report: Report = (path, line, message) => {
    errors.push(`${relative(root, path)}:${line ? `${line}:` : ""} ${message}`);
  };

  checkSkills(root, report);
  const known = agentNames(root, report);
  const efforts = codexEfforts(root, report);
  for (const path of markdownFiles(root)) {
    const text = readText(path);
    checkPaths(root, path, text, report);
    checkAgents(path, text, known, report);
    checkDashes(path, text, report);
    checkDeliveryRestatements(root, path, text, report);

    checkCodex(path, text, report);
    checkCodexHooks(path, text, report);
    if (efforts) checkCodexEffort(path, text, efforts, report);
    for (const { line, message } of checkCommands(text, registry.verbs)) report(path, line, message);
    checkScriptPaths(root, path, text, report);
  }

  for (const path of walk(join(root, "evals"), [".md"]))
    for (const { line, message } of checkCommands(readText(path), registry.verbs)) report(path, line, message);

  return errors;
}
