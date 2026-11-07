import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fixtureGit } from "../test/fixtures.ts";
import { startCommand, suiteEnvironment } from "../test/process.ts";
import { storedEvents } from "../test/stored-events.ts";
import { rules } from "./guards.ts";
import { hostOf } from "./blocks.ts";
import { verdict as postVerdict } from "./post-tool-use.ts";
import { guard } from "./pre-tool-use.ts";
import { verdict as stopVerdict } from "./stop.ts";

const repoRoot = resolve(import.meta.dir, "../../../..");
const bin = join(repoRoot, "skills/playbook/bin/skills");

let temporary: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "hook-blocks-"));
  mkdirSync(join(temporary, "home"));
  env = { ...suiteEnvironment(), HOME: join(temporary, "home"), AGENT_HOOKS: "1" };
  delete env.AGENTS_DIR;
  delete env.AGENT_HOOKS_SKIP;
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

test("the rule table names every guard and leaves session-brief without ids", () => {
  expect(Object.keys(rules)).toEqual([
    "session-brief",
    "commit-guard",
    "no-comments",
    "no-em-dash",
    "reply-guard",
  ]);

  expect(rules["session-brief"]).toEqual([]);
});

describe("pre-tool-use rule ids", () => {
  let root: string;

  beforeEach(() => {
    root = join(temporary, "skills");
    const greptile = join(root, "greptile");
    mkdirSync(greptile, { recursive: true });
    writeFileSync(
      join(greptile, "SKILL.md"),
      "---\nname: greptile\ndescription: Reviewer extension.\noptional: true\nrequires: prs\n---\n",
    );

    writeFileSync(
      join(greptile, "reviewer.conf"),
      readFileSync(join(repoRoot, "skills/greptile/reviewer.conf"), "utf8"),
    );
  });

  async function ruleFor(input: unknown, delivery = "prs"): Promise<string | undefined> {
    const conf = join(temporary, "skills.conf");
    writeFileSync(conf, `DELIVERY=${delivery}\n`);

    const text = typeof input === "string" ? input : JSON.stringify(input);
    return (await guard(text, root, { ...env, SKILLS_CONF: conf })).rule;
  }

  const bash = (command: string) => ({
    tool_name: "Bash",
    cwd: temporary,
    tool_input: { command },
  });

  for (const [command, rule, delivery] of [
    ["git config skills.greptile.mode auto", "commit-guard/setting"],
    ['git add -A && git commit -m "fix"', "commit-guard/commit-shape"],
    ['gh pr comment 12 --body "x" && ls', "commit-guard/comment-shape"],
    ["git push --force origin feat/x", "commit-guard/push"],
    ["bash -c 'git commit -m x'", "commit-guard/unparsed"],
    [`git commit -m "fix: ${"x".repeat(50)}"`, "commit-guard/message-length"],
    ['git commit -m "fixed it"', "commit-guard/message-prefix"],
    ['git commit -m "fix: a"', "commit-guard/hands-off-commit", "hands-off"],
    ["git push origin feat/x", "commit-guard/hands-off-push", "hands-off"],
    ['gh pr comment 12 --body "hello"', "commit-guard/comment-inactive"],
    ["git push origin feat/x", "commit-guard/push-refused"],
    ['git commit -m "fix: a"', undefined],
    ["ls", undefined],
  ] as const)
    test(`${command} in ${delivery ?? "prs"} mode is ${rule ?? "allowed"}`, async () => {
      expect(await ruleFor(bash(command), delivery)).toBe(rule);
    });

  test("an unreadable payload is commit-guard/unreadable", async () => {
    expect(await ruleFor("not json")).toBe("commit-guard/unreadable");
  });
});

describe("stop and post-tool-use rule ids", () => {
  test("every reply finding reports its own id, in the order the reason names them", () => {
    const reply =
      "Done -- see below. Let me know if anything else.\n**Note:** shipped.\nhttps://github.com/o/r/pull/1\n```text\nSee src/main.ts and plan 12 with `x`.\n```";

    expect(stopVerdict({ last_assistant_message: reply, cwd: "" }, env)?.rules).toEqual([
      "reply-guard/draft-path",
      "reply-guard/draft-plan-id",
      "reply-guard/draft-backtick",
      "reply-guard/dash",
      "reply-guard/filler",
      "reply-guard/bold-label",
    ]);

    expect(stopVerdict({ last_assistant_message: "All done.", cwd: "" }, env)).toBeUndefined();
  });

  test("a tool the hook does not cover, a dash and a comment line each report their id", () => {
    expect(postVerdict({ tool_name: "Read", tool_input: {} }, env)?.rules).toEqual([
      "no-comments/unguarded",
    ]);

    const path = join(temporary, "note.ts");
    const text = "// explains the next line\nconst a = 1; \u2014\n";
    writeFileSync(path, text);
    expect(
      postVerdict(
        { tool_name: "Write", cwd: temporary, tool_input: { file_path: path, content: text } },
        env,
      )?.rules,
    ).toEqual(["no-em-dash/dash", "no-comments/comment"]);
  });
});

