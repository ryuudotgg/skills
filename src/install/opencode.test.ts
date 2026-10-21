import { afterEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFrontmatter } from "../frontmatter.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import {
  installOpenCodeAgents,
  installOpenCodePlugin,
  opencodeConfigDir,
  ownedFile,
  readManifest,
  writeOwned,
} from "./opencode.ts";

const repo = resolve(import.meta.dir, "../..");
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(join(tmpdir(), "skills-install-opencode-"));
  directories.push(home);
  const agents = join(home, ".agents/skills");
  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    HOME: home,
    AGENTS_DIR: agents,
    SKILLS_CONF: join(home, "skills.conf"),
    CLAUDE_HOME: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    SEED_DIRS: join(home, "seed"),
    EXTRA_DIRS: join(home, "extra"),
  };

  delete env.OPENCODE_CONFIG_DIR;
  delete env.XDG_CONFIG_HOME;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.CI;

  return { home, agents, env, config: join(home, ".config/opencode") };
}

function install(value: ReturnType<typeof fixture>) {
  return runCommand(
    [
      process.execPath,
      "--no-env-file",
      join(repo, "src/cli.ts"),
      "--root",
      join(repo, "skills"),
      "install",
    ],
    { cwd: repo, env: value.env },
  );
}

test.each(["default", "xdg", "override"])(
  "installer writes the stub and manifest into the %s config dir",
  async (mode) => {
    const value = fixture();
    value.env.XDG_CONFIG_HOME = mode === "default" ? "" : join(value.home, "xdg");
    value.env.OPENCODE_CONFIG_DIR = mode === "override" ? join(value.home, "override") : "";
    const config =
      mode === "override"
        ? value.env.OPENCODE_CONFIG_DIR!
        : mode === "xdg"
          ? join(value.env.XDG_CONFIG_HOME!, "opencode")
          : value.config;

    mkdirSync(config, { recursive: true });
    const result = await install(value);
    const path = join(config, "plugins/skills.ts");

    expect(result.code).toBe(0);
    expect(result.stdout.split("\n").filter((line) => line === `opencode ${path}`)).toHaveLength(1);
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(
      pathToFileURL(join(value.agents, "playbook/opencode/plugin.ts")).href,
    );

    const manifestPath = join(config, ".skills-install.json");
    const bytes = readFileSync(path);
    const manifest = readFileSync(manifestPath, "utf8");
    expect(JSON.parse(manifest).files["plugins/skills.ts"]).toBe(
      createHash("sha256").update(bytes).digest("hex"),
    );

    expect(Object.keys(JSON.parse(manifest).files).sort()).toEqual([
      ...agentNames.map((name) => `agents/${name}.md`),
      "plugins/skills.ts",
    ]);

    expect(ownedFile(config, "plugins/skills.ts")).toBe(true);

    const rerun = await install(value);
    expect(rerun.code).toBe(0);
    expect(rerun.stdout).not.toContain("skills.ts");

    expect(readFileSync(path)).toEqual(bytes);
    expect(readFileSync(manifestPath, "utf8")).toBe(manifest);
    expect(existsSync(join(value.home, ".opencode"))).toBe(false);

    if (mode !== "default") expect(existsSync(value.config)).toBe(false);
  },
);

test("the installer preserves a handwritten plugin", async () => {
  const value = fixture();
  const path = join(value.config, "plugins/skills.ts");
  mkdirSync(join(value.config, "plugins"), { recursive: true });
  writeFileSync(path, "export default { id: 'personal' };\n");
  const result = await install(value);

  expect(result.code).toBe(0);
  expect(result.stdout).toContain(
    `skip   skills.ts (${path} is not a file this installer placed, left in place)`,
  );

  expect(readFileSync(path, "utf8")).toBe("export default { id: 'personal' };\n");
  const manifest = readManifest(value.config);
  assert(manifest.kind === "valid");
  expect(manifest.files).not.toHaveProperty("plugins/skills.ts");
});

const agentNames = ["comment-sicko", "fable-judgment", "opus-review", "playbook-agent"];
const v2Keys = new Set([
  "model",
  "request",
  "system",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
  "variant",
]);

