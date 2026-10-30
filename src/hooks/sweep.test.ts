import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fixtureGit } from "../test/fixtures.ts";
import { check as afterEdit } from "./post-tool-use.ts";
import { guardOutput } from "./pre-tool-use.ts";
import { check as atStop } from "./stop.ts";

const PUBLISH = '~/.agents/skills/playbook/bin/skills publish -m "fix: x" a.ts';

let scratch: string;
let repo: string;
let env: NodeJS.ProcessEnv;

function put(name: string, text: string): void {
  writeFileSync(join(repo, name), text);
}

function payload(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { session_id: "s1", cwd: repo, scratchpad_dir: scratch, ...extra };
}

async function before(
  command: string,
  extra: Record<string, unknown> = {},
  overrides: NodeJS.ProcessEnv = {},
): Promise<string> {
  const input = payload({
    hook_event_name: "PreToolUse",
    tool_name: "Bash",
    tool_input: { command },
    ...extra,
  });

  const output = await guardOutput(JSON.stringify(input), join(scratch, "skills"), {
    ...env,
    ...overrides,
  });

  return output ? JSON.parse(output).hookSpecificOutput.permissionDecisionReason : "";
}

function stop(): string | undefined {
  return atStop(payload({ hook_event_name: "Stop", last_assistant_message: "Done." }), env);
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), "skills-sweep-"));
  repo = join(scratch, "repo");
  mkdirSync(repo);
  writeFileSync(join(scratch, "skills.conf"), "DELIVERY=prs\n");
  env = { AGENT_HOOKS: "1", HOME: scratch, SKILLS_CONF: join(scratch, "skills.conf") };

  await fixtureGit(repo, ["init", "-q"]);
  await fixtureGit(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("CommentSweep", () => {
  test("publishing lists new comment lines once, then lets the same command through", async () => {
    put("a.ts", "// written by a heredoc\nexport {};\n");

    const reason = await before(PUBLISH);
    expect(reason).toContain("since HEAD:");
    expect(reason).toContain("a.ts:1  // written by a heredoc");
    expect(reason).toContain("Then run the command again.");

    expect(await before(PUBLISH)).toBe("");
    expect(stop()).toBeUndefined();
  });

  test("a fix round, an allowed commit and a commit in another directory are swept", async () => {
    put("a.ts", "// before the fix round\nexport {};\n");
    expect(await before('skills fix-round -m "fix: y" a.ts')).toContain("before the fix round");

    put("b.ts", "// before the commit\nexport {};\n");
    expect(await before('git commit -m "fix: y"')).toContain("before the commit");

    put("c.ts", "// in another directory\nexport {};\n");
    expect(await before('git -C repo commit -m "fix: z"', { cwd: scratch })).toContain(
      "in another directory",
    );

    put("d.ts", "// under the home directory\nexport {};\n");
    expect(await before('git -C ~/repo commit -m "fix: w"', { cwd: "/" })).toContain(
      "under the home directory",
    );
  });

  test("commands that ship nothing, sessionless hosts and AGENT_HOOKS=0 are not swept", async () => {
    put("a.ts", "// still unseen\nexport {};\n");

    expect(await before("ls && git status")).toBe("");
    expect(await before(PUBLISH, { session_id: undefined })).toBe("");
    expect(await before(PUBLISH, {}, { AGENT_HOOKS: "0" })).toBe("");
    expect(stop()).toContain("still unseen");
  });

  test("the delivery mode's denial comes before the sweep", async () => {
    put("a.ts", "// unseen in hands-off\nexport {};\n");
    writeFileSync(join(scratch, "skills.conf"), "DELIVERY=hands-off\n");

    const reason = await before('git commit -m "fix: x"');
    expect(reason).toContain("hands-off mode");
    expect(reason).not.toContain("unseen in hands-off");
  });

  test("a comment flagged when it was written is not listed again", async () => {
    const text = "// flagged by the edit hook\nexport {};\n";
    put("a.ts", text);

    const flagged = afterEdit(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(repo, "a.ts"), content: text },
      }),
      env,
    );

    expect(flagged).toContain("flagged by the edit hook");
    expect(await before(PUBLISH)).toBe("");
    expect(stop()).toBeUndefined();
  });

  test("only the comment lines an edit showed count as seen", async () => {
    const text = Array.from({ length: 7 }, (_, index) => `// note ${index + 1}\n`).join("");
    put("a.ts", text + "export {};\n");

    const flagged = afterEdit(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: join(repo, "a.ts"), content: text },
      }),
      env,
    );

    expect(flagged).toContain("and 1 more");

    const reason = await before(PUBLISH);
    expect(reason).toContain("note 7");
    expect(reason).not.toContain("note 6");
  });

  test("a shipping command sweeps the directory it runs in", async () => {
    put("a.ts", "// reached through cd\nexport {};\n");
    expect(await before('cd repo && skills publish -m "fix: x" a.ts', { cwd: scratch })).toContain(
      "reached through cd",
    );

    put("b.ts", "// reached through home\nexport {};\n");
    expect(
      await before('cd ~/repo && skills publish -m "fix: x" b.ts', { cwd: join(scratch, "..") }),
    ).toContain("reached through home");

    put("c.ts", "// reached through workdir\nexport {};\n");
    expect(
      await before("", {
        cwd: scratch,
        tool_input: { command: 'skills publish -m "fix: x" c.ts', workdir: "repo" },
      }),
    ).toContain("reached through workdir");
  });

  test("only a skills command word triggers the sweep", async () => {
    put("a.ts", "// not swept for an echo\nexport {};\n");
    expect(await before("echo skills publish")).toBe("");
    expect(await before('SKILLS_OWN_ROWS="a b" skills fix-round -m "fix: x" a.ts')).toContain(
      "not swept for an echo",
    );
  });

  test("a stop block on comments asks for the whole reply again", () => {
    put("a.ts", "// left for the stop sweep\nexport {};\n");

    const reason = stop();
    expect(reason).toContain("left for the stop sweep");
    expect(reason).toContain("Then send your whole reply again");
    expect(reason).toContain("say nothing about this check");
  });
});