test("host reads the OpenCode mark, then Codex tool names, commands and transcripts", () => {
  expect(hostOf({ host: "opencode", tool_name: "apply_patch" })).toBe("opencode");
  expect(hostOf({ tool_name: "apply_patch" })).toBe("codex");
  expect(hostOf({ tool_name: "Bash", turn_id: "t1", tool_input: { command: "ls" } })).toBe("codex");
  expect(hostOf({ tool_name: "Bash", tool_input: { command: ["git", "status"] } })).toBe("codex");
  expect(hostOf({ transcript_path: "/Users/a/.codex/sessions/2026/x.jsonl" })).toBe("codex");

  expect(hostOf({ tool_name: "Bash", tool_input: { command: "ls" } })).toBe("claude");
  expect(hostOf({ transcript_path: "/Users/a/.claude/projects/x.jsonl" })).toBe("claude");
});

describe("hook-block events through the CLI", () => {
  let plans: string;
  let checkout: string;

  beforeEach(async () => {
    plans = join(temporary, "plans");
    checkout = join(temporary, "Alpha");
    mkdirSync(join(plans, "Alpha"), { recursive: true });
    mkdirSync(checkout);
    writeFileSync(
      join(plans, "Alpha/index.tsv"),
      "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n" +
        "001\tshell\tDOING\tP1\tS\t-\t-\tfeat/shell\t2026-11-07\t-\n",
    );

    await fixtureGit(temporary, ["init", "--quiet", "-b", "feat/shell", checkout]);
  });

  async function hook(verb: string, payload: object, extra: NodeJS.ProcessEnv = {}) {
    const { child, result } = startCommand([bin, "hook", verb], {
      cwd: checkout,
      env: { ...env, PLANS_DIR: plans, ...extra },
      input: true,
    });

    child.stdin!.end(JSON.stringify(payload));
    return result;
  }

  const reply = {
    hook_event_name: "Stop",
    session_id: "s260",
    cwd: "",
    stop_hook_active: false,
    last_assistant_message: "Done -- see below.",
  };

  test("a block records its rules, host, project and the row its branch maps to", async () => {
    const result = await hook("stop", { ...reply, cwd: checkout, scratchpad_dir: temporary });

    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).decision).toBe("block");
    expect(storedEvents(plans, "hook-block")).toEqual([
      {
        project: "Alpha",
        plan: "001",
        payload: { rules: ["reply-guard/dash"], host: "claude" },
      },
    ]);

    const off = await hook("stop", { ...reply, cwd: checkout }, { AGENT_HOOKS: "0" });
    expect([off.code, off.stdout]).toEqual([0, ""]);
    expect(storedEvents(plans, "hook-block")).toHaveLength(1);

    expect(existsSync(join(plans, "log.tsv"))).toBe(false);
  });

  test("pre-tool-use and post-tool-use record their block after printing it", async () => {
    const denied = await hook("pre-tool-use", {
      tool_name: "Bash",
      cwd: checkout,
      tool_input: { command: 'git add -A && git commit -m "fix"' },
    });

    expect(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision).toBe("deny");

    const path = join(checkout, "note.md");
    const text = "one \u2014 two\n";
    writeFileSync(path, text);
    const flagged = await hook("post-tool-use", {
      tool_name: "apply_patch",
      cwd: checkout,
      tool_input: {
        command: `*** Begin Patch\n*** Add File: ${path}\n+${text.trimEnd()}\n*** End Patch`,
      },
    });

    expect(JSON.parse(flagged.stdout).decision).toBe("block");
    expect(storedEvents(plans, "hook-block").map(({ plan, payload }) => [plan, payload])).toEqual([
      ["001", { rules: ["commit-guard/commit-shape"], host: "claude" }],
      ["001", { rules: ["no-em-dash/dash"], host: "codex" }],
    ]);
  });

  test("a locked store keeps the verdict and prints nothing extra", async () => {
    await hook("stop", { ...reply, cwd: checkout, scratchpad_dir: temporary });

    const holder = new Database(join(plans, "plans.db"));
    holder.run("BEGIN EXCLUSIVE");
    try {
      const started = performance.now();
      const result = await hook("stop", {
        ...reply,
        session_id: "locked",
        cwd: checkout,
        scratchpad_dir: temporary,
      });

      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout).decision).toBe("block");
      expect(performance.now() - started).toBeLessThan(2000);
    } finally {
      holder.run("ROLLBACK");
      holder.close();
    }

    expect(storedEvents(plans, "hook-block")).toHaveLength(1);
  });
});
