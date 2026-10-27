import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { commitFixture, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { COLUMNS } from "./index-tsv.ts";
import { resumeVerb } from "./resume.ts";
import { threadsLogVerb, threadsResumeVerb } from "./threads.ts";
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

describe("skills threads resume", () => {
  const run = "run:thread:mcp%3Aabc:ordinal:4";
  const prList = (branch: string) =>
    `pr list --head ${branch} --state open --json url,isCrossRepository`.replace(
      /[^A-Za-z0-9._-]/gu,
      "_",
    );

  const url = "https://github.com/o/fixture/pull/12";
  const limited = [
    {
      runId: run,
      type: "error",
      status: "failed",
      title: "Usage limit reached",
      text: "Claude API rate limit reached. Try again later.",
    },
  ];

  function facts(branch: string, overrides: Record<string, unknown> = {}) {
    return {
      branch,
      thread: "mcp:abc",
      status: "completed",
      pendingRequestCount: 0,
      run: { runId: run, status: "failed", completedAt: "2026-10-27T10:00:00.000Z" },
      items: limited,
      asks: false,
      waits: false,
      ...overrides,
    };
  }

  function resumeEnv(): NodeJS.ProcessEnv {
    return {
      ...env(),
      PATH: `${resolve(import.meta.dir, "../../scripts/stubs")}:${process.env.PATH ?? ""}`,
      GH_STUB_DIR: join(temporary, "gh"),
    };
  }

  async function pass(args: string[], stdin = "") {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd: repo,
      env: resumeEnv(),
      capture: true,
      out: (text: string) => void out.push(text),
      err: (text: string) => void err.push(text),
    };

    const code = await threadsResumeVerb(
      args,
      "skills threads resume [--facts]",
      io,
      async () => stdin,
    );

    return { code, out: out.join(""), err: err.join("") };
  }

  beforeEach(async () => {
    await writeFixture(temporary, "skills.conf", "DELIVERY=prs\nTHREADS_RESUME_EVERY=20m\n");
    await fixtureGit(repo, ["config", "branch.feat/merged.skills-owned", "true"]);
    await fixtureGit(repo, ["config", "branch.feat/back.skills-owned", "true"]);
    const prs: [string, unknown[]][] = [
      ["feat/ad-hoc", [{ url, isCrossRepository: false }]],
      ["feat/merged", [{ url: "https://github.com/fork/fixture/pull/9", isCrossRepository: true }]],
      ["feat/back", [{ url: "https://github.com/o/fixture/pull/13", isCrossRepository: false }]],
    ];

    for (const [branch, list] of prs)
      await writeFixture(join(temporary, "gh"), prList(branch), JSON.stringify(list));

    for (const [branch, event] of [
      ["feat/ad-hoc", "start"],
      ["feat/merged", "start"],
      ["feat/back", "start"],
      ["feat/back", "handback"],
      ["feat/deleted", "start"],
    ])
      await appendLog("fixture", "-", event!, branch!, env());

    await appendLog("elsewhere", "-", "start", "feat/other-repo", env());
    await appendLog("fixture", "188", "start", "feat/ad-hoc", env());
  });

  afterEach(() => {
    setSystemTime();
  });

  test("prints off and nothing else while the key is unset", async () => {
    await writeFixture(temporary, "skills.conf", "DELIVERY=prs\n");
    expect(await pass([])).toEqual({ code: 0, out: "off\n", err: "" });
  });

  test("lists each started, marked branch of this repo with its open PR", async () => {
    expect(await pass([])).toEqual({
      code: 0,
      out: `every 20m\nread feat/ad-hoc ${url}\nskip feat/merged no open PR\n`,
      err: "",
    });
  });

  test("two passes over one stall send one nudge, logged through threads log", async () => {
    setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const stdin = JSON.stringify([facts("feat/ad-hoc")]);
    const first = await pass(["--facts"], stdin);
    expect(first.out).toBe(
      `every 20m\nnudge feat/ad-hoc rate-limit mcp:abc ${run} Your last turn stopped on a usage limit, which may have cleared by now. Carry on with the PR on feat/ad-hoc from where you stopped.\nskip feat/merged no open PR\n`,
    );

    expect(await log(["feat/ad-hoc", "nudge", `rate-limit ${run}`])).toEqual({ code: 0, err: "" });

    setSystemTime(new Date("2026-10-27T14:00:00Z"));
    const second = await pass(["--facts"], stdin);
    expect(second.out).toBe(
      "every 20m\nskip feat/ad-hoc nudged this stall\nskip feat/merged no open PR\n",
    );
  });

  test("the shared table skips a closed PR first, then a handback", async () => {
    const stdin = JSON.stringify([
      facts("feat/merged", { status: "running" }),
      facts("feat/back"),
      facts("feat/ad-hoc", { asks: "no" }),
    ]);

    const result = await pass(["--facts"], stdin);
    expect(result.out).toBe(
      "every 20m\nskip feat/ad-hoc bad facts\nskip feat/merged no open PR\nskip feat/back handed back\n",
    );

    expect(result.err).toBe(
      "threads resume: facts for feat/ad-hoc: asks and waits must be booleans\n",
    );
  });

  test("a long branch keeps its whole name and run on the trail, so its stall dedupes", async () => {
    setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const long = `feat/${"long-linear-issue-title-".repeat(6)}end`;
    await fixtureGit(repo, ["config", `branch.${long}.skills-owned`, "true"]);
    await writeFixture(
      join(temporary, "gh"),
      prList(long),
      JSON.stringify([{ url, isCrossRepository: false }]),
    );

    expect(await log([long, "start"])).toEqual({ code: 0, err: "" });

    const stdin = JSON.stringify([facts(long)]);
    expect((await pass(["--facts"], stdin)).out).toContain(
      `nudge ${long} rate-limit mcp:abc ${run} `,
    );

    expect(await log([long, "nudge", `rate-limit ${run}`])).toEqual({ code: 0, err: "" });
    setSystemTime(new Date("2026-10-27T14:00:00Z"));
    expect((await pass(["--facts"], stdin)).out).toContain(`skip ${long} nudged this stall\n`);
  });

  test("a PR read that fails is named on its branch and fails the pass", async () => {
    await writeFixture(join(temporary, "gh"), `${prList("feat/ad-hoc")}.exit`, "1\n");
    const result = await pass([]);
    expect(result.code).toBe(1);
    expect(result.out).toBe(
      "every 20m\nskip feat/ad-hoc gh pr list failed for feat/ad-hoc\nskip feat/merged no open PR\n",
    );
  });

  test.each<[string, Record<string, unknown>, string]>([
    ["a running thread", { status: "running", asks: true }, "skip feat/ad-hoc running"],
    ["an open question", { asks: true }, "skip feat/ad-hoc open question"],
    [
      "a stopped run",
      { run: { runId: run, status: "interrupted", completedAt: "2026-10-27T10:00:00.000Z" } },
      "skip feat/ad-hoc stopped or cancelled",
    ],
    [
      "a rate limit before its reset",
      { resetAt: "2026-10-27T13:00:00.000Z" },
      "skip feat/ad-hoc rate limit resets 2026-10-27T13:00:00.000Z",
    ],
    [
      "a restart that cancelled a job",
      {
        run: { runId: run, status: "completed", completedAt: "2026-10-27T11:55:00.000Z" },
        items: [
          {
            runId: run,
            type: "notification",
            status: "completed",
            title: null,
            text: "T3 Code restarted and resumed this turn. This background work was cancelled.",
          },
        ],
      },
      "nudge feat/ad-hoc restart",
    ],
    [
      "20 idle minutes",
      {
        run: { runId: run, status: "completed", completedAt: "2026-10-27T11:40:00.000Z" },
        items: [
          { runId: run, type: "assistant_message", status: "completed", title: null, text: "ok" },
        ],
      },
      "nudge feat/ad-hoc unknown",
    ],
    [
      "10 idle minutes",
      {
        run: { runId: run, status: "completed", completedAt: "2026-10-27T11:50:00.000Z" },
        items: [
          { runId: run, type: "assistant_message", status: "completed", title: null, text: "ok" },
        ],
      },
      "skip feat/ad-hoc idle 10 min",
    ],
  ])("the shared table: %s", async (_, overrides, expected) => {
    setSystemTime(new Date("2026-10-27T12:00:00Z"));
    const result = await pass(["--facts"], JSON.stringify([facts("feat/ad-hoc", overrides)]));
    expect(result.out.split("\n")[1]!.startsWith(expected)).toBe(true);
  });

  test("a nudge an hour ago holds a new stall on the same branch", async () => {
    setSystemTime(new Date("2026-10-27T12:00:00Z"));
    expect(await log(["feat/ad-hoc", "nudge", "unknown run:older"])).toEqual({ code: 0, err: "" });
    setSystemTime(new Date("2026-10-27T12:30:00Z"));
    const result = await pass(["--facts"], JSON.stringify([facts("feat/ad-hoc")]));
    expect(result.out).toContain("skip feat/ad-hoc nudged 2026-10-27T12:00:00.000Z\n");
  });

  test("a thread that babysits a stack gets one nudge however many layers stalled", async () => {
    setSystemTime(new Date("2026-10-27T12:00:00Z"));
    await fixtureGit(repo, ["config", "branch.feat/top.skills-owned", "true"]);
    await writeFixture(
      join(temporary, "gh"),
      prList("feat/top"),
      JSON.stringify([{ url: "https://github.com/o/fixture/pull/14", isCrossRepository: false }]),
    );

    expect(await log(["feat/top", "start"])).toEqual({ code: 0, err: "" });
    const stdin = JSON.stringify([facts("feat/ad-hoc"), facts("feat/top")]);
    const lines = (await pass(["--facts"], stdin)).out.split("\n");
    expect(lines[1]).toStartWith("nudge feat/ad-hoc rate-limit mcp:abc ");
    expect(lines).toContain("skip feat/top nudged through feat/ad-hoc");
  });

  test("an unreadable plans index is named on its branch and fails the pass", async () => {
    await writeFixture(plans, "broken/index.tsv", "");
    writeFileSync(join(plans, "broken/index.tsv"), Buffer.from([0xff, 0xfe, 0x0a]));
    const result = await pass([]);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`skip feat/ad-hoc cannot read ${plans}/broken/index.tsv\n`);
  });

  test("refuses anything but --facts", async () => {
    expect((await pass(["fixture"])).code).toBe(2);
  });
});
