import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

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

  return writeOwned(configDir, "plugins/skills.ts", pluginStub(path));
}
