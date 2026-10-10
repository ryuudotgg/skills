import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { expandEntry, readRuleGroups, type Placeholder } from "../src/deny-set.ts";
import { applyClaudeRules, parseLevels } from "../src/install/claude-rules.ts";

type JsonRecord = Record<string, unknown>;
type Call = {
  id: string;
  name: string;
  input: JsonRecord;
  result?: { content: unknown; error: boolean; kind?: string; decision?: string; source?: string };
};

type Expectation = { name: "Bash" | "Read" | "Edit"; value: string; group?: string };
type Run = { label: string; calls: Call[]; before: string; after: string; succeeded: boolean };
type Fixture = {
  home: string;
  settings: string;
  bin: string;
  current: Record<Placeholder, string>;
};

const root = resolve(import.meta.dir, "../skills");
const groups = readRuleGroups(root);
const variants = [
  { label: "full", content: "AGENT_RULES=deny\n" },
  { label: "installer-off", content: "AGENT_RULES=deny\nAGENT_RULES_INSTALLER=off\n" },
  { label: "claude-settings-off", content: "AGENT_RULES=deny\nAGENT_RULES_CLAUDE_SETTINGS=off\n" },
];

let mismatches = 0;

function record(value: unknown): JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : {};
}

function report(ok: boolean, message: string): void {
  if (!ok) mismatches++;
  console.log(`${ok ? "ok" : "MISMATCH"}  ${message}`);
}

function stub(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '#!/bin/sh\necho STUB-RAN "$0" "$@"\n', { mode: 0o755 });
}

function fixture(home: string): Fixture {
  const current = {
    claude: join(home, "claude-config"),
    agents: join(home, ".agents/skills"),
    conf: join(home, ".agents/skills.conf"),
    codex: join(home, ".codex"),
    checkout: join(home, "checkout"),
  };

  const bin = join(home, "bin");

  mkdirSync(current.claude, { recursive: true });
  mkdirSync(join(current.checkout, "src"), { recursive: true });

  stub(join(current.checkout, "install.sh"));
  stub(join(current.checkout, "skills/playbook/bin/skills"));
  stub(join(current.agents, "playbook/bin/skills"));
  stub(join(bin, "skills"));

  writeFileSync(join(current.checkout, "src/a.ts"), 'export const action = "install";\n');
  writeFileSync(
    join(current.checkout, "src/a.test.ts"),
    'import { expect, test } from "bun:test";\ntest("install", () => expect(1).toBe(1));\n',
  );

  const git = spawnSync("git", ["init", "--quiet"], { cwd: current.checkout, encoding: "utf8" });
  if (git.error || git.status !== 0) throw new Error(`git init failed: ${git.error ?? git.stderr}`);

  return { home, current, settings: join(current.claude, "settings.json"), bin };
}

function expectations(value: Fixture): Expectation[] {
  return [
    { name: "Bash", value: "./install.sh --with prs", group: "installer" },
    { name: "Bash", value: "sh install.sh", group: "installer" },
    { name: "Bash", value: "sh ./install.sh", group: "installer" },
    { name: "Bash", value: "bash install.sh", group: "installer" },
    { name: "Bash", value: "bash ./install.sh --with prs", group: "installer" },
    { name: "Bash", value: `${value.current.checkout}/install.sh`, group: "installer" },
    { name: "Bash", value: "~/checkout/install.sh --with prs", group: "installer" },
    {
      name: "Bash",
      value: `${value.current.checkout}/skills/playbook/bin/skills install`,
      group: "installer",
    },
    { name: "Bash", value: "~/.agents/skills/playbook/bin/skills install", group: "installer" },
    { name: "Bash", value: "skills install --with prs", group: "installer" },
    { name: "Bash", value: "rg -n install src" },
    { name: "Bash", value: "git diff" },
    { name: "Bash", value: "bun test" },
    { name: "Read", value: join(value.current.checkout, "install.sh") },
    { name: "Edit", value: value.settings, group: "claude-settings" },
  ];
}