function parsedAgent(text: string) {
  const parsed = readFrontmatter(text, Bun.YAML.parse);
  assert(parsed.kind === "mapping");

  const closing = /^---\r?$/gm;
  closing.exec(text);
  const match = closing.exec(text)!;
  const afterMarker = match.index + match[0].length;
  return {
    data: parsed.data,
    body: text.slice(text[afterMarker] === "\n" ? afterMarker + 1 : afterMarker),
  };
}

function permission(permissions: unknown, action: string): unknown {
  assert(Array.isArray(permissions));

  let effect: unknown;
  for (const rule of permissions)
    if ((rule.action === "*" || rule.action === action) && rule.resource === "*")
      effect = rule.effect;

  return effect;
}

test("agents translate to v2 subagents with unchanged bodies and stable ownership", () => {
  const { home } = fixture();
  expect(installOpenCodeAgents(home, repo)).toHaveLength(4);
  const bytes = new Map<string, Buffer<ArrayBuffer>>();
  for (const name of agentNames) {
    const path = join(home, "agents", `${name}.md`);
    const source = parsedAgent(readFileSync(join(repo, "agents", `${name}.md`), "utf8"));
    const written = parsedAgent(readFileSync(path, "utf8"));

    expect(Object.keys(written.data).every((key) => v2Keys.has(key))).toBe(true);
    expect(written.data.description).toBe(source.data.description);
    expect(written.data.mode).toBe("subagent");
    expect(written.data).not.toHaveProperty("model");

    expect(written.body).toBe(source.body);
    expect(ownedFile(home, `agents/${name}.md`)).toBe(true);

    if (name === "comment-sicko") {
      expect(permission(written.data.permissions, "edit")).toBe("deny");
      expect(permission(written.data.permissions, "read")).toBe("allow");
      expect(permission(written.data.permissions, "grep")).toBe("allow");
    } else expect(written.data).not.toHaveProperty("permissions");

    bytes.set(path, readFileSync(path));
  }

  bytes.set(join(home, ".skills-install.json"), readFileSync(join(home, ".skills-install.json")));
  expect(installOpenCodeAgents(home, repo)).toEqual([]);
  for (const [path, content] of bytes) expect(readFileSync(path)).toEqual(content);
});

test("handwritten and edited agents stay personal", () => {
  const { home } = fixture();
  mkdirSync(join(home, "agents"));
  const handwritten = join(home, "agents/comment-sicko.md");
  const edited = join(home, "agents/opus-review.md");
  writeFileSync(handwritten, "handwritten\n");

  expect(installOpenCodeAgents(home, repo).join("\n")).toContain("skip   comment-sicko.md");

  writeFileSync(edited, readFileSync(edited, "utf8") + "personal\n");
  const bytes = readFileSync(edited);

  const output = installOpenCodeAgents(home, repo).join("\n");
  expect(output).toContain("skip   comment-sicko.md");
  expect(output).toContain("skip   opus-review.md");
  expect(readFileSync(handwritten, "utf8")).toBe("handwritten\n");
  expect(readFileSync(edited)).toEqual(bytes);
});

function sourceFixture(home: string) {
  const source = join(home, "checkout");
  mkdirSync(join(source, "agents"), { recursive: true });

  for (const name of agentNames)
    writeFileSync(
      join(source, "agents", `${name}.md`),
      readFileSync(join(repo, "agents", `${name}.md`)),
    );

  return source;
}

test("dropped agents are pruned only while owned and forgotten even when personal", () => {
  const { home } = fixture();
  const source = sourceFixture(home);
  installOpenCodeAgents(home, source);

  const edited = join(home, "agents/opus-review.md");
  const original = readFileSync(edited);
  writeFileSync(edited, "personal\n");

  for (const name of ["comment-sicko", "opus-review", "fable-judgment"])
    rmSync(join(source, "agents", `${name}.md`));

  rmSync(join(home, "agents/fable-judgment.md"));

  const output = installOpenCodeAgents(home, source);
  expect(output).toContain("prune  comment-sicko");
  expect(output.join("\n")).toContain("skip   opus-review.md");
  expect(existsSync(join(home, "agents/comment-sicko.md"))).toBe(false);
  expect(readFileSync(edited, "utf8")).toBe("personal\n");

  const manifest = readManifest(home);
  assert(manifest.kind === "valid");
  expect(Object.keys(manifest.files)).toEqual(["agents/playbook-agent.md"]);

  writeFileSync(edited, original);
  expect(installOpenCodeAgents(home, source)).toEqual([]);
  expect(readFileSync(edited)).toEqual(original);
});

