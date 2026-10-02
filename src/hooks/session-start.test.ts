import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readIndex } from "../plans/index-tsv.ts";
import { detectProject } from "../project.ts";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";

const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");
const header = "id\tslug\tstatus\tpri\teffort\tblocked_by\tctx\tbranch\tupdated\tnote\n";
let temporary: string;
let home: string;
let plans: string;
let repo: string;
let root: string;
let conf: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-session-"));

  home = join(temporary, "home");
  plans = join(temporary, "plans");
  repo = join(temporary, "repo");
  root = join(temporary, "fixture/skills");
  conf = join(temporary, "skills.conf");

  for (const directory of [home, plans, repo]) await mkdir(directory);

  await fixtureGit(repo, ["init", "-q", "-b", "main"]);
  await fixtureGit(repo, [
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "init",
  ]);

  await writeFixture(
    root,
    "greptile/SKILL.md",
    "---\nname: greptile\ndescription: Greptile review loop.\noptional: true\nrequires: prs\n---\n",
  );
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function brief(content?: string, cwd = repo, overrides: NodeJS.ProcessEnv = {}) {
  if (content !== undefined) await writeFile(conf, content);

  const env: NodeJS.ProcessEnv = {
    ...suiteEnvironment(),
    HOME: home,
    PLANS_DIR: plans,
    SKILLS_CONF: conf,
    AGENT_HOOKS: "1",
    ...overrides,
  };

  delete env.AGENTS_DIR;
  const result = await runCommand([bin, "--root", root, "hook", "session-start"], { cwd, env });
  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");

  return result.stdout;
}

async function context(
  content?: string,
  cwd = repo,
  overrides: NodeJS.ProcessEnv = {},
): Promise<string> {
  const output = await brief(content, cwd, overrides);
  const payload = JSON.parse(output);
  expect(payload.hookSpecificOutput.hookEventName).toBe("SessionStart");
  const text: string = payload.hookSpecificOutput.additionalContext;
  expect(text.split("\n").filter((line) => line.startsWith("Delivery:"))).toHaveLength(1);

  return text;
}

async function index(rows: string, project = "repo") {
  await writeFixture(plans, `${project}/index.tsv`, header + rows);
}