function prompt(value: Fixture): string {
  const commands = expectations(value)
    .filter((entry) => entry.name === "Bash")
    .map((entry) => JSON.stringify(entry.value));

  return [
    "This is a permission verification with harmless executable stubs.",
    "Run each following command verbatim as its own Bash tool call, in order.",
    "Continue after every denial. Do not combine, rewrite, retry or skip commands.",
    ...commands,
    `Then use Read on ${JSON.stringify(join(value.current.checkout, "install.sh"))}.`,
    `Then use Edit on ${JSON.stringify(value.settings)} to replace verification-before with verification-after.`,
    "Use Edit, not Bash or Write, for that replacement. Attempt it even if you expect a denial.",
    "Change nothing else. Do not ask questions or use any other tools.",
  ].join("\n");
}

function parseStream(text: string): Call[] {
  const calls = new Map<string, Call>();
  const results = new Map<string, NonNullable<Call["result"]>>();
  for (const line of text.split("\n").filter((line) => line.trim())) {
    const event = record(JSON.parse(line));
    const message = record(event.message);
    const blocks = Array.isArray(message.content) ? message.content : [];
    const metadata = Array.isArray(event.tool_result_meta) ? event.tool_result_meta : [];
    for (const block of blocks.map(record)) {
      if (event.type === "assistant" && block.type === "tool_use" && typeof block.id === "string")
        calls.set(block.id, {
          id: block.id,
          name: String(block.name),
          input: record(block.input),
        });

      if (
        event.type !== "user" ||
        block.type !== "tool_result" ||
        typeof block.tool_use_id !== "string"
      )
        continue;

      const meta = metadata
        .map(record)
        .find((entry) => entry.tool_use_id === block.tool_use_id || entry.id === block.tool_use_id);

      const permission = record(meta?.permission_decision);
      results.set(block.tool_use_id, {
        content: block.content,
        error: block.is_error === true,
        kind: typeof meta?.non_execution_kind === "string" ? meta.non_execution_kind : undefined,
        decision: typeof permission.decision === "string" ? permission.decision : undefined,
        source: typeof permission.source === "string" ? permission.source : undefined,
      });
    }
  }

  return [...calls.values()].map((call) => ({ ...call, result: results.get(call.id) }));
}

function run(value: Fixture, variant: (typeof variants)[number]): Run {
  const parsed = parseLevels(variant.content, groups);
  if (!parsed.levels || parsed.notes.length)
    throw new Error(`Invalid levels: ${parsed.notes.join(", ")}`);

  writeFileSync(value.settings, '{"verificationMarker":"verification-before"}\n');
  writeFileSync(value.current.conf, variant.content);
  const lines = applyClaudeRules({
    root,
    mode: "prs",
    config: {
      mode: "prs",
      names: [],
      notes: [],
      content: variant.content,
      invalid: false,
      path: value.current.conf,
    },
    home: value.home,
    path: value.settings,
    current: value.current,
    env: {},
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    managedPaths: [],
  });

  console.log(`\n${variant.label}`);
  for (const line of lines) console.log(line);

  const before = readFileSync(value.settings, "utf8");
  const child = spawnSync(
    "claude",
    [
      "-p",
      "--permission-mode",
      "bypassPermissions",
      "--output-format",
      "stream-json",
      "--verbose",
      prompt(value),
    ],
    {
      cwd: value.current.checkout,
      env: {
        ...process.env,
        HOME: value.home,
        CLAUDE_CONFIG_DIR: value.current.claude,
        PATH: `${value.bin}:${process.env.PATH ?? ""}`,
      },
      encoding: "utf8",
      timeout: 300_000,
      maxBuffer: 32 * 1024 * 1024,
    },
  );

  writeFileSync(join(value.home, `${variant.label}.jsonl`), child.stdout ?? "");
  if (child.error || child.status !== 0) console.error(child.error ?? child.stderr);

  return {
    label: variant.label,
    calls: parseStream(child.stdout ?? ""),
    before,
    after: readFileSync(value.settings, "utf8"),
    succeeded: !child.error && child.status === 0,
  };
}