test("a checkout with no agents dir prunes every owned agent", () => {
  const { home } = fixture();
  const source = sourceFixture(home);
  installOpenCodeAgents(home, source);

  rmSync(join(source, "agents"), { recursive: true });

  const output = installOpenCodeAgents(home, source);
  expect(output.filter((line) => line.startsWith("prune  "))).toHaveLength(4);
  expect(existsSync(join(home, "agents/comment-sicko.md"))).toBe(false);

  const manifest = readManifest(home);
  assert(manifest.kind === "valid");
  expect(manifest.files).toEqual({});
});

test("an owned agent that cannot be removed is skipped and retried", () => {
  const { home } = fixture();
  const source = sourceFixture(home);
  installOpenCodeAgents(home, source);
  rmSync(join(source, "agents/comment-sicko.md"));
  chmodSync(join(home, "agents"), 0o555);

  let output: string[];
  try {
    output = installOpenCodeAgents(home, source);
  } finally {
    chmodSync(join(home, "agents"), 0o755);
  }

  expect(output.join("\n")).toContain("comment-sicko.md could not be removed");
  expect(existsSync(join(home, "agents/comment-sicko.md"))).toBe(true);
  expect(installOpenCodeAgents(home, source)).toContain("prune  comment-sicko");
});

test("an invalid manifest never authorizes agent pruning", () => {
  const { home } = fixture();
  const source = sourceFixture(home);
  installOpenCodeAgents(home, source);
  rmSync(join(source, "agents/comment-sicko.md"));
  writeFileSync(join(home, ".skills-install.json"), "invalid\n");

  expect(installOpenCodeAgents(home, source).join("\n")).not.toContain("prune  ");
  expect(existsSync(join(home, "agents/comment-sicko.md"))).toBe(true);
  expect(readFileSync(join(home, ".skills-install.json"), "utf8")).toBe("invalid\n");
});

test.each([
  ["mode: subagent\ndescription: valid", "unsupported key mode"],
  ["description: valid\ntools: Read, Unknown", "unsupported tool Unknown"],
  ["description: valid\ntools: toString", "unsupported tool toString"],
  ["name: missing-description", "description must be a string"],
  ["description: 12", "description must be a string"],
  ["description: valid\ntools: [Read]", "tools must be a string"],
  ["description: first\ndescription: second", "frontmatter is invalid"],
])("unsupported agent metadata is skipped: %s", (header, reason) => {
  const { home } = fixture();
  const source = join(home, "checkout");
  mkdirSync(join(source, "agents"), { recursive: true });
  writeFileSync(join(source, "agents/test.md"), `---\n${header}\n---\nbody\n`);

  expect(installOpenCodeAgents(home, source)).toEqual([`skip   test.md (${reason})`]);
  expect(existsSync(join(home, "agents/test.md"))).toBe(false);
});

test("tool mappings deduplicate actions in source order and YAML strings round trip", () => {
  const { home } = fixture();
  const source = join(home, "checkout");
  const description = 'Quoted "text": # hash\nnext line';
  const body = "\r\nbody with CRLF\r\n---\r\nlast line";
  mkdirSync(join(source, "agents"), { recursive: true });
  writeFileSync(
    join(source, "agents/test.md"),
    [
      "---",
      `description: ${JSON.stringify(description)}`,
      "tools: Read, Grep, Glob, Bash, Edit, Write, NotebookEdit, WebFetch, WebSearch, Task, Agent, Skill, Read",
      "---",
      body,
    ].join("\r\n"),
  );

  installOpenCodeAgents(home, source);

  const written = parsedAgent(readFileSync(join(home, "agents/test.md"), "utf8"));
  expect(written.data.description).toBe(description);
  expect(written.body).toBe(body);
  expect(written.data.permissions).toEqual([
    { action: "*", resource: "*", effect: "deny" },
    ...["read", "grep", "glob", "shell", "edit", "webfetch", "websearch", "subagent", "skill"].map(
      (action) => ({ action, resource: "*", effect: "allow" }),
    ),
  ]);
});

