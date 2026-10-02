import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { check } from "./stop.ts";
import { fixtureGit } from "../test/fixtures.ts";
import { startCommand, suiteEnvironment } from "../test/process.ts";

const directories: string[] = [];
let scratch: string;
let repo: string;

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "skills-stop-"));
  directories.push(directory);
  return directory;
}

function put(path: string, text: string): void {
  writeFileSync(path, text);
}

function hook(payload: unknown): string | undefined {
  return check(payload, { AGENT_HOOKS: "1" });
}

function stop(message: string, extra: Record<string, unknown> = {}): string | undefined {
  return hook({
    hook_event_name: "Stop",
    session_id: "s1",
    cwd: repo,
    scratchpad_dir: scratch,
    last_assistant_message: message,
    ...extra,
  });
}

function draft(body: string, closing = "```"): string {
  return "https://github.com/o/r/pull/12#discussion_r99\n```text\n" + body + "\n" + closing;
}

async function git(...args: string[]): Promise<string> {
  return (await fixtureGit(repo, ["-c", "commit.gpgsign=false", ...args])).trim();
}

async function commitFile(name: string, text: string): Promise<void> {
  put(join(repo, name), text);
  await git("add", name);
  await git("commit", "-q", "-m", name);
}

async function branchFromMain(name: string, base?: string): Promise<void> {
  await git("branch", "-M", "main");
  await git("checkout", "-q", "-b", name);
  if (base) await git("config", "branch." + name + ".skills-base", base);
}

async function trackOriginMain(): Promise<void> {
  await git("branch", "-M", "main");
  await git("update-ref", "refs/remotes/origin/main", await git("rev-parse", "HEAD"));
  await git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
}

