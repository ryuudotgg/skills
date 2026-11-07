import { expect, test } from "bun:test";
import { installReport, type ReportOptions, type Section } from "./report.ts";

const home = "/home/me";

type Step =
  | string
  | { section: Section }
  | { same: string }
  | { text: string }
  | { absent: [Section, string, string] };

function play(steps: readonly Step[], options: Partial<ReportOptions> = {}): string {
  let written = "";
  const value = installReport({
    write: (text) => {
      written += text;
    },
    pretty: true,
    verbose: false,
    color: false,
    width: 100,
    home,
    ...options,
  });

  for (const step of steps)
    if (typeof step === "string") value.line(step);
    else if ("section" in step) value.section(step.section);
    else if ("same" in step) value.line(step.same, true);
    else if ("text" in step) value.text(step.text);
    else value.absent(...step.absent);

  value.end();
  return written;
}

const fresh: readonly Step[] = [
  "mode   prs",
  "with   greptile",
  "",
  { section: "skills" },
  "skill  playbook",
  { same: "skill  tdd" },
  "off    macroscope",
  `linked into ${home}/.claude/skills`,
  { section: "claude" },
  "agent  opus-review",
  { same: "agent  playbook-agent" },
  "claude add Stop ~/.agents/skills/playbook/bin/skills hook stop",
  "rules  merge add 2 to deny",
  `config ${home}/.agents/skills.conf`,
  `skip   tdd (${home}/.claude/agents/tdd.md is personal, left in place)`,
  { section: "codex" },
  {
    text: `codex  add Stop ${home}/.agents/skills/playbook/bin/skills hook stop\ncodex  ${home}/.codex/hooks.json (open codex, run /hooks, trust the new entries once)\n`,
  },
  "skip   codex installer Bash(skills install) (no Codex prefix rule can express this)",
  "codex  merge add forbidden",
  { section: "opencode" },
  `opencode ${home}/.config/opencode/plugins/skills.ts`,
  `opencode ${home}/.config/opencode/commands/tdd.md`,
  `opencode ${home}/.config/opencode/commands/how.md`,
  "opencode merge add deny",
  'note   opencode saved "always" approvals and --auto approve asks; only deny holds',
  `opencode ${home}/.config/opencode/opencode.jsonc`,
];

const noClaude: Step = {
  absent: ["claude", "Done. No Claude Code install found.", "not found, agents and hooks skipped"],
};

test("piped output keeps one line per item, byte for byte", () => {
  const steps: Step[] = [
    "mode   prs",
    "",
    { section: "skills" },
    { same: "skill  tdd" },
    { text: "codex  a\ncodex  b\n" },
    noClaude,
  ];

  expect(play(steps, { pretty: false, verbose: true })).toBe(
    "mode   prs\n\nskill  tdd\ncodex  a\ncodex  b\nDone. No Claude Code install found.\n",
  );
});

test("a terminal gets one row per tool with counts and only what needs a look", () => {
  expect(play(fresh)).toBe(
    [
      "",
      "skills · prs mode · greptile",
      "",
      "  Config       ~/.agents/skills.conf saved",
      "  Skills       1 linked, 1 up to date",
      "  Claude Code  1 agent, 1 hook, 1 rule group updated",
      "               skip   tdd (~/.claude/agents/tdd.md is personal, left in place)",
      "  Codex        1 hook, 1 rule group updated",
      "               codex  ~/.codex/hooks.json (open codex, run /hooks, trust the new entries once)",
      "  OpenCode     1 plugin, 2 commands, 1 rule group updated",
      "",
    ].join("\n"),
  );
});

test("a rerun with nothing to do says up to date", () => {
  const steps: Step[] = [
    "mode   hands-off",
    { section: "skills" },
    { same: "skill  playbook" },
    { same: "skill  tdd" },
    { section: "claude" },
    { same: "agent  opus-review" },
    { section: "codex" },
    { text: `codex  ${home}/.codex/hooks.json already holds every skills hook\n` },
  ];

  expect(play(steps)).toBe(
    [
      "",
      "skills · hands-off mode",
      "",
      "  Skills       2 up to date",
      "  Claude Code  up to date",
      "  Codex        up to date",
      "",
    ].join("\n"),
  );
});

