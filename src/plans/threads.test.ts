import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { COLUMNS } from "./index-tsv.ts";
import { resumeVerb } from "./resume.ts";
import { threadsLogVerb } from "./threads.ts";
import {
  appendLog,
  bookkeepingEvents,
  historyKey,
  lastEvent,
  readHistories,
  trailIn,
} from "./trail.ts";

const usage = "skills threads log <branch> <start|handback|nudge> [detail]";

let temporary: string;
let plans: string;
let repo: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-threads-"));
  plans = join(temporary, "plans");
  repo = join(temporary, "fixture");

  await fixtureGit(temporary, ["init", "-q", "-b", "main", repo]);
  await commitFixture(repo);
  await fixtureGit(repo, ["config", "branch.feat/ad-hoc.skills-owned", "true"]);
  await fixtureGit(repo, ["config", "branch.feat/planned.skills-owned", "true"]);
  await writeFixture(
    plans,
    "other/index.tsv",
    [COLUMNS.join("\t"), "188\tplanned\tDONE\tP1\tS\t-\t-\tfeat/planned\t2026-10-25\t-", ""].join(
      "\n",
    ),
  );
});

afterEach(async () => {
  await removeTemporary(temporary);
});

function env(): NodeJS.ProcessEnv {
  return {
    ...suiteEnvironment(),
    PLANS_DIR: plans,
    SKILLS_CONF: join(temporary, "skills.conf"),
  };
}

async function log(args: string[], cwd = repo) {
  const err: string[] = [];
  const io = {
    cwd,
    env: env(),
    capture: true,
    out: () => {},
    err: (text: string) => err.push(text),
  };

  const code = await threadsLogVerb(args, usage, io);
  return { code, err: err.join("") };
}

function trail(): string[][] {
  return readFileSync(trailIn(plans), "utf8")
    .trim()
    .split("\n")
    .slice(1)
    .map((line) => line.split("\t").slice(1));
}

describe("skills threads log", () => {
  test("names the plans project when the checkout maps to one", async () => {
    await writeFixture(plans, "Fixture/index.tsv", `${COLUMNS.join("\t")}\n`);

    expect(await log(["feat/ad-hoc", "start"])).toEqual({ code: 0, err: "" });
    expect(await log(["feat/ad-hoc", "handback", "handoff on #12"])).toEqual({ code: 0, err: "" });
    expect(trail()).toEqual([
      ["Fixture", "-", "start", "feat/ad-hoc"],
      ["Fixture", "-", "handback", "feat/ad-hoc handoff on #12"],
    ]);
  });

  test("names the main checkout's directory when no plans project matches", async () => {
    const linked = join(temporary, "elsewhere");
    await fixtureGit(repo, ["worktree", "add", "-q", "-b", "feat/ad-hoc", linked]);

    expect(await log(["feat/ad-hoc", "nudge", "rate-limit run:1"], linked)).toEqual({
      code: 0,
      err: "",
    });

    expect(trail()).toEqual([["fixture", "-", "nudge", "feat/ad-hoc rate-limit run:1"]]);
  });

  test("refuses another event, an indexed branch and an unmarked one, writing nothing", async () => {
    expect(await log(["feat/ad-hoc", "done"])).toEqual({
      code: 1,
      err: "threads log: done is not one of start, handback, nudge\n",
    });

    expect(await log(["feat/planned", "start"])).toEqual({
      code: 1,
      err: `threads log: feat/planned is in ${plans}/other/index.tsv, so its row keeps the trail\n`,
    });

    expect(await log(["feat/teammate", "start"])).toEqual({
      code: 1,
      err: "threads log: feat/teammate carries no publish mark\n",
    });

    expect((await log(["feat/ad-hoc"])).code).toBe(2);
    expect(existsSync(trailIn(plans))).toBe(false);
  });
});

describe("row readers skip ad hoc lines", () => {
  async function interleave(): Promise<void> {
    await appendLog("fixture", "188", "start", "feat/stalled", env());
    await appendLog("fixture", "-", "start", "feat/ad-hoc", env());
    await appendLog("fixture", "188", "thread", "mcp:abc", env());
    await appendLog("fixture", "-", "handback", "feat/stalled", env());
    await appendLog("fixture", "-", "nudge", "feat/ad-hoc unknown run:1", env());
  }

  test("sweep and release histories hold no entry for id -", async () => {
    await interleave();
    const histories = readHistories(env())!;
    expect(histories.has(historyKey("fixture", "-"))).toBe(false);
    expect(histories.get(historyKey("fixture", "188"))).toMatchObject({
      live: true,
      thread: "mcp:abc",
    });
  });

  test("the start rerun check still finds the row's start", async () => {
    await interleave();
    expect(lastEvent("fixture", "188", env(), bookkeepingEvents)).toEqual({
      event: "start",
      detail: "feat/stalled",
    });
  });

  test("resume reads the row, not an ad hoc handback naming its branch", async () => {
    await writeFixture(temporary, "skills.conf", "DELIVERY=prs\nPLANS_RESUME_EVERY=20m\n");
    await writeFixture(
      plans,
      "fixture/index.tsv",
      [
        COLUMNS.join("\t"),
        "188\tstalled\tDOING\tP1\tM\t-\t-\tfeat/stalled\t2026-10-25\t-",
        "",
      ].join("\n"),
    );

    await interleave();
    const out: string[] = [];
    const io = {
      cwd: repo,
      env: env(),
      capture: true,
      out: (text: string) => void out.push(text),
      err: () => {},
    };

    expect(await resumeVerb(["fixture"], "", io)).toBe(0);
    expect(out.join("")).toBe("every 20m\nread 188 mcp:abc -\n");
  });
});
