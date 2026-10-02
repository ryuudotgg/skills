import { afterEach, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { shellQuote } from "../shell.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

const repo = resolve(import.meta.dir, "../..");
const cli = join(repo, "src/cli.ts");
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) await removeTemporary(directory);
});

function fixture() {
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

  return { home, conf, agents, env };
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

  const responses = new Map<string, string>();
  const answered = new Set<string>();
  let output = "";
  const pty = new Bun.Terminal({
    cols: 120,
    rows: 40,
    data(term, bytes) {
      output += new TextDecoder().decode(bytes);

      for (const [prompt, keys] of responses) {
        if (!output.includes(prompt) || answered.has(prompt)) continue;

        answered.add(prompt);
        setTimeout(() => {
          if (!term.closed) term.write(keys);
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
    answer: (prompt: string, keys: string) => {
      responses.set(prompt, keys);
    },
  };
}

test("PTY prs and greptile match --with prs --with greptile byte for byte", async () => {
  const human = fixture();
  const flags = fixture();

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
  const value = fixture();
  mkdirSync(dirname(value.conf));
  writeFileSync(value.conf, saved);

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
  const result = await running.result;

  const flagged = fixture();
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
  const result = await running.result;

  expect(result.timedOut).toBe(false);
  expect(result.code).toBe(0);
  expect(result.stdout).not.toContain("Optional skills and reviewers");
  expect(readFileSync(value.conf, "utf8")).toBe(
    "DELIVERY=hands-off\nWITH=\nGREPTILE_REREVIEWS=3\n",
  );
}, 30_000);

test("PTY saved mode and selected reviewers are the initial prompt values", async () => {
  const value = fixture();
  mkdirSync(dirname(value.conf));

  const saved = "# my settings\nDELIVERY=prs\nWITH=greptile\n";
  writeFileSync(value.conf, saved);

  const running = terminal(value);
  running.answer("Delivery mode", "\r");
  running.answer("Optional skills and reviewers", "\r");
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
  const result = await running.result;

  expect(result.code).toBe(0);
  expect(result.timedOut).toBe(false);
  expect(readFileSync(value.conf, "utf8")).toBe("DELIVERY=prs\nWITH=\n");
}, 30_000);

test("PTY source clone loads missing Clack after one frozen install", async () => {
  const value = fixture();
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