test("the installer does not create a config dir or fall back to another existing one", async () => {
  const value = fixture();
  let result = await install(value);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("opencode ");
  expect(existsSync(value.config)).toBe(false);

  mkdirSync(value.config, { recursive: true });
  value.env.OPENCODE_CONFIG_DIR = join(value.home, "missing");

  result = await install(value);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("opencode ");
  expect(existsSync(value.env.OPENCODE_CONFIG_DIR)).toBe(false);
  expect(existsSync(join(value.config, "plugins"))).toBe(false);
});

test("empty config overrides fall through", () => {
  expect(opencodeConfigDir({ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "" }, "/home/test")).toBe(
    "/home/test/.config/opencode",
  );

  expect(
    opencodeConfigDir({ OPENCODE_CONFIG_DIR: "", XDG_CONFIG_HOME: "/xdg" }, "/home/test"),
  ).toBe("/xdg/opencode");
});

test("owned writes update hashes, sort keys and preserve modified files", () => {
  const { home } = fixture();
  expect(writeOwned(home, "z.ts", "first")).toEqual([`opencode ${join(home, "z.ts")}`]);
  writeOwned(home, "a.ts", "second");
  expect(readFileSync(join(home, ".skills-install.json"), "utf8")).toBe(
    JSON.stringify(
      {
        files: {
          "a.ts": createHash("sha256").update("second").digest("hex"),
          "z.ts": createHash("sha256").update("first").digest("hex"),
        },
      },
      null,
      2,
    ) + "\n",
  );

  expect(writeOwned(home, "z.ts", "updated")).toHaveLength(1);
  expect(ownedFile(home, "z.ts")).toBe(true);

  writeFileSync(join(home, "z.ts"), "personal");
  const manifest = readFileSync(join(home, ".skills-install.json"));
  expect(writeOwned(home, "z.ts", "replacement")[0]).toStartWith("skip   z.ts");
  expect(readFileSync(join(home, "z.ts"), "utf8")).toBe("personal");
  expect(readFileSync(join(home, ".skills-install.json"))).toEqual(manifest);
});

test("a file already holding the wanted bytes is adopted after an interrupted record", () => {
  const { home } = fixture();
  writeOwned(home, "entry.ts", "old");
  writeFileSync(join(home, "entry.ts"), "new");
  expect(ownedFile(home, "entry.ts")).toBe(false);

  expect(writeOwned(home, "entry.ts", "new")).toEqual([]);
  expect(ownedFile(home, "entry.ts")).toBe(true);
  expect(readManifest(home)).toEqual({
    kind: "valid",
    files: { "entry.ts": createHash("sha256").update("new").digest("hex") },
  });
});

test.each(["symlink", "directory"])("a %s is personal even when the hash matches", (kind) => {
  const { home } = fixture();
  writeOwned(home, "entry.ts", "owned");
  rmSync(join(home, "entry.ts"));

  if (kind === "directory") mkdirSync(join(home, "entry.ts"));
  else {
    writeFileSync(join(home, "target.ts"), "owned");
    symlinkSync(join(home, "target.ts"), join(home, "entry.ts"));
  }

  expect(ownedFile(home, "entry.ts")).toBe(false);
  expect(writeOwned(home, "entry.ts", "replacement")[0]).toStartWith("skip   entry.ts");
});

test.each(["broken json", "null", "{}", '{"files":[]}', '{"files":{"entry.ts":"bad"}}'])(
  "invalid manifest %s is never clobbered",
  (manifest) => {
    const { home } = fixture();
    writeFileSync(join(home, ".skills-install.json"), manifest);

    expect(readManifest(home)).toEqual({ kind: "invalid" });
    expect(writeOwned(home, "entry.ts", "new")[0]).toStartWith("skip   entry.ts");
    expect(existsSync(join(home, "entry.ts"))).toBe(false);
    expect(readFileSync(join(home, ".skills-install.json"), "utf8")).toBe(manifest);
  },
);

