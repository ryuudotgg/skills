import { semver } from "bun";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join, normalize, resolve } from "node:path";
import packageInfo from "../../package.json";
import {
  confIn,
  extensionVerdict,
  deliveryFrom,
  readDeliveryConfig,
  rewriteDelivery,
  type DeliveryConfig,
  type DeliveryMode,
} from "../delivery.ts";
import { readRuleGroups } from "../deny-set.ts";
import type { Context } from "../registry.ts";
import { applyClaudeRules } from "./claude-rules.ts";
import { writeCodexHooks } from "./codex-hooks.ts";
import { claudeBlock, retired } from "./hook-table.ts";
import {
  history,
  isDirectory,
  isFile,
  ownedLink,
  placeAgent,
  removeOwned,
  runsCheckout,
  sameFile,
} from "./files.ts";
import { parseJson } from "./json.ts";
import { resolveTarget, writeAtomic } from "./settings-file.ts";

export type Choices = { with: string[]; without: string[] };
type Environment = {
  home: string;
  agents: string;
  claude: string;
  claudeConfig: string;
  claudeState: string;
  codex: string;
  conf: string;
  seeds: string[];
  extras: string[];
};

function parseChoices(args: readonly string[]): Choices | undefined {
  const result: Choices = { with: [], without: [] };
  for (let index = 0; index < args.length; index++) {
    const match = args[index]?.match(/^--(with|without)(?:=(.*))?$/);
    if (!match) return undefined;

    const value = match[2] ?? args[++index];
    if (!value) return undefined;

    result[match[1] === "with" ? "with" : "without"].push(...value.split(/\s+/).filter(Boolean));
  }

  return result;
}

function normalizePath(path: string): string {
  return path ? normalize(path).replace(/(.)\/$/, "$1") : path;
}

function resolvedPath(path: string): string {
  return existsSync(path) ? realpathSync(path) : normalizePath(path);
}

function environment(env: NodeJS.ProcessEnv): Environment {
  const home = normalizePath(env.HOME ?? "");
  const claude = normalizePath(env.CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || `${home}/.claude`);
  const split = (value: string) => value.split(/\s+/).filter(Boolean);
  return {
    home,
    claude,
    claudeConfig: normalizePath(env.CLAUDE_CONFIG_DIR || `${home}/.claude`),
    claudeState: env.CLAUDE_CONFIG_DIR
      ? join(normalizePath(env.CLAUDE_CONFIG_DIR), ".claude.json")
      : join(home, ".claude.json"),
    agents: normalizePath(env.AGENTS_DIR || `${home}/.agents/skills`),
    codex: normalizePath(env.CODEX_HOME || `${home}/.codex`),
    conf: env.SKILLS_CONF || confIn(home),
    seeds: env.SEED_DIRS ? split(env.SEED_DIRS) : [`${claude}/skills`, `${home}/.codex/skills`],
    extras: split(
      env.EXTRA_DIRS ||
        `${home}/.cursor/skills ${home}/.config/opencode/skills ${home}/.copilot/skills`,
    ),
  };
}

function validateChoices(choices: Choices): void {
  for (const name of [...choices.with, ...choices.without])
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name))
      throw new Error(`install.sh: no optional skill named ${name}`);

  for (const name of choices.with)
    if (choices.without.includes(name))
      throw new Error(`install.sh: ${name} is in both --with and --without`);
}

function nextConfig(
  root: string,
  config: DeliveryConfig,
  choices: Choices,
): { mode: DeliveryMode; names: string[] } {
  const optional = (name: string) =>
    ["none", "prs"].includes(extensionVerdict(join(root, name, "SKILL.md")));

  const noSuch = (name: string): never => {
    throw new Error(`install.sh: no optional skill named ${name}`);
  };

  const requested = choices.with.filter((name) => name !== "prs");
  for (const name of requested) if (!optional(name)) noSuch(name);

  for (const name of choices.without)
    if (name !== "prs" && !optional(name) && !config.names.includes(name)) noSuch(name);

  const names = [...new Set([...config.names, ...requested])].filter(
    (name) => !choices.without.includes(name),
  );

  let mode = config.mode;
  if (choices.with.includes("prs")) mode = "prs";
  if (choices.without.includes("prs")) mode = "hands-off";
  if (
    !choices.without.includes("prs") &&
    requested.some((name) => extensionVerdict(join(root, name, "SKILL.md")) === "prs")
  )
    mode = "prs";

  if ((choices.with.length || choices.without.length) && mode === "hands-off")
    for (const name of names)
      if (extensionVerdict(join(root, name, "SKILL.md")) === "prs")
        throw new Error(
          `install.sh: ${name} requires prs mode, so hands-off needs --without ${name} too`,
        );

  return { mode, names };
}