describe("SessionBrief case ledger", () => {
  test("test_no_config_is_hands_off", async () => {
    expect(await context()).toBe("Delivery: hands-off\nBranch: main  (0 changed, 0 untracked)");
  });

  test("test_prs_lists_active_extension", async () => {
    expect((await context("DELIVERY=prs\nWITH=greptile\n")).split("\n")[0]).toBe(
      "Delivery: prs, with greptile",
    );
  });

  test("test_hands_off_names_dropped_extension", async () => {
    expect((await context("DELIVERY=hands-off\nWITH=greptile\n")).split("\n")[0]).toBe(
      "Delivery: hands-off (greptile dropped: requires DELIVERY=prs)",
    );
  });

  test("test_notes_join_in_order", async () => {
    expect((await context("DELIVERY=hands-off\nWITH=greptile missing\n")).split("\n")[0]).toBe(
      "Delivery: hands-off (greptile dropped: requires DELIVERY=prs; missing dropped: not installed)",
    );
  });

  test("test_outside_git_is_only_the_delivery_line", async () => {
    const outside = join(temporary, "outside");
    await mkdir(outside);
    expect(await context(undefined, outside)).toBe("Delivery: hands-off");
  });

  test("test_review_plan_counts_as_open", async () => {
    await index(
      "001\ttodo\tTODO\tP1\tS\t-\t-\t-\t2026-09-26\t-\n002\treview\tREVIEW\tP1\tS\t-\t-\tfeat/review\t2026-09-26\t-\n003\tdone\tDONE\tP1\tS\t-\t-\t-\t2026-09-26\t-\n004\tdropped\tDROPPED\tP1\tS\t-\t-\t-\t2026-09-26\t-\n",
    );

    expect(await context()).toContain(`${plans}/repo: 2 open. Run /plans for the frontier.`);
  });

  test("test_linked_worktree_uses_main_checkout_project", async () => {
    const worktree = join(temporary, "wt/t3code-0000");
    await mkdir(join(temporary, "wt"));
    await fixtureGit(repo, ["worktree", "add", "-q", "-b", "linked", worktree]);
    await index("001\tready\tTODO\tP1\tS\t-\t-\t-\t2026-09-26\t-\n", "Repo");

    expect(await context(undefined, worktree)).toContain(
      `${plans}/Repo: 1 open. Run /plans for the frontier.`,
    );
  });

  test("AGENT_HOOKS=0 prints nothing", async () => {
    expect(await brief(undefined, repo, { AGENT_HOOKS: "0" })).toBe("");
  });

  test("stdout is one JSON line and stdin is ignored", async () => {
    const output = await brief();

    expect(output.split("\n")).toHaveLength(2);
    expect(output.endsWith("\n")).toBe(true);
    expect(Object.keys(JSON.parse(output))).toEqual(["hookSpecificOutput"]);
  });

  test("session cwd env and Bun preload cannot silence or pollute the JSON line", async () => {
    await writeFixture(repo, ".env", "AGENT_HOOKS=0\n");
    await writeFixture(repo, "bunfig.toml", 'preload = ["./preload.ts"]\n');
    await writeFixture(repo, "preload.ts", 'console.log("session preload ran");\n');

    const output = await brief(undefined, repo, { AGENT_HOOKS: undefined });

    expect(output.split("\n")).toHaveLength(2);
    expect(output).toBe(
      `${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "SessionStart",
          additionalContext: "Delivery: hands-off\nBranch: main  (3 changed, 3 untracked)",
        },
      })}\n`,
    );
  });

  test("matching Plan rows use the first branch match and keep an empty note's trailing space", async () => {
    await index(
      "001\tfirst\tDOING\tP1\tS\t-\tctx\tmain\t2026-09-26\t\n001\tduplicate\tREVIEW\tP2\tM\t-\t-\tother\t2026-09-26\tsecond\n002\tlater\tTODO\tP1\tS\t-\t-\tmain\t2026-09-26\tlater\n",
    );

    expect(await context()).toBe(
      `Delivery: hands-off\nBranch: main  (0 changed, 0 untracked)\nPlan 001 first [DOING] \nPlan 001 duplicate [REVIEW] second\n${plans}/repo: 3 open. Run /plans for the frontier.`,
    );

    expect(readIndex(join(plans, "repo/index.tsv"))[0]).toEqual({
      id: "001",
      slug: "first",
      status: "DOING",
      pri: "P1",
      effort: "S",
      blocked_by: "-",
      ctx: "ctx",
      branch: "main",
      updated: "2026-09-26",
      note: "",
    });
  });

  test("Plan id scan includes the header", async () => {
    await index("id\todd\tDOING\tP1\tS\t-\t-\tmain\t2026-09-26\todd id\n");
    expect(await context()).toContain("Plan id slug [status] note\nPlan id odd [DOING] odd id");
  });

  test("Recent trail prints the last three matching raw log rows", async () => {
    await index("001\tfirst\tDOING\tP1\tS\t-\t-\tmain\t2026-09-26\tnote\n");
    await writeFixture(
      plans,
      "log.tsv",
      "timestamp\tproject\tid\taction\tdetail\n1\trepo\t001\tstart\tfirst\n2\trepo\t001\tstart\tsecond\n3\tOther\t001\tstart\tmain\n4\trepo\t099\tstart\tcontains main branch\n5\trepo\t001\tstart\tlast\n6\trepo\t099\tstart\tno match\n",
    );

    expect(await context()).toEndWith(
      "Recent trail:\n2\trepo\t001\tstart\tsecond\n4\trepo\t099\tstart\tcontains main branch\n5\trepo\t001\tstart\tlast",
    );
  });

  test("Recent trail without a Plan uses only branch substrings", async () => {
    await index("001\tfirst\tTODO\tP1\tS\t-\t-\tother\t2026-09-26\tnote\n");
    await writeFixture(
      plans,
      "log.tsv",
      "timestamp\tproject\tid\taction\tdetail\n1\trepo\t001\tstart\tnot selected\n2\trepo\t\tstart\tnot selected\n3\trepo\t099\tstart\tcontains main branch\n",
    );

    expect(await context()).toEndWith("Recent trail:\n3\trepo\t099\tstart\tcontains main branch");
  });

  test("detached HEAD stops after delivery", async () => {
    await fixtureGit(repo, ["checkout", "-q", "--detach"]);
    expect(await context()).toBe("Delivery: hands-off");
  });

  test("status counts renames once and includes untracked entries but not ignored files", async () => {
    await writeFixture(repo, "old", "original");
    await writeFixture(repo, ".gitignore", "ignored\n");
    await fixtureGit(repo, ["add", "."]);
    await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "files"]);

    await fixtureGit(repo, ["mv", "old", "renamed"]);
    await writeFixture(repo, "untracked", "new");
    await writeFixture(repo, "ignored", "ignored");

    expect(await context()).toContain("Branch: main  (2 changed, 1 untracked)");
  });

  test("missing plans directory, missing project and missing index stop after branch", async () => {
    expect(await context(undefined, repo, { PLANS_DIR: join(temporary, "missing") })).toBe(
      "Delivery: hands-off\nBranch: main  (0 changed, 0 untracked)",
    );

    expect(await context()).toBe("Delivery: hands-off\nBranch: main  (0 changed, 0 untracked)");
    await mkdir(join(plans, "repo"));

    expect(await context()).toBe("Delivery: hands-off\nBranch: main  (0 changed, 0 untracked)");
  });

  test("empty PLANS_DIR falls back to HOME/Plans and relative paths print as given", async () => {
    await writeFixture(home, "Plans/repo/index.tsv", header);
    await writeFixture(repo, "relative/repo/index.tsv", header);

    expect(await context(undefined, repo, { PLANS_DIR: "" })).toContain(
      `${home}/Plans/repo: 0 open.`,
    );

    expect(await context(undefined, repo, { PLANS_DIR: "relative" })).toContain(
      "relative/repo: 0 open.",
    );
  });

  test("project detection matches sorted visible directory names with ASCII case folding", async () => {
    await mkdir(join(plans, "Repo"));
    await mkdir(join(plans, "other"));
    await mkdir(join(plans, ".Repo"));

    expect(await detectProject(repo, plans)).toBe("Repo");
  });

  test("project detection accepts a symlink to a directory outside git", async () => {
    const outside = join(temporary, "outside");
    await mkdir(outside);
    await symlink(home, join(plans, "Outside"));

    expect(await detectProject(outside, plans)).toBe("Outside");
  });

  test("project detection prefers the worktree basename to the main checkout", async () => {
    const worktree = join(temporary, "linked");
    await fixtureGit(repo, ["worktree", "add", "-q", "-b", "linked", worktree]);
    await index("", "Repo");
    await index("", "Linked");

    expect(await detectProject(worktree, plans)).toBe("Linked");
  });

  test("project detection uses a separate git directory name without its .git suffix", async () => {
    const checkout = join(temporary, "separate");
    await mkdir(checkout);
    await fixtureGit(checkout, [
      "init",
      "-q",
      "--separate-git-dir",
      join(temporary, "Project.git"),
    ]);

    await index("", "Project");

    expect(await detectProject(checkout, plans)).toBe("Project");
  });

  test("project detection skips ordinary files and dangling directory links", async () => {
    await writeFile(join(plans, "Repo"), "not a directory");
    expect(await detectProject(repo, plans)).toBeUndefined();

    const outside = join(temporary, "outside");
    await mkdir(outside);
    await symlink(join(temporary, "missing"), join(plans, "Outside"));

    expect(await detectProject(outside, plans)).toBeUndefined();
    expect(await detectProject(repo, join(temporary, "missing"))).toBeUndefined();
  });

  test.skipIf(process.getuid?.() === 0)(
    "a thrown index read stops adding lines but emits the branch",
    async () => {
      await index("001\tfirst\tDOING\tP1\tS\t-\t-\tmain\t2026-09-26\tnote\n");
      await chmod(join(plans, "repo/index.tsv"), 0);
      expect(await context()).toBe("Delivery: hands-off\nBranch: main  (0 changed, 0 untracked)");
    },
  );

  test("git reads have a two second deadline and timeout stops after delivery", async () => {
    const fake = join(temporary, "bin/git");
    await writeFixture(temporary, "bin/git", "#!/bin/sh\nexec sleep 3\n");
    await chmod(fake, 0o755);

    expect(
      await context(undefined, repo, { PATH: `${join(temporary, "bin")}:${process.env.PATH}` }),
    ).toBe("Delivery: hands-off");
  });
});
