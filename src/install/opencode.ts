import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFrontmatter } from "../frontmatter.ts";

type Manifest = { kind: "valid"; files: Record<string, string> } | { kind: "invalid" };

export function opencodeConfigDir(env: NodeJS.ProcessEnv, home: string): string {
  return env.OPENCODE_CONFIG_DIR || join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode");
}

function hash(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function readManifest(configDir: string): Manifest {
  const path = join(configDir, ".skills-install.json");
  try {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) return { kind: "valid", files: {} };
    if (!entry.isFile()) return { kind: "invalid" };

    const value = JSON.parse(readFileSync(path, "utf8"));
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length !== 1 ||
      value.files === null ||
      typeof value.files !== "object" ||
      Array.isArray(value.files) ||
      Object.values(value.files).some(
        (digest) => typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest),
      )
    )
      return { kind: "invalid" };

    return { kind: "valid", files: value.files };
  } catch {
    return { kind: "invalid" };
  }
}

export function ownedFile(
  configDir: string,
  relativePath: string,
  manifest = readManifest(configDir),
): boolean {
  if (manifest.kind !== "valid" || !Object.hasOwn(manifest.files, relativePath)) return false;

  try {
    const path = join(configDir, relativePath);
    return lstatSync(path).isFile() && hash(readFileSync(path)) === manifest.files[relativePath];
  } catch {
    return false;
  }
}

function recordFile(configDir: string, files: Record<string, string>): void {
  const path = join(configDir, ".skills-install.json");
  const temporary = `${path}.${randomUUID()}.tmp`;
  const sorted = Object.fromEntries(
    Object.entries(files).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );

  try {
    writeFileSync(temporary, JSON.stringify({ files: sorted }, null, 2) + "\n", { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function forgetFile(configDir: string, relativePath: string): void {
  const manifest = readManifest(configDir);
  if (manifest.kind !== "valid") return;

  delete manifest.files[relativePath];
  recordFile(configDir, manifest.files);
}

const toolActions: Readonly<Record<string, string>> = {
  Read: "read",
  Grep: "grep",
  Glob: "glob",
  Bash: "shell",
  Edit: "edit",
  Write: "edit",
  NotebookEdit: "edit",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  Task: "subagent",
  Agent: "subagent",
  Skill: "skill",
};

const sourceKeys = new Set(["name", "description", "model", "effort", "tools"]);
function agentContent(text: string): string {
  const frontmatter = readFrontmatter(text, Bun.YAML.parse);
  if (frontmatter.kind !== "mapping") throw new Error(`frontmatter is ${frontmatter.kind}`);

  const data = frontmatter.data;
  for (const key of Object.keys(data))
    if (!sourceKeys.has(key)) throw new Error(`unsupported key ${key}`);

  if (typeof data.description !== "string") throw new Error("description must be a string");

  const rows = ["---", `description: ${JSON.stringify(data.description)}`, "mode: subagent"];
  if (Object.hasOwn(data, "tools")) {
    if (typeof data.tools !== "string") throw new Error("tools must be a string");

    const actions = new Set<string>();
    for (const tool of data.tools.split(",").map((name) => name.trim())) {
      if (!Object.hasOwn(toolActions, tool)) throw new Error(`unsupported tool ${tool}`);
      actions.add(toolActions[tool]!);
    }

    rows.push("permissions:", '  - action: "*"', '    resource: "*"', "    effect: deny");

    for (const action of actions)
      rows.push(`  - action: ${action}`, '    resource: "*"', "    effect: allow");
  }

  const header = /^---\r?\n[\s\S]*?^---(?:\r?\n|$)/m.exec(text)!;
  return rows.join("\n") + "\n---\n" + text.slice(header[0].length);
}

export function installOpenCodeAgents(configDir: string, repo: string): string[] {
  const source = join(repo, "agents");
  const output: string[] = [];
  const manifest = readManifest(configDir);
  if (manifest.kind === "valid")
    for (const relativePath of Object.keys(manifest.files).sort()) {
      if (!/^agents\/[^/]+\.md$/.test(relativePath) || existsSync(join(repo, relativePath)))
        continue;

      const path = join(configDir, relativePath);
      if (ownedFile(configDir, relativePath, manifest)) {
        try {
          rmSync(path);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          output.push(`skip   ${basename(path)} (${path} could not be removed: ${reason})`);
          continue;
        }

        output.push(`prune  ${basename(path, ".md")}`);
      } else if (lstatSync(path, { throwIfNoEntry: false }))
        output.push(`skip   ${basename(path)} (${path} is personal, left in place)`);

      forgetFile(configDir, relativePath);
    }

  for (const file of existsSync(source) ? readdirSync(source).sort() : []) {
    if (!file.endsWith(".md")) continue;

    try {
      const content = agentContent(readFileSync(join(source, file), "utf8"));
      output.push(...writeOwned(configDir, `agents/${file}`, content));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      output.push(`skip   ${file} (${reason})`);
    }
  }

  return output;
}

function replaceFile(path: string, content: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, content, { flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeOwned(configDir: string, relativePath: string, content: string): string[] {
  const path = join(configDir, relativePath);
  const manifest = readManifest(configDir);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  const current = entry?.isFile() && readFileSync(path, "utf8") === content;
  if (entry && !current && !ownedFile(configDir, relativePath, manifest))
    return [
      `skip   ${basename(path)} (${path} is not a file this installer placed, left in place)`,
    ];

  if (manifest.kind === "invalid")
    return [
      `skip   ${basename(path)} (${join(configDir, ".skills-install.json")} is unreadable or invalid, left in place)`,
    ];

  const recorded = manifest.files[relativePath] === hash(content);
  if (current && recorded) return [];

  if (!current) {
    mkdirSync(dirname(path), { recursive: true });
    replaceFile(path, content);
  }

  recordFile(configDir, { ...manifest.files, [relativePath]: hash(content) });

  return current ? [] : [`opencode ${path}`];
}

function pluginStub(path: string): string {
  const reason = `Blocked: the skills plugin could not load ${path}, so every shell command stays blocked. Fix the checkout or rerun ./install.sh.`;
  return [
    "let plugin;",
    'let failure = "its default export is not a plugin";',
    "try {",
    `  plugin = (await import(${JSON.stringify(pathToFileURL(path).href)})).default;`,
    "} catch (error) {",
    "  failure = error instanceof Error ? error.message : String(error);",
    "}",
    "",
    'if (typeof plugin?.setup !== "function")',
    "  plugin = {",
    '    id: "skills-guard",',
    "    async setup(ctx: { tool: { hook(name: string, callback: (event: { tool: string; input: unknown }) => Promise<void>): Promise<unknown> } }) {",
    '      await ctx.tool.hook("execute.before", async (event) => {',
    '        const input = event.input !== null && typeof event.input === "object" ? event.input as Record<string, unknown> : {};',
    '        if (event.tool === "shell" || typeof input.command === "string")',
    `          throw new Error(${JSON.stringify(reason + " Cause: ")} + failure);`,
    "      });",
    "    },",
    "  };",
    "",
    "export default plugin;",
    "",
  ].join("\n");
}

export function installOpenCodePlugin(configDir: string, agents: string): string[] {
  const path = join(agents, "playbook/opencode/plugin.ts");
  if (!statSync(path, { throwIfNoEntry: false })?.isFile())
    return [`skip   skills.ts (${path} is missing, no OpenCode plugin written)`];

  try {
    return writeOwned(configDir, "plugins/skills.ts", pluginStub(path));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return [
      `skip   skills.ts (${join(configDir, "plugins/skills.ts")} could not be written: ${reason})`,
    ];
  }
}