function checkRuleTable(root: string): void {
  try {
    readRuleGroups(root);
  } catch (error) {
    const reason =
      error instanceof Error ? error.message.replace(/^deny-set:/, "deny-set.sh:") : String(error);

    throw new Error(`${reason}\ninstall.sh: deny set reader failed`);
  }
}

function link(target: string, path: string, agents: string, output: (line: string) => void): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry?.isSymbolicLink() && ownedLink(path, agents)) unlinkSync(path);
  else if (entry) {
    output(
      `skip   ${basename(path)} (${path} is not a link to this repository's store, left in place)`,
    );

    return;
  }

  symlinkSync(target, path);
}

async function installAgents(
  repo: string,
  claude: string,
  versions: Awaited<ReturnType<typeof history>>,
  output: (line: string) => void,
): Promise<void> {
  const directory = join(claude, "agents");
  mkdirSync(directory, { recursive: true });
  output("");

  for (const path of await versions.deleted("agents/*.md")) {
    if (isFile(join(repo, path))) continue;

    const name = basename(path, ".md");
    const dest = join(directory, basename(path));
    const entry = lstatSync(dest, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) output(`skip   ${name} (${dest} is a link, left in place)`);
    else if (entry?.isFile() && (await versions.shipped(path, dest))) {
      unlinkSync(dest);
      output(`prune  ${name}`);
    } else if (entry) output(`skip   ${name} (${dest} ${versions.unmatched}, left in place)`);
  }

  for (const file of readdirSync(join(repo, "agents"))
    .filter((name) => name.endsWith(".md"))
    .sort()) {
    const source = join(repo, "agents", file);
    if (!isFile(source)) continue;

    const name = basename(file, ".md");
    const dest = join(directory, file);
    if (lstatSync(dest, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(dest))
      output(
        `skip   ${name} (${dest} could not be written, so the repo's ${name} agent was not installed)`,
      );
    else if (!existsSync(dest) || (await versions.shipped(`agents/${file}`, dest)))
      if (sameFile(source, dest) || placeAgent(source, dest)) output(`agent  ${name}`);
      else
        output(
          `skip   ${name} (${dest} could not be written, so the repo's ${name} agent was not installed)`,
        );
    else
      output(
        `skip   ${name} (${dest} ${versions.unmatched}, so the repo's ${name} agent was not installed)`,
      );
  }

  const settings = join(claude, "settings.json");
  if (!isFile(settings)) return;

  let content: string;
  try {
    content = readFileSync(settings, "utf8");
  } catch {
    return;
  }

  const names = [...new Set(content.match(/\/hooks\/[A-Za-z0-9_.-]+\.sh/g) ?? [])]
    .map((path) => basename(path))
    .sort();

  for (const name of names)
    if (
      existsSync(join(claude, "hooks", name)) &&
      (await versions.shipped(`hooks/${name}`, join(claude, "hooks", name)))
    )
      output(
        `stale  ${name} still runs from ${settings}. Replace it with its skills hook command: https://skills.ryuu.gg/agents/claude-code`,
      );
}

function referencesCopies(
  value: unknown,
  directories: readonly string[],
  names: readonly string[],
): boolean {
  if (Array.isArray(value))
    return value.some((entry) => referencesCopies(entry, directories, names));

  if (!value || typeof value !== "object") return false;

  for (const [key, entry] of Object.entries(value)) {
    if (key === "command" && typeof entry === "string") {
      const command = entry.replaceAll(/\/+/g, "/");
      if (names.some((name) => command.includes(name))) return true;
      if (directories.some((directory) => command.includes(directory))) return true;
    }

    if (referencesCopies(entry, directories, names)) return true;
  }

  return false;
}

async function pruneHooks(
  repo: string,
  env: Environment,
  versions: Awaited<ReturnType<typeof history>>,
  output: (line: string) => void,
): Promise<void> {
  const directory = join(env.claude, "hooks");
  if (!isDirectory(directory)) return;

  const names = readdirSync(directory);
  const directories = [directory, realpathSync(directory), "/.claude/hooks"];
  const read = (path: string) =>
    parseJson(new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)));

  const registrations = [
    join(env.claude, "settings.json"),
    join(env.claude, "settings.local.json"),
    join(env.claudeConfig, "settings.json"),
    join(env.claudeConfig, "settings.local.json"),
    join(env.codex, "hooks.json"),
  ];

  try {
    if (lstatSync(env.claudeState, { throwIfNoEntry: false })) {
      const projects = (read(env.claudeState) as { projects?: unknown }).projects;
      if (projects !== undefined && (!projects || typeof projects !== "object")) return;

      for (const project of Object.keys(projects ?? {}))
        registrations.push(
          join(project, ".claude/settings.json"),
          join(project, ".claude/settings.local.json"),
        );
    }
  } catch {
    return;
  }

  for (const path of registrations) {
    try {
      if (!lstatSync(path, { throwIfNoEntry: false })) continue;
      if (!isFile(path) || referencesCopies(read(path), directories, names)) return;
    } catch {
      return;
    }
  }

  const deleted = new Set(await versions.deleted("hooks/*"));
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const entry = lstatSync(path);
    if (
      entry.isFile() &&
      deleted.has(`hooks/${name}`) &&
      !existsSync(join(repo, "hooks", name)) &&
      (await versions.shipped(`hooks/${name}`, path))
    ) {
      unlinkSync(path);
      output(`prune  ${name}`);
    } else if (entry.isSymbolicLink()) output(`skip   ${name} (${path} is a link, left in place)`);
    else output(`skip   ${name} (${path} ${versions.unmatched}, left in place)`);
  }
}