beforeEach(async () => {
  scratch = temporary();
  repo = join(scratch, "repo");
  mkdirSync(repo);

  await git("init", "-q");
  await git("commit", "-q", "--allow-empty", "-m", "init");
});

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("ReplyGuard", () => {
  test("test_clean_reply_passes", () => {
    expect(
      stop("Done. The hook blocks on dashes and `a -- b` in code is fine.\n\n```\nx \u2014 y\n```"),
    ).toBeUndefined();
  });

  test("test_dash_blocks", () => {
    expect(stop("The key moved \u2014 one switch drives both.")).toContain("dash");
    expect(stop("The key moved - one switch drives both.")).toContain("dash");
  });

  test("test_list_bullets_are_not_dashes", () => {
    expect(stop("Changes:\n- moved the key\n- added a row\n")).toBeUndefined();
  });

  test("test_filler_and_labels_block", () => {
    const out = stop("Great question! **Performance:** it improved.");
    expect(out).toContain("Great question");
    expect(out).toContain("bold label");
  });

  test("test_drafted_reply_prose_passes", () => {
    const message =
      "https://github.com/o/r/pull/12#discussion_r99\n```text\nThis is intended. Outside a git repo there's no root to judge from, so a file you name on the command line gets formatted instead of being silently dropped because a directory on its path is called dist or build. Directory scans still skip dist below the argument, and inside a repo an explicitly named file under dist or node_modules is still skipped, since it's judged from the repo root. Tests for both cases are in 14ca3f1.\n```";

    expect(stop(message)).toBeUndefined();
  });

  test("test_drafted_reply_paths_block", () => {
    for (const token of ["tests/files.test.ts", "dist/a.ts", "~/Plans", "src/main.ts:42"])
      expect(stop(draft("See " + token + "."))).toContain(token);
  });

  test("test_drafted_reply_closing_fence_may_trail_spaces", () => {
    const reason = stop(draft("See dist/a.ts.", "```  ") + "\n\n```ts\nx\n```");
    expect(reason).toContain("dist/a.ts");
    expect(reason).not.toContain("backtick");
  });

  test("test_text_block_without_thread_is_not_a_draft", () => {
    expect(stop("Changed files:\n```text\nsrc/main.ts \u2014 `x`\n```")).toBeUndefined();
  });

  test("test_drafted_reply_plan_id_blocks", () => {
    for (const body of [
      "It lands in the Hooks batch (plan 090).",
      "Plans 89 and 90 cover it.",
      "See Plan #29.",
      "See plan#29.",
      "It lands in the batch plan\n090 covers.",
    ])
      expect(stop(draft(body))).toContain("plan id");
  });

  test("test_plan_id_outside_draft_passes", () => {
    expect(stop("Plan 089 is done.")).toBeUndefined();
  });

  test("test_drafted_reply_plan_word_passes", () => {
    for (const body of ["The plan was 2 steps, both in 14ca3f1.", "The service plans 3 retries."])
      expect(stop(draft(body))).toBeUndefined();
  });

  test("test_unsaved_state_lets_rewrites_through", () => {
    const blocker = join(scratch, "not-a-dir");
    put(blocker, "");
    const unwritable = join(blocker, "scratch");
    expect(stop("x \u2014 y", { scratchpad_dir: unwritable })).toContain("dash");
    expect(
      stop("x \u2014 y", { scratchpad_dir: unwritable, stop_hook_active: true }),
    ).toBeUndefined();
  });

  test("test_malformed_state_still_checks", () => {
    for (const state of ["null", '{"seen": 1}', '{"rewrites": "x"}', "3"]) {
      put(join(scratch, "reply-guard-s1.json"), state);
      expect(stop("x \u2014 y")).toContain("dash");
    }
  });

  test("test_drafted_reply_backtick_blocks", () => {
    expect(stop(draft("Use `code`."))).toContain("backtick");
  });

  test("test_drafted_reply_urls_are_not_paths", () => {
    expect(stop(draft("See https://github.com/o/r/pull/12 for context."))).toBeUndefined();
  });

  test("test_drafted_reply_reports_each_prose_rule_once", () => {
    const message =
      "Outside \u2014 prose.\n" +
      draft("First \u2014 draft.") +
      "\n" +
      draft("Second \u2014 draft.");

    expect(stop(message)!.split("a dash used as punctuation").length - 1).toBe(1);
  });

  test("test_drafted_reply_dash_blocks", () => {
    expect(stop(draft("This moved \u2014 it works."))).toContain("dash");
  });

  test("test_draft_blockquote_under_pr_link_blocks", () => {
    for (const line of [
      "https://github.com/o/r/pull/12",
      "Thread https://github.com/o/r/pull/12#discussion_r9 says",
    ])
      expect(stop(line + "\n\n> This is the reply.")).toContain("```text");
  });

  test("test_blockquote_without_pr_link_passes", () => {
    expect(stop("> This is a quotation.")).toBeUndefined();
  });

  test("test_other_fences_stay_exempt", () => {
    for (const fence of ["```", "```ts"])
      expect(stop(fence + "\ntests/files.test.ts \u2014 still code\n```")).toBeUndefined();
  });

  test("test_tree_comments_reported_once", () => {
    const path = join(repo, "a.ts");
    put(path, "// added by a delegate\nconst a = 1;\n");
    const out = stop("Done.");
    expect(out).toContain("added by a delegate");
    expect(stop("Done.")).toBeUndefined();
  });

  test("test_tracked_file_only_added_lines", async () => {
    const path = join(repo, "b.py");
    put(path, "# old comment\nx = 1\n");
    await git("add", "b.py");
    await git("commit", "-q", "-m", "b");

    put(path, "# old comment\nx = 1\n# new comment\ny = 2\n");
    const out = stop("Done.");
    expect(out).toContain("new comment");
    expect(out).not.toContain("old comment");
  });

  test("test_committed_comment_since_recorded_base_is_reported", async () => {
    await branchFromMain("feat/x", "main");
    await commitFile("delegate.py", "# committed by a delegate\n");
    expect(stop("Done.")).toContain("committed by a delegate");
  });

  test("test_parent_layer_comment_below_recorded_base_is_not_reported", async () => {
    await branchFromMain("feat/parent");
    await commitFile("parent.py", "# parent layer comment\n");
    await git("checkout", "-q", "-b", "feat/child");
    await git("config", "branch.feat/child.skills-base", "feat/parent");
    await commitFile("child.py", "# child layer comment\n");

    const reason = stop("Done.");
    expect(reason).toContain("child layer comment");
    expect(reason).not.toContain("parent layer comment");
  });

  test("test_without_recorded_base_uses_remote_default_merge_base", async () => {
    await trackOriginMain();
    await git("checkout", "-q", "-b", "feat/y");
    await commitFile("without_base.py", "# committed without base\n");
    expect(stop("Done.")).toContain("committed without base");
  });

  test("test_on_default_branch_committed_comments_stay_hidden", async () => {
    await trackOriginMain();
    await commitFile("main.py", "# committed on main\n");
    expect(stop("Done.")).toBeUndefined();
  });

  test("test_outside_a_repository_reports_nothing", () => {
    const outside = temporary();
    put(join(outside, "stray.py"), "# stray comment\n");
    const payload = {
      hook_event_name: "Stop",
      session_id: "outside",
      cwd: outside,
      scratchpad_dir: scratch,
      last_assistant_message: "Done.",
    };

    expect(hook(payload)).toBeUndefined();
  });

  test("test_subdirectory_cwd_still_scans_tree", () => {
    const sub = join(repo, "pkg");
    mkdirSync(sub, { recursive: true });
    put(join(sub, "c.ts"), "// deep comment\nexport {};\n");
    const payload = {
      hook_event_name: "Stop",
      session_id: "s2",
      cwd: sub,
      scratchpad_dir: scratch,
      last_assistant_message: "Done.",
    };

    expect(hook(payload)).toContain("pkg/c.ts:1");
  });

  test("test_only_displayed_findings_are_marked_seen", () => {
    put(
      join(repo, "many.py"),
      Array.from({ length: 12 }, (_, index) => "# c" + index + "\n").join("") + "x = 1\n",
    );

    const first = stop("Done.");
    expect(first).toContain("and 4 more");
    const second = stop("Done.");
    expect(second).toContain("c11");
    expect(second).not.toContain("c0 ");
  });

  test("test_non_ascii_path_and_rename_are_scanned", async () => {
    put(join(repo, "caf\u00e9.ts"), "// accent path\nexport {};\n");
    put(join(repo, "old.py"), "x = 1\n");
    await git("add", "old.py");
    await git("commit", "-q", "-m", "old");
    await git("mv", "old.py", "new.py");

    put(join(repo, "new.py"), "x = 1\n# added during move\n");
    await git("add", "new.py");

    const reason = stop("Done.");
    expect(reason).toContain("accent path");
    expect(reason).toContain("added during move");
  });

  test("tracked paths git quotes or pads are scanned", async () => {
    for (const name of ['tab\t"quote.ts', "with space.ts"]) await commitFile(name, "export {};\n");

    put(join(repo, 'tab\t"quote.ts'), "export {};\n// quoted path narration\n");
    put(join(repo, "with space.ts"), "export {};\n// spaced path narration\n");

    const reason = stop("Done.");
    expect(reason).toContain("quoted path narration");
    expect(reason).toContain("spaced path narration");
  });

  test("diff drivers and prefixes in the user's config do not hide the sweep", async () => {
    await commitFile("a.ts", "a();\n// old untouched\nb();\n");
    put(join(repo, "a.ts"), "// seen past the drivers\na();\n// old untouched\nb();\n// second\n");

    const reason = check(
      { cwd: repo, scratchpad_dir: scratch, session_id: "drivers" },
      {
        AGENT_HOOKS: "1",
        GIT_EXTERNAL_DIFF: "true",
        GIT_DIFF_OPTS: "-u5",
        GIT_CONFIG_COUNT: "3",
        GIT_CONFIG_KEY_0: "diff.noprefix",
        GIT_CONFIG_VALUE_0: "true",
        GIT_CONFIG_KEY_1: "diff.renames",
        GIT_CONFIG_VALUE_1: "false",
        GIT_CONFIG_KEY_2: "diff.interHunkContext",
        GIT_CONFIG_VALUE_2: "3",
      },
    );

    expect(reason).toContain("a.ts:1  // seen past the drivers");
    expect(reason).toContain("a.ts:5  // second");
    expect(reason).not.toContain("old untouched");
  });

  test("a diff whose sections cannot be matched to its files fails loud", async () => {
    await commitFile("a.ts", "export {};\n");
    await commitFile("b.ts", "export {};\n");
    put(join(repo, "a.ts"), "export {};\n// first\n");
    put(join(repo, "b.ts"), "export {};\n// second\n");

    const shim = join(scratch, "bin");
    mkdirSync(shim);
    writeFileSync(
      join(shim, "git"),
      `#!/bin/sh\nif [ "$1" = diff ]; then "${Bun.which("git")}" "$@" | perl -pe 's/^diff --git /x/'; exit 0; fi\nexec "${Bun.which("git")}" "$@"\n`,
      { mode: 0o755 },
    );

    const stderr = spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const reason = check(
        { cwd: repo, scratchpad_dir: scratch, session_id: "shim" },
        { AGENT_HOOKS: "1", PATH: `${shim}:${process.env.PATH}` },
      );

      expect(reason).toBeUndefined();
      expect(String(stderr.mock.calls[0]?.[0])).toContain(
        "git diff: 1 patch sections for 2 changed files",
      );
    } finally {
      stderr.mockRestore();
    }
  });

  test("test_rewrite_after_a_block_is_checked", () => {
    expect(stop("x \u2014 y")).toContain("dash");
    expect(stop(draft("It lands in plan 090."), { stop_hook_active: true })).toContain("plan id");
  });

  test("test_rewrites_stop_blocking_at_the_cap", () => {
    stop("x \u2014 y");
    stop("x \u2014 y", { stop_hook_active: true });
    expect(stop("x \u2014 y", { stop_hook_active: true })).toBeUndefined();
  });

  test("test_clean_rewrite_resets_the_cap", () => {
    stop("x \u2014 y");
    stop("x \u2014 y", { stop_hook_active: true });
    expect(stop("Done.", { stop_hook_active: false })).toBeUndefined();
    expect(stop("x \u2014 y")).toContain("dash");
  });

  test("state replacement is atomic", () => {
    const path = join(scratch, "reply-guard-s1.json");
    const original = '{"seen": [], "rewrites": 0}';
    put(path, original);
    const rename = spyOn(fs, "renameSync").mockImplementation((from, to) => {
      expect(to).toBe(path);
      expect(fs.statSync(String(from)).isFile()).toBe(true);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(JSON.parse(readFileSync(String(from), "utf8")).rewrites).toBe(1);
      throw new Error("rename failed");
    });

    try {
      expect(stop("x \u2014 y")).toContain("dash");
      expect(stop("x \u2014 y", { stop_hook_active: true })).toBeUndefined();
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(fs.readdirSync(scratch).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    } finally {
      rename.mockRestore();
    }

    expect(stop("x \u2014 y")).toContain("dash");
    expect(JSON.parse(readFileSync(path, "utf8")).rewrites).toBe(1);
  });

  test("Python line anchors and whitespace stay distinct", () => {
    for (const separator of ["\r", "\u0085", "\u2028", "\u2029"])
      expect(stop("x" + separator + "Great question")).toBeUndefined();

    expect(stop("x\nGreat question")).toContain("chatbot filler");
    expect(stop(draft("See plan\u001c090."))).toContain("plan id");
    expect(stop(draft("See \u03b1plan 090."))).toBeUndefined();
  });

  test("legacy seen lists suppress already shown tree hits", async () => {
    const path = join(await git("rev-parse", "--show-toplevel"), "old.py");
    put(path, "# old comment\n");
    put(join(scratch, "reply-guard-s1.json"), JSON.stringify([path + "\t# old comment"]));

    expect(stop("Done.")).toBeUndefined();
  });

  test("falsy payload values reset the rewrite cap", () => {
    for (const active of [false, null, 0, "", [], {}]) {
      put(join(scratch, "reply-guard-s1.json"), '{"seen": [], "rewrites": 2}');
      expect(stop("x \u2014 y", { stop_hook_active: active })).toContain("dash");
    }
  });

  test("git environment overrides do not redirect the tree sweep", () => {
    put(join(repo, "a.ts"), "// local tree\n");
    expect(
      check(
        { cwd: repo, scratchpad_dir: scratch, session_id: "git-env" },
        {
          AGENT_HOOKS: "1",
          GIT_DIR: join(scratch, "absent"),
          GIT_WORK_TREE: scratch,
        },
      ),
    ).toContain("local tree");
  });

  test("disabled hooks and non-object payloads stay silent", () => {
    expect(check({ last_assistant_message: "x \u2014 y" }, { AGENT_HOOKS: "0" })).toBeUndefined();
    for (const payload of [null, [], 3, "x \u2014 y"]) expect(hook(payload)).toBeUndefined();
  });

  test("unsafe session ids share the anonymous state inside the scratch directory", () => {
    const parent = temporary();
    const inner = join(parent, "inner");
    mkdirSync(inner);

    for (const session_id of ["../escaped", { id: 1 }, ".hidden"])
      expect(stop("x \u2014 y", { scratchpad_dir: inner, session_id })).toContain("dash");

    expect(readdirSync(parent)).toEqual(["inner"]);
    expect(readdirSync(inner)).toEqual(["reply-guard-anon.json"]);
  });

  test("wrapper emits exact block bytes", async () => {
    const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
    const env = { ...suiteEnvironment(), AGENT_HOOKS: "1" };
    const { child, result } = startCommand([bin, "hook", "stop"], { cwd: repo, env, input: true });
    child.stdin!.end(
      JSON.stringify({
        scratchpad_dir: scratch,
        session_id: "cli",
        last_assistant_message: "x \u2014 y",
      }),
    );

    const output = await result;
    expect(output.code).toBe(0);
    expect(output.stderr).toBe("");
    expect(output.stdout).toBe(
      '{"decision": "block", "reason": "Your reply has a dash used as punctuation. Use a comma, a colon, parentheses or a full stop. Rewrite the reply."}\n',
    );
  });
});
