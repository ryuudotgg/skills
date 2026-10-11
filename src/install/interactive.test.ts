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
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shellQuote } from "../shell.ts";
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
  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
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
    permissions: {
      ask: guardrails(value, "prs", ["deny", "deny-until-guard", "ask"]),
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
    if (group.kind !== "deny" || group.cells.prs === "absent") continue;

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
    guardrails(value, "prs", ["deny", "deny-until-guard", "ask"]).filter(
      (entry) => !merge.includes(entry),
    ),
  );
}, 30_000);

test("PTY saved overrides preselect Customize and Deny previews every cleared key", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(
    value.conf,
    "DELIVERY=prs\nWITH=\nAGENT_RULES=deny\nAGENT_RULES_MERGE=deny\nAGENT_RULES_UNKNOWN=off\nAGENT_RULES_SKILLS_CONF_WRITE=off\n",
  );

  const seed = await runCommand(
    [process.execPath, "--no-env-file", cli, "install", "--with", "prs"],
    { cwd: repo, env: value.env },
  );

  expect(seed.code).toBe(0);
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

  const seed = await runCommand(
    [process.execPath, "--no-env-file", cli, "install", "--with", "prs"],
    { cwd: repo, env: value.env },
  );

  expect(seed.code).toBe(0);
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

    const result = await running.result;

    expect({ code: result.code, timedOut: result.timedOut }).toEqual({ code: 0, timedOut: false });
    expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\nAGENT_RULES=off\n");

    if (action === "remove")
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ permissions: personal });
    else {
      expect(readFileSync(path, "utf8")).toBe(settings);
      expect(result.stdout).not.toContain("Apply these changes?");
    }
  },
  30_000,
);

async function seeded(value: ReturnType<typeof fixture>, conf: string) {
  mkdirSync(dirname(value.conf), { recursive: true });
  writeFileSync(value.conf, conf);
  const seed = await runCommand([process.execPath, "--no-env-file", cli, "install"], {
    cwd: repo,
    env: value.env,
  });

  expect(seed.code).toBe(0);
  return join(value.home, ".claude/settings.json");
}

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

test("PTY --with prs confirms dropping publishing and names a declined group on every run", async () => {
  const value = fixture();
  const path = await seeded(value, "DELIVERY=hands-off\nWITH=\nAGENT_RULES=deny\n");
  const publishing = group("publishing");
  const before = snapshot(value.home);
  let preview: ReturnType<typeof snapshot> | undefined;

  const running = terminal(value, ["--with", "prs"]);
  running.answer("Untick a group", " \r", () => {
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
