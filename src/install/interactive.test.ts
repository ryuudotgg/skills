import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shellQuote } from "../shell.ts";
import { claudeBlock } from "./hook-table.ts";
import {
  expandEntry,
  readRuleGroups,
  type Cell,
  type Placeholder,
  type RuleGroup,
} from "../deny-set.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

const repo = resolve(import.meta.dir, "../..");
const cli = join(repo, "src/cli.ts");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemporary(directory);
});

function fixture(claude = true) {
  const home = mkdtempSync(join(tmpdir(), "skills-install-tty-"));
  directories.push(home);

  const conf = join(home, ".agents/skills.conf");
  const agents = join(home, ".agents/skills");
  const tools = join(home, "tools");
  mkdirSync(tools);
  symlinkSync(process.execPath, join(tools, "bun"));

  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    PATH: `${tools}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    AGENTS_DIR: agents,
    SKILLS_CONF: conf,
    CLAUDE_HOME: join(home, ".claude"),
    CODEX_HOME: join(home, ".codex"),
    EXTRA_DIRS: join(home, "missing"),
    TERM: "xterm-256color",
  };

  delete env.CI;
  delete env.CLAUDE_CONFIG_DIR;
  delete env.OPENCODE_CONFIG_DIR;
  delete env.XDG_CONFIG_HOME;
  if (claude) mkdirSync(join(home, ".claude"));

  return { home, conf, agents, env };
}

function screen(stdout: string): string {
  return Bun.stripANSI(stdout).replaceAll(/[\s│]+/g, " ");
}

function snapshot(home: string): Record<string, Buffer | string> {
  const entries: Record<string, Buffer | string> = {};
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stats = lstatSync(path);
      if (stats.isSymbolicLink()) entries[path] = readlinkSync(path);
      else if (stats.isDirectory()) {
        entries[path] = "directory";
        visit(path);
      } else entries[path] = readFileSync(path);
    }
  };

  for (const name of [".agents", ".claude", ".codex"])
    if (existsSync(join(home, name))) visit(join(home, name));

  return entries;
}

function placeholders(value: ReturnType<typeof fixture>): Record<Placeholder, string> {
  return {
    claude: join(value.home, ".claude"),
    agents: value.agents,
    conf: value.conf,
    codex: join(value.home, ".codex"),
    checkout: repo,
  };
}

function rendered(value: ReturnType<typeof fixture>, group: RuleGroup): string[] {
  return group.entries.flatMap((entry) => expandEntry(entry, placeholders(value), value.home));
}

function guardrails(
  value: ReturnType<typeof fixture>,
  mode: "prs" | "hands-off",
  cells: readonly Cell[] = ["deny", "deny-until-guard"],
): string[] {
  return readRuleGroups(join(repo, "skills"))
    .filter((group) => group.kind !== "retired" && cells.includes(group.cells[mode]))
    .flatMap((group) => rendered(value, group));
}

function terminal(
  value: ReturnType<typeof fixture>,
  args: readonly string[] = [],
  inputNull = false,
  entry = cli,
) {
  const command = [process.execPath, "--no-env-file", entry, "install", ...args];
  const argv = inputNull
    ? ["/bin/sh", "-c", `exec ${command.map(shellQuote).join(" ")} </dev/null`]
    : command;

  const responses = new Map<string, { keys: string; before?: () => void }>();
  responses.set("Arms for delegated work", { keys: "\r" });
  const answered = new Set<string>();
  let output = "";
  const pty = new Bun.Terminal({
    cols: 400,
    rows: 40,
    data(term, bytes) {
      output += new TextDecoder().decode(bytes);

      for (const [prompt, { keys, before }] of responses) {
        if (!output.includes(prompt) || answered.has(prompt)) continue;

        answered.add(prompt);
        setTimeout(() => {
          if (!term.closed) {
            before?.();
            term.write(keys);
          }
        }, 40);
      }
    },
  });

  const child = Bun.spawn(argv, { cwd: repo, env: value.env, terminal: pty });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill();
    pty.close();
  }, 15_000);

  const result = (async () => {
    const code = await child.exited;
    clearTimeout(timer);
    await Bun.sleep(25);
    pty.close();

    return { code, stdout: output, timedOut };
  })();

  return {
    result,
    answer: (prompt: string, keys: string, before?: () => void) => {
      responses.set(prompt, { keys, before });
    },
  };
}

function opencodeCatalog(value: ReturnType<typeof fixture>, body?: string) {
  const bin = join(value.home, "bin");
  mkdirSync(bin);
  const path = join(bin, "opencode");
  writeFileSync(
    path,
    `#!/bin/sh\n${
      body ??
      `case "$*" in
models) printf 'vendor/first\\nother/second\\nother/plain\\n' ;;
'api model.list') printf '%s\\n' '{"data":[{"providerID":"vendor","id":"first","variants":[{"id":"low"},{"id":"high"}]},{"providerID":"other","id":"second","variants":[{"id":"medium"},{"id":"max"}]},{"providerID":"other","id":"plain","variants":[]},{"providerID":"private","id":"hidden","variants":[]}]}' ;;
*) exit 1 ;;
esac`
    }\n`,
  );

  chmodSync(path, 0o755);
  value.env.PATH = `${bin}:${value.env.PATH}`;
  return path;
}

async function arms(value: ReturnType<typeof fixture>) {
  return runCommand([process.execPath, "--no-env-file", cli, "arms"], {
    cwd: repo,
    env: value.env,
  });
}

test("PTY OpenCode tier picks save, rerun preselects them, and unticking removes them", async () => {
  const value = fixture(false);
  opencodeCatalog(value);

  const running = terminal(value);
  for (const [prompt, keys] of [
    ["Delivery mode", "\r"],
    ["Arms for delegated work", "\u001b[B\u001b[B \r"],
    ["OpenCode sol model", "\u001b[B\r"],
    ["OpenCode sol variant", "\u001b[B\r"],
    ["OpenCode terra model", "\u001b[B\r"],
    ["OpenCode terra variant", "\u001b[B\r"],
    ["OpenCode luna model", "\u001b[B\u001b[B\r"],
    ["OpenCode luna variant", "\r"],
    ["OpenCode astra model", "\u001b[B\r"],
    ["OpenCode astra variant", "\r"],
  ] as const)
    running.answer(prompt, keys);

  const result = await running.result;
  expect({
    code: result.code,
    timedOut: result.timedOut,
    failure: result.code ? screen(result.stdout) : "",
  }).toEqual({ code: 0, timedOut: false, failure: "" });

  const tiers =
    "luna=other/second#medium terra=vendor/first#high sol=other/second#max astra=vendor/first#low";

  const saved = readFileSync(value.conf, "utf8");
  expect(saved).toContain(`ARMS_ROSTER=claude codex opencode ${tiers}\n`);

  for (const model of ["vendor/first", "other/second", "other/plain"])
    expect(screen(result.stdout)).toContain(model);

  for (const variant of ["low", "high", "medium", "max"])
    expect(screen(result.stdout)).toContain(variant);

  expect(result.stdout).not.toContain("private/hidden");
  expect((await arms(value)).stdout).toContain(`opencode cli=yes ${tiers}\n`);

  const rerun = terminal(value);
  rerun.answer("Delivery mode", "\r");

  for (const tier of ["sol", "terra", "luna", "astra"]) {
    rerun.answer(`OpenCode ${tier} model`, "\r");
    rerun.answer(`OpenCode ${tier} variant`, "\r");
  }

  const kept = await rerun.result;
  expect({ code: kept.code, timedOut: kept.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(readFileSync(value.conf, "utf8")).toBe(saved);

  const untick = terminal(value);
  untick.answer("Delivery mode", "\r");
  untick.answer("Arms for delegated work", "\u001b[B\u001b[B \r");
  const removed = await untick.result;

  expect({ code: removed.code, timedOut: removed.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(removed.stdout).not.toContain("OpenCode sol model");
  expect(readFileSync(value.conf, "utf8")).toContain("ARMS_ROSTER=claude codex\n");
  expect((await arms(value)).stdout).not.toContain("opencode");
}, 60_000);

test.each([false, true])(
  "PTY without opencode disables it and preserves saved choices %j",
  async (saved) => {
    const value = fixture(false);
    const roster = "ARMS_ROSTER=claude opencode sol=vendor/main#high\n";
    if (saved) {
      mkdirSync(dirname(value.conf));
      writeFileSync(value.conf, roster);
    }

    const running = terminal(value);
    running.answer("Delivery mode", "\r");
    const result = await running.result;

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(result.stdout).toContain("opencode is not on PATH");
    expect(result.stdout).not.toContain("OpenCode sol model");

    if (saved) {
      expect(result.stdout).toContain("keeping the saved OpenCode roster");
      expect(readFileSync(value.conf, "utf8")).toBe(roster);
      expect((await arms(value)).stdout).toContain("opencode cli=no sol=vendor/main#high\n");
    } else expect((await arms(value)).stdout).not.toContain("opencode");
  },
  30_000,
);

test.each([false, true])(
  "PTY catalog failure carries only a saved OpenCode roster %j",
  async (saved) => {
    const value = fixture(false);
    opencodeCatalog(value, "exit 1");
    const roster = "ARMS_ROSTER=claude opencode sol=vendor/main#high\n";
    if (saved) {
      mkdirSync(dirname(value.conf));
      writeFileSync(value.conf, roster);
    }

    const running = terminal(value);
    running.answer("Delivery mode", "\r");
    if (!saved) running.answer("Arms for delegated work", "\u001b[B\u001b[B \r");

    const result = await running.result;
    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(result.stdout).toContain("opencode models failed");
    expect(result.stdout).not.toContain("OpenCode sol model");

    if (saved) expect(readFileSync(value.conf, "utf8")).toBe(roster);
    else expect((await arms(value)).stdout).not.toContain("opencode");
  },
  30_000,
);

test("PTY rerun keeps a saved model without a variant unpinned", async () => {
  const value = fixture(false);
  opencodeCatalog(value);
  mkdirSync(dirname(value.conf));

  const saved = "ARMS_ROSTER=claude codex opencode sol=vendor/first\n";
  writeFileSync(value.conf, saved);

  const running = terminal(value);
  running.answer("Delivery mode", "\r");

  for (const tier of ["sol", "terra", "luna", "astra"]) {
    running.answer(`OpenCode ${tier} model`, "\r");
    running.answer(`OpenCode ${tier} variant`, "\r");
  }

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(readFileSync(value.conf, "utf8")).toBe(saved);
}, 30_000);

test("PTY catalog failure with only OpenCode ticked keeps the saved roster", async () => {
  const value = fixture(false);
  opencodeCatalog(value, "exit 1");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Arms for delegated work", " \u001b[B \u001b[B \r");
  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(result.stdout).toContain("OpenCode not added");
  expect(existsSync(value.conf) ? readFileSync(value.conf, "utf8") : "").not.toContain(
    "ARMS_ROSTER",
  );

  expect((await arms(value)).stdout).toMatch(/^claude cli=\w+\ncodex cli=\w+\n$/);
}, 30_000);

test("PTY stale models start at the first option and models without variants skip that prompt", async () => {
  const value = fixture(false);
  opencodeCatalog(value);
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "ARMS_ROSTER=opencode terra=gone/old sol=gone/main\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("OpenCode sol model", "\u001b[B\u001b[B\r");

  for (const tier of ["terra", "luna", "astra"]) running.answer(`OpenCode ${tier} model`, "\r");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(result.stdout).toContain("gone/main is no longer in the catalog");
  expect(result.stdout).toContain("gone/old is no longer in the catalog");
  expect(result.stdout).not.toContain("OpenCode sol variant");
  expect(readFileSync(value.conf, "utf8")).toContain("ARMS_ROSTER=opencode sol=other/plain\n");
}, 30_000);

test("PTY prs and greptile match --with prs --with greptile byte for byte", async () => {
  const human = fixture(false);
  const flags = fixture(false);

  const running = terminal(human);
  running.answer("Delivery mode", "\u001b[B\r");
  running.answer("Optional skills and reviewers", "\u001b[B \r");
  const result = await running.result;
  const noninteractive = await runCommand(
    [join(repo, "install.sh"), "--with", "prs", "--with", "greptile"],
    { cwd: repo, env: flags.env },
  );

  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stdout).toContain("Delivery mode");
  expect(result.stdout).toContain("Optional skills and reviewers");

  expect(noninteractive.code).toBe(0);
  expect(readFileSync(human.conf, "utf8")).toBe("DELIVERY=prs\nWITH=greptile\n");
  expect(readFileSync(human.conf)).toEqual(readFileSync(flags.conf));
}, 30_000);

test.each(["stdin from /dev/null", "CI=1", "CI empty", "any flag"])(
  "PTY %s never prompts",
  async (kind) => {
    const value = fixture();
    if (kind === "CI=1") value.env.CI = "1";
    if (kind === "CI empty") value.env.CI = "";
    const running = terminal(
      value,
      kind === "any flag" ? ["--without", "prs"] : [],
      kind === "stdin from /dev/null",
    );

    const result = await running.result;

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain("Delivery mode");
    expect(result.stdout).not.toContain("Optional skills and reviewers");
    expect(result.stdout).not.toContain("Rules level");

    expect(existsSync(value.agents)).toBe(true);
    expect(existsSync(value.conf)).toBe(false);
  },
  30_000,
);

test.each(["Delivery mode", "Optional skills and reviewers"])(
  "PTY cancellation at %s writes nothing",
  async (prompt) => {
    const value = fixture();
    mkdirSync(dirname(value.conf));

    const saved = "# preserve me\nDELIVERY=prs\nWITH=greptile\n";
    writeFileSync(value.conf, saved);

    const running = terminal(value);
    if (prompt !== "Delivery mode") running.answer("Delivery mode", "\r");
    running.answer(prompt, "\u0003");
    const result = await running.result;

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(readFileSync(value.conf, "utf8")).toBe(saved);
    expect(existsSync(value.agents)).toBe(false);
  },
  30_000,
);

test("PTY saved WITH=prs keeps prs mode and matches the flag path", async () => {
  const saved = "DELIVERY=prs\nWITH=prs greptile\n";
  const value = fixture(false);
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, saved);

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  const result = await running.result;

  const flagged = fixture(false);
  mkdirSync(dirname(flagged.conf));
  writeFileSync(flagged.conf, saved);
  const flags = await runCommand(
    [process.execPath, "--no-env-file", cli, "install", "--with", "prs", "--with", "greptile"],
    { cwd: repo, env: flagged.env },
  );

  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(flags.code).toBe(0);
  expect(readFileSync(value.conf, "utf8")).toStartWith("DELIVERY=prs\n");
  expect(readFileSync(value.conf, "utf8")).toBe(readFileSync(flagged.conf, "utf8"));
}, 30_000);

test("PTY malformed config fails like flags before prompting", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=invalid\n");
  const running = terminal(value);
  const result = await running.result;
  const flags = await runCommand(
    [process.execPath, "--no-env-file", cli, "install", "--with", "prs"],
    { cwd: repo, env: value.env },
  );

  expect(result.timedOut).toBe(false);
  expect(result.stdout).toContain(flags.stderr.trimEnd());
  expect(result.code).toBe(1);
  expect(result.stdout).not.toContain("Delivery mode");

  expect(existsSync(value.agents)).toBe(false);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=invalid\n");
}, 30_000);

test("PTY saved defaults can switch to hands-off and clear prs reviewers", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=3\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\u001b[A\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r");

  const result = await running.result;

  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("Optional skills and reviewers");
  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=hands-off\nWITH=\nGREPTILE_REREVIEWS=3\nAGENT_RULES=deny\n",
  );
}, 30_000);

test("PTY saved mode and selected reviewers are the initial prompt values", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));

  const saved = "# my settings\nDELIVERY=prs\nWITH=greptile\nAGENT_RULES=off\n";
  writeFileSync(value.conf, saved);

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r");

  const result = await running.result;

  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(readFileSync(value.conf, "utf8")).toBe(saved);
}, 30_000);

test("PTY prs permits an empty optional selection", async () => {
  const value = fixture();

  const running = terminal(value);
  running.answer("Delivery mode", "\u001b[B\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r");

  const result = await running.result;

  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
}, 30_000);

test("PTY mode switches rewrite skills.rules after the confirm and reruns leave it identical", async () => {
  const value = fixture();
  const rules = join(value.home, ".codex/rules/skills.rules");

  mkdirSync(join(value.home, ".codex"));
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=prs\nAGENT_RULES=deny\n");

  await terminal(value, [], true).result;
  const prs = readFileSync(rules, "utf8");

  const handsOff = terminal(value);

  handsOff.answer("Delivery mode", "\u001b[A\r");
  handsOff.answer("Rules level", "\r");
  handsOff.answer("Untick a group", "\r");

  const switched = await handsOff.result;
  const strengthened = readFileSync(rules, "utf8");
  const rerun = await terminal(value, [], true).result;

  expect(switched.code).toBe(0);
  expect(screen(switched.stdout)).toContain("Codex Commit, push or open a PR: add forbidden");
  expect(prs).not.toContain('"commit"');
  expect(strengthened).toContain('["git", ["commit", "push"]], decision = "forbidden"');

  expect(rerun.code).toBe(0);
  expect(readFileSync(rules, "utf8")).toBe(strengthened);

  const back = terminal(value);

  back.answer("Delivery mode", "\u001b[B\r");
  back.answer("Optional skills and reviewers", "\r");
  back.answer("Rules level", "\r");
  back.answer("Untick a group", "\r");
  const weakened = await back.result;

  expect(weakened.code).toBe(0);
  expect(screen(weakened.stdout)).toContain(
    "Codex Commit, push or open a PR: remove forbidden (weakening)",
  );

  expect(readFileSync(rules, "utf8")).toBe(prs);

  const codex = Bun.which("codex");
  if (!codex) return;

  writeFileSync(join(value.home, "hands-off.rules"), strengthened);
  const check = Bun.spawnSync(
    [
      codex,
      "execpolicy",
      "check",
      "--rules",
      join(value.home, "hands-off.rules"),
      "--",
      "git",
      "push",
      "origin",
      "feat/x",
    ],
    { stdout: "pipe" },
  );

  expect(JSON.parse(check.stdout.toString()).decision).toBe("forbidden");
}, 60_000);

test("PTY a Codex only machine gets the rules prompt and its rules file", async () => {
  const value = fixture(false);
  mkdirSync(join(value.home, ".codex"));

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Rules level", "\r");
  running.answer("Apply these changes?", "\r");
  const result = await running.result;

  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(screen(result.stdout)).toContain("Codex Merge a PR: add forbidden");
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
  expect(readFileSync(join(value.home, ".codex/rules/skills.rules"), "utf8")).toContain(
    '["git", ["commit", "push"]], decision = "forbidden"',
  );
}, 30_000);

test("PTY source clone loads missing Clack after one frozen install", async () => {
  const value = fixture(false);
  const clone = join(value.home, "clone");
  const cache = join(value.home, "cache");
  mkdirSync(clone);

  for (const path of ["src", "skills", "agents", "package.json", "bun.lock", "bunfig.toml"])
    cpSync(join(repo, path), join(clone, path), { recursive: true });

  const modules = join(repo, "node_modules");
  const packages = readdirSync(modules)
    .filter((name) => !name.startsWith("."))
    .flatMap((name) =>
      name.startsWith("@")
        ? readdirSync(join(modules, name)).map((scoped) => `${name}/${scoped}`)
        : [name],
    );

  for (const name of packages) {
    const source = join(modules, name);
    const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
    const target = join(cache, `${name}@${version}@@@1`);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target, { recursive: true, dereference: true });
  }

  value.env.BUN_INSTALL_CACHE_DIR = cache;
  value.env.TMPDIR = value.home;

  const running = terminal(value, [], false, join(clone, "src/cli.ts"));
  running.answer("Delivery mode", "\u001b[B\r");
  running.answer("Optional skills and reviewers", "\u001b[B \r");
  const result = await running.result;

  expect({ code: result.code, failure: result.code ? result.stdout : "" }).toEqual({
    code: 0,
    failure: "",
  });

  expect(result.timedOut).toBe(false);
  expect(Bun.stripANSI(result.stdout).match(/bun install v/g)).toHaveLength(1);
  expect(existsSync(join(clone, "node_modules/@clack/prompts"))).toBe(true);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=greptile\n");
}, 30_000);

test("PTY Ask writes only after confirmation and Customize saves one deny override", async () => {
  const value = fixture();
  const before = snapshot(value.home);
  let preview: ReturnType<typeof snapshot> | undefined;

  const running = terminal(value);
  running.answer("Delivery mode", "\u001b[B\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\u001b[B\r");
  running.answer("Untick a group", "\r", () => {
    preview = snapshot(value.home);
  });

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(preview).toEqual(before);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\nAGENT_RULES=ask\n");
  const path = join(value.home, ".claude/settings.json");

  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    ...JSON.parse(claudeBlock("~/.agents/skills")),
    permissions: {
      ask: guardrails(value, "prs", ["deny", "ask"]),
      allow: guardrails(value, "prs", ["allow"]),
    },
  });

  const output = screen(result.stdout);

  expect(output).toContain("Rules level (Esc cancels the whole install)");
  expect(output).toContain("still prompts in bypass mode, refuses in headless runs");
  expect(output.indexOf("Optional skills and reviewers")).toBeLessThan(
    output.indexOf("Rules level"),
  );

  const confirm = output.indexOf(" config /");

  expect(output).toContain(path);
  expect(output.indexOf(path)).toBeLessThan(confirm);

  for (const group of readRuleGroups(join(repo, "skills"))) {
    if (group.kind !== "deny" || !["deny", "ask"].includes(group.cells.prs)) continue;

    const line = output.indexOf(`${group.label}: add ${rendered(value, group).length} to ask`);

    expect(line).toBeGreaterThan(-1);
    expect(line).toBeLessThan(confirm);
  }

  expect(output).not.toContain("Bash(gh pr merge:*)");

  const customized = terminal(value);
  customized.answer("Delivery mode", "\r");
  customized.answer("Optional skills and reviewers", "\r");
  customized.answer("Rules level", "\u001b[B\r");
  customized.answer("Default rules level", "\r");

  for (const group of readRuleGroups(join(repo, "skills"))) {
    if (group.kind === "retired") continue;
    customized.answer(group.label, group.id === "merge" ? "\u001b[A\r" : "\r");
  }

  customized.answer("Untick a group", "\r");
  const second = await customized.result;

  expect({ code: second.code, timedOut: second.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=prs\nWITH=\nAGENT_RULES=ask\nAGENT_RULES_MERGE=deny\n",
  );

  expect(screen(second.stdout)).toContain("absent in prs mode");
  const permissions = JSON.parse(readFileSync(path, "utf8")).permissions;
  const merge = readRuleGroups(join(repo, "skills")).find((group) => group.id === "merge")!.entries;

  expect(permissions.deny).toEqual(merge);
  expect(permissions.allow).toEqual(guardrails(value, "prs", ["allow"]));
  expect(permissions.ask).toEqual(
    guardrails(value, "prs", ["deny", "ask"]).filter((entry) => !merge.includes(entry)),
  );
}, 30_000);

test("PTY saved overrides preselect Customize and Deny previews every cleared key", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(
    value.conf,
    "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\nAGENT_RULES_MERGE=deny\nAGENT_RULES_UNKNOWN=off\nAGENT_RULES_SKILLS_CONF_WRITE=off\n",
  );

  const seeding = terminal(value, ["--with", "prs"]);
  seeding.answer("Untick a group", "\r");

  const seed = await seeding.result;

  expect({ code: seed.code, timedOut: seed.timedOut }).toEqual({ code: 0, timedOut: false });
  const before = snapshot(value.home);
  let preview: ReturnType<typeof snapshot> | undefined;

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\u001b[A\u001b[A\r");
  running.answer("Apply these changes?", "\r", () => {
    preview = snapshot(value.home);
  });

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(preview).toEqual(before);
  const output = screen(result.stdout);
  for (const key of ["AGENT_RULES_MERGE", "AGENT_RULES_UNKNOWN", "AGENT_RULES_SKILLS_CONF_WRITE"]) {
    expect(output).toContain(`${key} cleared`);
    expect(output.indexOf(`${key} cleared`)).toBeLessThan(output.indexOf("Apply these changes?"));
  }

  expect(output).not.toContain("Default rules level");
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
}, 30_000);

test("PTY Customize keeps a saved pin and confirms dropping its duplicate line", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(
    value.conf,
    "DELIVERY=prs\nWITH=\nAGENT_RULES=ask\nAGENT_RULES_MERGE=ask\nAGENT_RULES_MERGE=ask\n",
  );

  const seeding = terminal(value, ["--with", "prs"]);
  seeding.answer("Untick a group", "\r");

  const seed = await seeding.result;

  expect({ code: seed.code, timedOut: seed.timedOut }).toEqual({ code: 0, timedOut: false });
  const before = snapshot(value.home);
  let preview: ReturnType<typeof snapshot> | undefined;

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Default rules level", "\r");

  for (const group of readRuleGroups(join(repo, "skills")))
    if (group.kind !== "retired") running.answer(group.label, "\r");

  running.answer("Apply these changes?", "\r", () => {
    preview = snapshot(value.home);
  });

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(preview).toEqual(before);
  expect(screen(result.stdout)).toContain(`${value.conf}: AGENT_RULES=ask, AGENT_RULES_MERGE=ask`);

  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=prs\nWITH=\nAGENT_RULES=ask\nAGENT_RULES_MERGE=ask\n",
  );
}, 30_000);

test.each(["level", "drift Esc", "drift Ctrl-C"])(
  "PTY cancel at %s preserves config, settings and every skill link",
  async (where) => {
    const value = fixture();
    mkdirSync(dirname(value.conf));
    writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile\nAGENT_RULES=deny\n");
    const seed = await runCommand(
      [process.execPath, "--no-env-file", cli, "install", "--with", "prs"],
      { cwd: repo, env: value.env },
    );

    expect(seed.code).toBe(0);
    const before = snapshot(value.home);

    const running = terminal(value);
    running.answer("Delivery mode", "\r");
    running.answer("Optional skills and reviewers", "\r");
    running.answer("Rules level", where === "level" ? "\u001b" : "\u001b[B\r");

    if (where !== "level")
      running.answer("Untick a group", where === "drift Esc" ? "\u001b" : "\u0003");

    const result = await running.result;

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 1, timedOut: false });
    expect(snapshot(value.home)).toEqual(before);
    if (where !== "level") expect(screen(result.stdout)).toContain("(weakening)");
  },
  30_000,
);

test.each(["remove", "leave"])(
  "PTY Don't manage can %s owned entries even when already off",
  async (action) => {
    const value = fixture();
    mkdirSync(dirname(value.conf));
    writeFileSync(value.conf, "DELIVERY=prs\nWITH=\nAGENT_RULES=off\n");
    const path = join(value.home, ".claude/settings.json");
    const personal = {
      deny: ["Bash(personal *)"],
      ask: ["Read(~/private/**)"],
      allow: ["Bash(gh pr merge:*)"],
    };

    const settings =
      JSON.stringify({
        permissions: { ...personal, deny: [...personal.deny, ...guardrails(value, "hands-off")] },
      }) + "\n";

    writeFileSync(path, settings);

    const running = terminal(value);
    running.answer("Delivery mode", "\r");
    running.answer("Optional skills and reviewers", "\r");
    running.answer("Rules level", "\r");
    running.answer("Owned rules in settings.json", action === "remove" ? "\u001b[A\r" : "\r");

    if (action === "remove") running.answer("Apply these changes?", "\r");
    else running.answer("Untick a group", "\r");

    const result = await running.result;

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\nAGENT_RULES=off\n");

    if (action === "remove")
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        ...JSON.parse(claudeBlock("~/.agents/skills")),
        permissions: personal,
      });
    else {
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
        ...JSON.parse(settings),
        ...JSON.parse(claudeBlock("~/.agents/skills")),
      });

      expect(result.stdout).not.toContain("Apply these changes?");
    }
  },
  30_000,
);

test("PTY unticking a Claude hook saves its off key and does not propose it again", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=\nAGENT_RULES=off\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\u001b[B \r");

  const result = await running.result;
  const path = join(value.home, ".claude/settings.json");

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(readFileSync(value.conf, "utf8")).toContain("CLAUDE_HOOK_PRE_TOOL_USE=off\n");
  expect(screen(result.stdout)).toContain("Claude hook pre-tool-use: add");
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse).toBeUndefined();

  const rerun = terminal(value);
  rerun.answer("Delivery mode", "\r");
  rerun.answer("Optional skills and reviewers", "\r");
  rerun.answer("Rules level", "\r");
  const second = await rerun.result;

  expect({ code: second.code, timedOut: second.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(second.stdout).not.toContain("Untick a group");
  expect(JSON.parse(readFileSync(path, "utf8")).hooks.PreToolUse).toBeUndefined();
}, 30_000);

test("PTY declining the Claude guard shows the replanned prs comment deny", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
  const settings = JSON.parse(readFileSync(path, "utf8"));

  delete settings.hooks;
  settings.permissions.allow = guardrails(value, "prs", ["allow"]);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\u001b[B \r");

  const result = await running.result;
  const output = screen(result.stdout);
  const written = JSON.parse(readFileSync(path, "utf8"));

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(output).toContain("Rules after hook declines");
  expect(output).toContain(`${group("pr-comment").label}: add 1 to deny`);
  expect(readFileSync(value.conf, "utf8")).toContain("CLAUDE_HOOK_PRE_TOOL_USE=off\n");

  expect(written.hooks.PreToolUse).toBeUndefined();
  expect(written.permissions.deny).toContain("Bash(gh pr comment:*)");
}, 30_000);

async function seeded(value: ReturnType<typeof fixture>, conf: string) {
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, conf);

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r");

  const seed = await running.result;

  expect({ code: seed.code, timedOut: seed.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(readFileSync(value.conf, "utf8")).toBe(conf);
  return join(value.home, ".claude/settings.json");
}

test.each([true, false])(
  "PTY arms-only changes join the preview and confirm %j",
  async (confirm) => {
    const value = fixture();
    await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
    const before = snapshot(value.home);
    let preview: ReturnType<typeof snapshot> | undefined;

    const running = terminal(value);
    running.answer("Delivery mode", "\r");
    running.answer("Arms for delegated work", " \r");
    running.answer("Rules level", "\r");
    running.answer("Apply these changes?", confirm ? "\r" : "n\r", () => {
      preview = snapshot(value.home);
    });

    const result = await running.result;
    expect({ code: result.code, timedOut: result.timedOut }).toEqual({
      code: confirm ? 0 : 1,
      timedOut: false,
    });

    expect(preview).toEqual(before);
    expect(result.stdout).toContain("ARMS_ROSTER=codex");
    expect(result.stdout).toContain("Apply these changes?");

    if (confirm) expect(readFileSync(value.conf, "utf8")).toContain("ARMS_ROSTER=codex\n");
    else expect(snapshot(value.home)).toEqual(before);
  },
  60_000,
);

test("PTY arms changes appear in the drift note before its confirm", async () => {
  const value = fixture();

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Arms for delegated work", " \r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r");

  const result = await running.result;
  const output = screen(result.stdout);

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(output.indexOf("ARMS_ROSTER=codex")).toBeGreaterThan(-1);
  expect(output.indexOf("ARMS_ROSTER=codex")).toBeLessThan(output.indexOf("Untick a group"));
  expect(readFileSync(value.conf, "utf8")).toContain("ARMS_ROSTER=codex\n");
}, 30_000);

test.each([false, true])(
  "PTY flag hook declines show replanned rules before linking with rule decline %j",
  async (declineRules) => {
    const value = fixture();
    const path = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
    writeFileSync(path, "{}\n");

    const running = terminal(value, ["--with", "prs"]);
    running.answer("Untick a group", `${declineRules ? " " : ""}\u001b[B\u001b[B \r`);
    const result = await running.result;
    const output = screen(result.stdout);

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(output).toContain("Rules after hook declines");
    expect(output).toContain(`${group("pr-comment").label}: add 1 to deny`);
    expect(output.indexOf("Rules after hook declines")).toBeLessThan(output.indexOf("linked into"));
    expect(readFileSync(value.conf, "utf8")).toContain("CLAUDE_HOOK_PRE_TOOL_USE=off\n");
    expect(JSON.parse(readFileSync(path, "utf8")).permissions.deny).toContain(
      "Bash(gh pr comment:*)",
    );

    if (declineRules) {
      const note = output.slice(
        output.indexOf("Rules after hook declines"),
        output.indexOf("config "),
      );

      expect(note).not.toContain(group("skills-cli").label);
      expect(readFileSync(value.conf, "utf8")).toContain("AGENT_RULES_SKILLS_CLI=off\n");
      expect(JSON.parse(readFileSync(path, "utf8")).permissions.allow).toBeUndefined();
    }
  },
  30_000,
);

test("PTY post-link hook declines show replanned rules", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions.deny = settings.permissions.deny.filter(
    (entry: string) => !group("pr-review").entries.includes(entry),
  );

  writeFileSync(path, JSON.stringify(settings) + "\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r", () => {
    delete settings.hooks;
    settings.permissions.allow = [];
    writeFileSync(path, JSON.stringify(settings) + "\n");
  });

  running.answer("changed during the install", "\u001b[B\u001b[B \r");

  const result = await running.result;
  const output = screen(result.stdout);

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(output).toContain("Rules after hook declines");
  expect(output).toContain(`${group("pr-comment").label}: add 1 to deny`);
  expect(readFileSync(value.conf, "utf8")).toContain("CLAUDE_HOOK_PRE_TOOL_USE=off\n");
  expect(JSON.parse(readFileSync(path, "utf8")).permissions.deny).toContain(
    "Bash(gh pr comment:*)",
  );
}, 30_000);

test("PTY Esc at the post-link prompt writes none of its pending hooks", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions.deny = settings.permissions.deny.filter(
    (entry: string) => !group("pr-review").entries.includes(entry),
  );

  writeFileSync(path, JSON.stringify(settings) + "\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", "\r", () => {
    delete settings.hooks;
    settings.permissions.allow = [];
    writeFileSync(path, JSON.stringify(settings) + "\n");
  });

  running.answer("changed during the install", "\u001b");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(JSON.parse(readFileSync(path, "utf8")).hooks).toBeUndefined();
  expect(readFileSync(value.conf, "utf8")).not.toContain("CLAUDE_HOOK_");
}, 30_000);

function listed(output: string, heading: string, line: string): boolean {
  const at = output.indexOf(line);
  const nearest = ["Add", "Update", "Remove"]
    .map((name) => ({ name, index: output.lastIndexOf(` ${name} `, at) }))
    .sort((left, right) => right.index - left.index)[0]!;

  return at > -1 && nearest.name === heading && nearest.index > output.indexOf("Untick a group");
}

function group(id: string): RuleGroup {
  return readRuleGroups(join(repo, "skills")).find((group) => group.id === id)!;
}

test("PTY an unticked add is saved as off and never proposed again", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions.deny = settings.permissions.deny.filter(
    (entry: string) => !group("pr-review").entries.includes(entry),
  );

  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  const edited = readFileSync(path, "utf8");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", " \r");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  const output = screen(result.stdout);

  expect(listed(output, "Add", `${group("pr-review").label}: add 1 to deny`)).toBe(true);
  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\nAGENT_RULES_PR_REVIEW=off\n",
  );

  expect(readFileSync(path, "utf8")).toBe(edited);

  const third = terminal(value);
  third.answer("Delivery mode", "\r");
  third.answer("Optional skills and reviewers", "\r");
  third.answer("Rules level", "\r");
  third.answer("Default rules level", "\r");

  for (const { kind, label } of readRuleGroups(join(repo, "skills")))
    if (kind !== "retired") third.answer(label, "\r");

  const rerun = await third.result;

  expect({ code: rerun.code, timedOut: rerun.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(rerun.stdout).not.toContain("Untick a group");
  expect(rerun.stdout).not.toContain("Apply these changes?");
  expect(readFileSync(path, "utf8")).toBe(edited);
}, 60_000);

test("PTY OpenCode only previews its rules and offers owned removal", async () => {
  const value = fixture(false);
  const config = join(value.home, "opencode");
  mkdirSync(config);
  value.env.OPENCODE_CONFIG_DIR = config;

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Rules level", "\r");
  running.answer("Apply these changes?", "\r");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(screen(result.stdout)).toContain("OpenCode Merge a PR: add deny");
  const path = join(config, "opencode.jsonc");
  expect(JSON.parse(readFileSync(path, "utf8")).policies.length).toBeGreaterThan(0);

  const removal = terminal(value);
  removal.answer("Delivery mode", "\r");
  removal.answer("Rules level", "\u001b[A\r");
  removal.answer("Owned rules in OpenCode global config", "\u001b[A\r");
  removal.answer("Apply these changes?", "\r");

  const removed = await removal.result;

  expect({ code: removed.code, timedOut: removed.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(screen(removed.stdout)).toContain("OpenCode Merge a PR: remove deny (weakening)");
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ policies: [], permissions: [] });
  expect(readFileSync(value.conf, "utf8")).toContain("AGENT_RULES=off\n");
}, 60_000);

test.each([true, false])(
  "PTY OpenCode --with prs removes publishing only after confirmation %j",
  async (confirm) => {
    const value = fixture(false);
    const config = join(value.home, "opencode");
    mkdirSync(config);
    mkdirSync(join(value.home, ".agents"), { recursive: true });

    value.env.OPENCODE_CONFIG_DIR = config;
    writeFileSync(value.conf, "AGENT_RULES=deny\n");

    const seeded = await runCommand(
      [process.execPath, "--no-env-file", cli, "install", "--without", "prs"],
      { cwd: repo, env: value.env },
    );

    expect(seeded.code).toBe(0);
    const path = join(config, "opencode.jsonc");
    const before = readFileSync(path, "utf8");
    let preview: string | undefined;
    const running = terminal(value, ["--with", "prs"]);
    running.answer("Apply these OpenCode changes?", confirm ? "\r" : "n\r", () => {
      preview = readFileSync(path, "utf8");
    });

    const result = await running.result;

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(preview).toBe(before);
    expect(screen(result.stdout)).toContain(
      "OpenCode Commit, push or open a PR: remove deny (weakening)",
    );

    const after = readFileSync(path, "utf8");
    const publishing = { action: "tool.use", resource: "shell:gh pr create *", effect: "deny" };
    if (confirm) expect(JSON.parse(after).policies).not.toContainEqual(publishing);
    else {
      expect(after).toBe(before);
      expect(screen(result.stdout)).toContain(
        "left opencode publishing remove deny (weakening, not confirmed; rerun ./install.sh in a terminal to apply it)",
      );
    }

    expect(readFileSync(value.conf, "utf8")).not.toContain("AGENT_RULES_PUBLISHING");
  },
  60_000,
);

test.each([true, false])(
  "PTY Claude and OpenCode share the publishing confirmation %j",
  async (confirm) => {
    const value = fixture();
    const config = join(value.home, "opencode");
    mkdirSync(config);
    value.env.OPENCODE_CONFIG_DIR = config;

    const settings = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
    const path = join(config, "opencode.jsonc");
    const before = [settings, path].map((file) => readFileSync(file, "utf8"));

    let preview: string[] | undefined;
    let confirmations = 0;
    const running = terminal(value, ["--with", "prs"]);
    running.answer("Untick a group", confirm ? "\r" : "\u001b[B \r", () => {
      confirmations++;
      preview = [settings, path].map((file) => readFileSync(file, "utf8"));
    });

    const result = await running.result;

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(preview).toEqual(before);
    const output = screen(result.stdout);
    const publishing = group("publishing");
    const summary = `${publishing.label}: remove ${publishing.entries.length} from deny (weakening)`;

    expect(output).toContain(summary);
    expect(confirmations).toBe(1);
    expect(output).not.toContain("changed during the install");
    expect(output).not.toContain("Apply these OpenCode changes?");

    const deny = JSON.parse(readFileSync(settings, "utf8")).permissions.deny;
    const policies = JSON.parse(readFileSync(path, "utf8")).policies;

    for (const entry of publishing.entries)
      if (confirm) expect(deny).not.toContain(entry);
      else expect(deny).toContain(entry);

    const create = { action: "tool.use", resource: "shell:gh pr create *", effect: "deny" };
    if (confirm) expect(policies).not.toContainEqual(create);
    else expect(policies).toContainEqual(create);

    expect(readFileSync(value.conf, "utf8").includes("AGENT_RULES_PUBLISHING=off\n")).toBe(
      !confirm,
    );

    if (!confirm) {
      const expected = [
        before[0]!.replace(/^.*"Bash\(gh pr comment:\*\)",\n/m, ""),
        before[1]!.replace(/^.*"resource": "shell:gh pr comment \*".*\n/m, ""),
      ];

      expect([settings, path].map((file) => readFileSync(file, "utf8"))).toEqual(expected);
    }
  },
  60_000,
);

test("PTY a second Claude drift confirmation refreshes OpenCode confirmation for that group", async () => {
  const value = fixture();
  const config = join(value.home, "opencode");
  mkdirSync(config);
  value.env.OPENCODE_CONFIG_DIR = config;

  const settings = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
  const path = join(config, "opencode.jsonc");
  const publishing = group("publishing").entries;

  const running = terminal(value, ["--with", "prs"]);
  running.answer("Untick a group", "\r", () => {
    const document = JSON.parse(readFileSync(settings, "utf8"));
    document.permissions.ask = [...document.permissions.ask, publishing[0]];
    writeFileSync(settings, JSON.stringify(document, null, 2) + "\n");
  });

  running.answer("changed during the install", "\r", () => {
    const document = JSON.parse(readFileSync(path, "utf8"));
    document.policies.push({
      action: "tool.use",
      resource: "shell:gh pr create *",
      effect: "deny",
    });

    writeFileSync(path, JSON.stringify(document, null, 2) + "\n");
  });

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(screen(result.stdout)).toContain("changed during the install");
  expect(screen(result.stdout)).not.toContain("left opencode publishing");
  expect(screen(result.stdout)).not.toContain("Apply these OpenCode changes?");
  const permissions = JSON.parse(readFileSync(settings, "utf8")).permissions;
  for (const entry of publishing) {
    expect(permissions.deny).not.toContain(entry);
    expect(permissions.ask).not.toContain(entry);
  }

  expect(JSON.parse(readFileSync(path, "utf8")).policies).not.toContainEqual({
    action: "tool.use",
    resource: "shell:gh pr create *",
    effect: "deny",
  });
}, 60_000);

test("PTY owned removal names all three config surfaces as a comma list", async () => {
  const value = fixture();
  const config = join(value.home, "opencode");
  mkdirSync(config);
  mkdirSync(join(value.home, ".codex"));
  value.env.OPENCODE_CONFIG_DIR = config;

  const settings = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
  const rules = join(value.home, ".codex/rules/skills.rules");
  const path = join(config, "opencode.jsonc");
  const before = [settings, rules, path].map((file) => readFileSync(file, "utf8"));
  const running = terminal(value);

  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\u001b[B\u001b[B\u001b[B\r");
  running.answer("Owned rules in settings.json, skills.rules and OpenCode global config", "\r");
  running.answer("Untick a group", "\r");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(screen(result.stdout)).toContain(
    "Owned rules in settings.json, skills.rules and OpenCode global config",
  );

  expect(screen(result.stdout)).not.toContain("settings.json and skills.rules and");
  expect([settings, rules, path].map((file) => readFileSync(file, "utf8"))).toEqual(before);
}, 60_000);

test("PTY --with prs confirms dropping publishing and names a declined group on every run", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
  const publishing = group("publishing");
  const before = snapshot(value.home);
  let preview: ReturnType<typeof snapshot> | undefined;

  const running = terminal(value, ["--with", "prs"]);
  running.answer("Untick a group", "\u001b[B \r", () => {
    preview = snapshot(value.home);
  });

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(preview).toEqual(before);
  const output = screen(result.stdout);

  expect(
    listed(
      output,
      "Remove",
      `${publishing.label}: remove ${publishing.entries.length} from deny (weakening)`,
    ),
  ).toBe(true);

  expect(output).toContain("Esc cancels the whole install");
  expect(output).not.toContain("Delivery mode");
  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\nAGENT_RULES_PUBLISHING=off\n",
  );

  const deny = JSON.parse(readFileSync(path, "utf8")).permissions.deny;
  for (const entry of publishing.entries) expect(deny).toContain(entry);

  const blocked = `note   publishing is off (AGENT_RULES_PUBLISHING=off) and ${publishing.entries.length} entries in ${path} block prs mode; run ./install.sh with no flags and set it under Customize to lift it`;
  const named = (stdout: string) =>
    Bun.stripANSI(stdout)
      .split(/\r?\n/)
      .filter((line) => line.includes("publishing is off"));

  expect(named(result.stdout)).toEqual([blocked]);

  const next = await runCommand(
    [process.execPath, "--no-env-file", cli, "install", "--with", "prs"],
    { cwd: repo, env: value.env },
  );

  expect(next.code).toBe(0);
  expect(named(next.stdout)).toEqual([blocked]);
  expect(JSON.parse(readFileSync(path, "utf8")).permissions.deny).toEqual(deny);
}, 60_000);

test("PTY an unticked update records the placement the file holds", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
  const merge = group("merge").entries;
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions.deny = settings.permissions.deny.filter(
    (entry: string) => !merge.includes(entry),
  );

  settings.permissions.ask = [...settings.permissions.ask, ...merge];
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  const edited = readFileSync(path, "utf8");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");
  running.answer("Untick a group", " \r");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(
    listed(
      screen(result.stdout),
      "Update",
      `${group("merge").label}: move ${merge.length} from ask to deny`,
    ),
  ).toBe(true);

  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\nAGENT_RULES_MERGE=ask\n",
  );

  expect(readFileSync(path, "utf8")).toBe(edited);
}, 60_000);

test("PTY a settings change after the confirm is recomputed and confirmed again", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
  const publishing = group("publishing").entries;

  const running = terminal(value, ["--with", "prs"]);
  running.answer("Untick a group", "\r", () => {
    const settings = JSON.parse(readFileSync(path, "utf8"));
    settings.permissions.ask = [...settings.permissions.ask, publishing[0]];
    writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");
  });

  running.answer("changed during the install", " \r");
  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\nAGENT_RULES_PUBLISHING=off\n",
  );

  const permissions = JSON.parse(readFileSync(path, "utf8")).permissions;
  for (const entry of publishing) expect(permissions.deny).toContain(entry);
  expect(permissions.ask).toContain(publishing[0]);
}, 60_000);

test("PTY a retired entry alone is removed without a prompt", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\n");
  const settings = JSON.parse(readFileSync(path, "utf8"));
  const retired = group("skills-conf-write").entries[0]!;

  settings.permissions.deny.push(retired);
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  running.answer("Rules level", "\r");

  const result = await running.result;

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(result.stdout).not.toContain("Untick a group");
  expect(result.stdout).not.toContain("Apply these changes?");
  expect(JSON.parse(readFileSync(path, "utf8")).permissions.deny).not.toContain(retired);
}, 60_000);

test("PTY a declined group stays unchanged when saving its override fails", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=prs\nWITH=\nAGENT_RULES=ask\n");
  const merge = group("merge").entries;
  const settings = JSON.parse(readFileSync(path, "utf8"));
  settings.permissions.ask = settings.permissions.ask.filter(
    (entry: string) => !merge.includes(entry),
  );

  settings.permissions.deny = [merge[0]];
  writeFileSync(path, JSON.stringify(settings, null, 2) + "\n");

  const running = terminal(value, ["--with", "prs"]);
  running.answer("Untick a group", "\r", () => {
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.permissions.ask = [...current.permissions.ask, merge[0]];
    writeFileSync(path, JSON.stringify(current, null, 2) + "\n");
  });

  running.answer("changed during the install", " \r", () => {
    chmodSync(dirname(value.conf), 0o555);
  });

  const result = await running.result;
  chmodSync(dirname(value.conf), 0o755);

  expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
  expect(screen(result.stdout)).toContain("is not writable");
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\nAGENT_RULES=ask\n");

  const permissions = JSON.parse(readFileSync(path, "utf8")).permissions;

  expect(permissions.deny).toContain(merge[0]);
  expect(permissions.ask).not.toContain(merge[1]);
}, 60_000);