test("a symlinked manifest stays untouched", () => {
  const { home } = fixture();
  const target = join(home, "personal.json");
  writeFileSync(target, '{"files":{}}\n');
  symlinkSync(target, join(home, ".skills-install.json"));

  expect(writeOwned(home, "entry.ts", "new")[0]).toStartWith("skip   entry.ts");
  expect(lstatSync(join(home, ".skills-install.json")).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe('{"files":{}}\n');
});

test("missing store plugin writes nothing", () => {
  const { home, agents } = fixture();

  expect(installOpenCodePlugin(home, agents)[0]).toContain("is missing");
  expect(existsSync(join(home, "plugins"))).toBe(false);
  expect(existsSync(join(home, ".skills-install.json"))).toBe(false);
});

test("a stub loads the plugin and a moved store fails closed for shell only", async () => {
  const value = fixture();
  mkdirSync(value.config, { recursive: true });
  expect((await install(value)).code).toBe(0);

  const path = join(value.config, "plugins/skills.ts");
  const live = (await import(pathToFileURL(path).href)).default;
  expect(live.id).toBe("skills-guard");

  const liveHooks: string[] = [];
  const hook = async (name: string) => {
    liveHooks.push(name);
  };

  const cleanup = await live.setup({
    location: { directory: value.home },
    tool: { hook },
    session: { hook },
    event: { subscribe: async function* () {} },
  });

  cleanup();

  expect(liveHooks).toEqual(["execute.before", "execute.after", "context"]);

  const missing = join(value.home, "moved-store");
  mkdirSync(join(missing, "playbook/opencode"), { recursive: true });
  writeFileSync(join(missing, "playbook/opencode/plugin.ts"), "export default {};\n");
  expect(installOpenCodePlugin(value.config, missing)).toHaveLength(1);

  const fallbackConfig = join(value.home, "fallback-config");
  mkdirSync(fallbackConfig);
  installOpenCodePlugin(fallbackConfig, missing);
  rmSync(missing, { recursive: true });
  const fallback = (await import(pathToFileURL(join(fallbackConfig, "plugins/skills.ts")).href))
    .default;

  const callbacks: ((event: { tool: string; input: unknown }) => Promise<void>)[] = [];
  await fallback.setup({
    tool: {
      async hook(_name: string, callback: (typeof callbacks)[number]) {
        callbacks.push(callback);
      },
    },
  });

  for (const tool of ["shell", "renamed-shell"])
    await expect(callbacks[0]!({ tool, input: { command: "pwd" } })).rejects.toThrow(
      `could not load ${missing}/playbook/opencode/plugin.ts, so every shell command stays blocked`,
    );

  await expect(callbacks[0]!({ tool: "read", input: { path: "a.ts" } })).resolves.toBeUndefined();
});

test("an unwritable plugins dir skips with a line instead of aborting the install", () => {
  const { home } = fixture();
  const store = join(home, "store");
  mkdirSync(join(store, "playbook/opencode"), { recursive: true });
  writeFileSync(join(store, "playbook/opencode/plugin.ts"), "export default {};\n");
  mkdirSync(join(home, "plugins"), { mode: 0o500 });

  try {
    const lines = installOpenCodePlugin(home, store);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("skip   skills.ts");
    expect(lines[0]).toContain("could not be written");
    expect(existsSync(join(home, "plugins/skills.ts"))).toBe(false);
  } finally {
    chmodSync(join(home, "plugins"), 0o700);
  }
});

test("a stub whose store exports no plugin fails closed", async () => {
  const { home } = fixture();
  const store = join(home, "store");
  mkdirSync(join(store, "playbook/opencode"), { recursive: true });
  writeFileSync(join(store, "playbook/opencode/plugin.ts"), "export default {};\n");
  installOpenCodePlugin(home, store);

  const stub = (await import(pathToFileURL(join(home, "plugins/skills.ts")).href)).default;
  const callbacks: ((event: { tool: string; input: unknown }) => Promise<void>)[] = [];
  await stub.setup({
    tool: {
      async hook(_name: string, callback: (typeof callbacks)[number]) {
        callbacks.push(callback);
      },
    },
  });

  expect(stub.id).toBe("skills-guard");
  await expect(callbacks[0]!({ tool: "shell", input: { command: "pwd" } })).rejects.toThrow(
    "its default export is not a plugin",
  );
});