test("--verbose lists every line under its tool", () => {
  const lines = play(fresh, { verbose: true }).split("\n");

  expect(lines).toContain("               skill  tdd");
  expect(lines).toContain("               off    macroscope");
  expect(lines).toContain("               linked into ~/.claude/skills");
  expect(lines).toContain(
    "               skip   codex installer Bash(skills install) (no Codex prefix rule can express this)",
  );

  expect(lines).toContain(
    '               note   opencode saved "always" approvals and --auto approve asks; only deny holds',
  );

  expect(lines.indexOf("  Codex        1 hook, 1 rule group updated")).toBeLessThan(
    lines.indexOf("               codex  merge add forbidden"),
  );
});

test("an unwritten rule set collapses to one line unless --verbose", () => {
  const heading = `Rule set for prs mode, not written (${home}/.agents/skills.conf: AGENT_RULES is unset). Add it to permissions in ${home}/.claude/settings.json yourself:`;
  const steps: Step[] = [
    "mode   prs",
    { section: "claude" },
    heading,
    '"deny": [\n  "Bash(gh pr merge:*)"\n]',
    "note   Claude hooks were written but do not run because settings disable user hooks",
  ];

  const short = play(steps, { width: 200 });
  const verbose = play(steps, { width: 200, verbose: true });

  expect(short).toContain(
    [
      "  Claude Code  up to date",
      "               rules  prs rule set not written (~/.agents/skills.conf: AGENT_RULES is unset); ./install.sh --verbose prints it to paste",
      "               note   Claude hooks were written but do not run because settings disable user hooks",
    ].join("\n"),
  );

  expect(short).not.toContain("gh pr merge");
  expect(verbose).toContain(
    [
      `               ${heading.replaceAll(`${home}/`, "~/")}`,
      '               "deny": [',
      '                 "Bash(gh pr merge:*)"',
      "               ]",
    ].join("\n"),
  );
});

test("a block to paste is shown whole, with its paths left absolute", () => {
  const steps: Step[] = [
    "mode   prs",
    { section: "claude" },
    `skip   ${home}/.claude/settings.json (it is not valid JSON)`,
    "Paste the Claude Code hooks block: https://skills.ryuu.gg/agents/claude-code",
    `{\n  "command": "${home}/.agents/skills/playbook/bin/skills hook stop"\n}`,
  ];

  expect(play(steps)).toContain(
    [
      "               Paste the Claude Code hooks block: https://skills.ryuu.gg/agents/claude-code",
      "               {",
      `                 "command": "${home}/.agents/skills/playbook/bin/skills hook stop"`,
      "               }",
    ].join("\n"),
  );
});

test("long lines wrap under their text, never inside a word", () => {
  const text = `skills-cli add 100 to allow (weakening, stdin is not a terminal; edit ${home}/.claude/settings.json by hand to apply it)`;
  const lines = play(["mode   prs", { section: "claude" }, `left   ${text}`], {
    width: 60,
  }).split("\n");

  const shown = lines.slice(lines.indexOf("  Claude Code  up to date") + 1, -1);

  expect(shown.length).toBeGreaterThan(2);
  expect(shown[0]!.startsWith("               left   skills-cli ")).toBe(true);
  for (const line of shown) expect(line.length).toBeLessThan(60);
  for (const line of shown.slice(1)) expect(line).toMatch(/^ {22}\S/);
  expect(shown.map((line) => line.trim()).join(" ")).toBe(
    `left   ${text.replaceAll(`${home}/`, "~/")}`,
  );
});

test("a missing Claude Code install is named on its row", () => {
  const written = play(["mode   hands-off", { section: "skills" }, "skill  playbook", noClaude]);
  expect(written).toContain("  Claude Code  not found, agents and hooks skipped\n");
  expect(written).not.toContain("Done.");
});

test("color only when asked, and nothing at all before anything happened", () => {
  const plain = play(fresh);
  const colored = play(fresh, { color: true });

  expect(plain).not.toContain("\u001b[");
  expect(colored).toContain("\u001b[32m1 linked\u001b[39m");
  expect(Bun.stripANSI(colored)).toBe(plain);
  expect(play([])).toBe("");
});

test("~ stands in for the home directory only where a path starts", () => {
  const line = `warn   ${home}/.claude (in /mnt${home}/old, "${home}/x")`;
  const url = "note   see https://skills.ryuu.gg/agents";

  expect(play([{ section: "claude" }, line], { width: 200 })).toContain(
    `warn   ~/.claude (in /mnt${home}/old, "~/x")`,
  );

  expect(play([{ section: "claude" }, url], { home: "/", width: 200 })).toContain(url);
});