export async function installVerb(args: readonly string[], ctx: Context): Promise<number> {
  const output = (line: string) => {
    process.stdout.write(`${line}\n`);
  };

  if (!semver.satisfies(Bun.version, packageInfo.engines.bun)) {
    process.stderr.write(
      `install.sh: Bun ${packageInfo.engines.bun} required, found ${Bun.version}\n`,
    );

    return 1;
  }

  let choices = parseChoices(args);
  if (!choices) {
    process.stderr.write("usage: install.sh [--with <name>]... [--without <name>]...\n");
    return 2;
  }

  const env = environment(process.env);
  if (!env.conf.startsWith("/"))
    throw new Error(`install.sh: SKILLS_CONF must be an absolute path, got ${env.conf}`);

  validateChoices(choices);

  const config = readDeliveryConfig({ ...process.env, SKILLS_CONF: env.conf });
  const interactive =
    !args.length && process.stdin.isTTY && process.stdout.isTTY && process.env.CI === undefined;

  if (config.invalid && (args.length || interactive))
    throw new Error(
      `install.sh: ${env.conf} is invalid, fix or remove it before passing --with or --without`,
    );

  const root = ctx.root;
  const repo = dirname(root);
  const denyValues = {
    claude: resolve(env.claudeConfig),
    agents: resolve(env.agents),
    conf: resolve(env.conf),
    codex: resolve(env.codex),
    checkout: resolve(repo),
  };

  if (interactive) {
    const { promptChoices } = await import("./interactive.ts");
    const selected = await promptChoices(root, config);
    if (!selected) return 1;

    choices = selected;
  }

  const next = nextConfig(root, config, choices);

  mkdirSync(env.agents, { recursive: true });
  const tools: string[] = [];
  for (const path of env.seeds) {
    if (!isDirectory(dirname(path))) continue;
    mkdirSync(path, { recursive: true });
    tools.push(path);
  }

  tools.push(...env.extras.filter(isDirectory));
  checkRuleTable(root);

  if (
    (choices.with.length || choices.without.length) &&
    (next.mode !== config.mode || next.names.join(" ") !== config.names.join(" "))
  ) {
    mkdirSync(dirname(env.conf), { recursive: true });
    const target = resolveTarget(env.conf);
    const stats = statSync(target, { throwIfNoEntry: false });
    if (stats && stats.nlink > 1)
      throw new Error(
        `install.sh: ${env.conf} has hard links a rewrite would split, so the delivery change was not written`,
      );

    try {
      accessSync(dirname(target), constants.W_OK);
    } catch {
      throw new Error(
        `install.sh: ${dirname(target)} is not writable, so ${env.conf} cannot be replaced and the delivery change was not written`,
      );
    }

    const mode = stats ? stats.mode & 0o7777 : 0o666 & ~process.umask();
    writeAtomic(target, rewriteDelivery(config, next.mode, next.names), mode);
    output(`config ${env.conf}`);
  }

  const deliveryConfig = readDeliveryConfig({ ...process.env, SKILLS_CONF: env.conf });
  const delivery = deliveryFrom(root, deliveryConfig);
  for (const note of delivery.notes) process.stderr.write(`delivery-mode: ${note}\n`);

  output(`mode   ${delivery.mode}`);
  for (const name of delivery.active) output(`with   ${name}`);

  if (process.env.CLAUDE_HOME && resolvedPath(env.claude) !== resolvedPath(env.claudeConfig))
    output(
      `warn   ${env.claude} (CLAUDE_HOME is not where Claude Code reads its config, which is ${env.claudeConfig})`,
    );

  output("");

  for (const directory of [env.agents, ...tools])
    for (const name of readdirSync(directory)
      .filter((name) => !name.startsWith("."))
      .sort()) {
      const path = join(directory, name);
      if (!existsSync(path) && removeOwned(path, env.agents)) output(`prune  ${name}`);
    }

  for (const name of readdirSync(root)
    .filter((name) => !name.startsWith(".") && isDirectory(join(root, name)))
    .sort()) {
    const path = join(env.agents, name);
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && !entry.isSymbolicLink()) {
      output(`skip   ${name} (${path} exists and is not a link)`);
      continue;
    }

    if (entry?.isSymbolicLink() && !ownedLink(path, env.agents)) {
      const target = readlinkSync(path);
      output(
        existsSync(path)
          ? `skip   ${name} (${path} links to ${target}, not a checkout of this repository, so the repo's ${name} skill was not linked)`
          : `skip   ${name} (${path} links to ${target}, which is gone, so the repo's ${name} skill was not linked; remove the link and rerun to relink it)`,
      );

      continue;
    }

    if (
      extensionVerdict(join(root, name, "SKILL.md")) !== "not-extension" &&
      !delivery.active.includes(name)
    ) {
      let removed = false;
      for (const directory of [env.agents, ...tools])
        removed = removeOwned(join(directory, name), env.agents) || removed;

      output(`${removed ? "unlink" : "off   "} ${name}`);
      continue;
    }

    link(join(root, name), path, env.agents, output);
    for (const directory of tools) link(path, join(directory, name), env.agents, output);
    output(`skill  ${name}`);
  }

  output("");
  for (const directory of tools) output(`linked into ${directory}`);
  const versions = await history(repo);
  if (isDirectory(env.claude)) {
    await installAgents(repo, env.claude, versions, output);

    for (const line of applyClaudeRules({
      root,
      mode: delivery.mode,
      config: deliveryConfig,
      home: env.home,
      path: join(env.claude, "settings.json"),
      current: denyValues,
      env: process.env,
      stdin: process.stdin,
      stdout: process.stdout,
    }))
      output(line);

    output("");
    output("Done. Paste the Claude Code hooks block: https://skills.ryuu.gg/agents/claude-code");
    const agents = env.agents === `${env.home}/.agents/skills` ? "~/.agents/skills" : env.agents;
    output(claudeBlock(agents));
  } else {
    output("");
    output(
      "Done. No Claude Code install found, so agents and the Claude hooks block were skipped.",
    );
  }

  if (isDirectory(env.codex)) {
    const personal: string[] = [];
    for (const [name] of retired)
      if (
        existsSync(join(env.claude, "hooks", name)) &&
        !(await versions.shipped(`hooks/${name}`, join(env.claude, "hooks", name)))
      )
        personal.push(name);

    const bun =
      Bun.which("bun", { PATH: process.env.PATH }) ||
      [join(env.home, ".bun/bin/bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find((path) =>
        Bun.which(path),
      );

    process.stdout.write(
      writeCodexHooks(join(env.codex, "hooks.json"), join(env.claude, "hooks"), env.agents, {
        personal,
        noCli: !runsCheckout(join(env.agents, "playbook"), join(root, "playbook")),
        noBun: !bun,
      }),
    );
  }

  await pruneHooks(repo, env, versions, output);

  return 0;
}