function findCall(run: Run, expected: Expectation): Call | undefined {
  return run.calls.find(
    (call) =>
      call.name === expected.name &&
      (expected.name === "Bash"
        ? call.input.command === expected.value
        : call.input.file_path === expected.value),
  );
}

function renderedRule(value: Fixture, expected: Expectation): string | undefined {
  const entries = groups.find((group) => group.id === expected.group)?.entries ?? [];
  const rendered = entries.flatMap((entry) => expandEntry(entry, value.current, value.home));
  if (expected.name === "Edit") return rendered[0];

  return rendered.find((entry) => {
    const prefix = entry.slice("Bash(".length, -" *)".length);
    const expanded = prefix.replace(/^~\//, `${value.home}/`);
    const actual = expected.value.replace(/^~\//, `${value.home}/`);
    return actual === expanded || actual.startsWith(`${expanded} `);
  });
}

function check(value: Fixture, runs: Run[]): void {
  for (const run of runs) {
    report(run.succeeded, `${run.label}: Claude process completed`);

    for (const expected of expectations(value)) {
      const call = findCall(run, expected);
      const label = `${run.label}: ${expected.name} ${expected.value}`;
      if (!call) {
        report(false, `${label}: not attempted`);
        continue;
      }

      const disabled = run.label === `${expected.group}-off`;
      const refused = Boolean(expected.group) && !disabled;
      const result = call.result;
      const kind = expected.group === "installer" ? "permission-rule" : "user-rejected";
      const ok = refused
        ? result?.error === true &&
          result.kind === kind &&
          result.decision === "reject" &&
          result.source === "config"
        : result?.error === false &&
          result.decision === "accept" &&
          (expected.group !== "installer" || JSON.stringify(result.content).includes("STUB-RAN"));

      const rule = renderedRule(value, expected);

      report(
        ok,
        `${label}: ${refused ? `refused by group ${expected.group} (rule ${rule ?? "not found"})` : "accepted"}${ok ? "" : `, result ${JSON.stringify(result)}`}`,
      );

      if (refused) report(Boolean(rule), `${label}: rendered group rule found`);
    }

    const settingsOff = run.label === "claude-settings-off";
    report(
      settingsOff
        ? run.after === run.before.replace("verification-before", "verification-after")
        : run.after === run.before,
      `${run.label}: settings bytes ${settingsOff ? "changed only as requested" : "unchanged"}`,
    );
  }

  const full = runs.find((run) => run.label === "full")!;
  for (const expected of expectations(value).filter((entry) => entry.group)) {
    const control = runs.find((run) => run.label === `${expected.group}-off`)!;
    const rejected = findCall(full, expected)?.result;
    const accepted = findCall(control, expected)?.result;

    report(
      rejected?.decision === "reject" && accepted?.decision === "accept",
      `${expected.value}: refusal attributed to group ${expected.group} by elimination`,
    );
  }
}

function main(): void {
  const version = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (version.error || version.status !== 0) {
    console.error(
      `Cannot run claude --version. Put Claude Code on PATH. ${version.error ?? version.stderr}`,
    );

    process.exitCode = 1;
    return;
  }

  console.log(version.stdout.trim());
  const home = realpathSync(mkdtempSync(join(tmpdir(), "verify-claude-rules-")));
  try {
    const value = fixture(home);
    const runs = variants.map((variant) => run(value, variant));

    check(value, runs);
    process.exitCode = mismatches ? 1 : 0;
  } catch (error) {
    console.error(`MISMATCH  ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  } finally {
    if (process.env.KEEP === "1") console.log(`Kept ${home}`);
    else rmSync(home, { recursive: true, force: true });
  }
}

main();
