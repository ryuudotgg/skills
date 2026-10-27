import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DeliveryConfig } from "../delivery.ts";
import { fixtureGit, writeFixture } from "../test/fixtures.ts";
import { removeTemporary, suiteEnvironment } from "../test/process.ts";
import { COLUMNS } from "./index-tsv.ts";
import {
  binding,
  decide,
  ending,
  limit,
  resumeEvery,
  resumeVerb,
  running,
  type Item,
  type State,
  type ThreadFacts,
} from "./resume.ts";
import { appendLog, lastEvent, type TrailEntry } from "./trail.ts";

const usage = "skills plans resume <Project> [--facts]";
const now = new Date("2026-10-25T12:00:00Z");
const run = "run:thread:mcp%3Aabc:ordinal:4";

const claudeLimit: Item[] = [
  {
    runId: run,
    type: "assistant_message",
    status: "completed",
    title: null,
    text: "API Error: Request rejected (429) · All credentials for model claude-opus-5-5 are cooling down via provider claude (last error: rate_limit_error: This request would exceed your account's rate limit. Please try again later.)",
  },
  {
    runId: run,
    type: "error",
    status: "failed",
    title: "Usage limit reached",
    text: "Claude API rate limit reached. Try again later.",
  },
];

const restartNotice: Item = {
  runId: run,
  type: "notification",
  status: "completed",
  title: null,
  text: "T3 Code restarted and resumed this turn\nNote: the T3 server restarted, and this background work was cancelled before it finished. It will not report back:\n- shell: Run full API e2e suite to a log (id b5ooruyuh)\n\nContinue where you left off.",
};

function item(type: string, text: string, overrides: Partial<Item> = {}): Item {
  return { runId: run, type, status: "completed", title: null, text, ...overrides };
}

type PlanFacts = ThreadFacts & { id: string };

function thread(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return {
    id: "188",
    thread: "mcp:abc",
    status: "completed",
    pendingRequestCount: 0,
    run: { runId: run, status: "completed", completedAt: "2026-10-25T11:00:00.000Z" },
    items: [item("assistant_message", "Done for now.")],
    asks: false,
    waits: false,
    ...overrides,
  };
}

function failed(overrides: Partial<PlanFacts> = {}): PlanFacts {
  return thread({ run: { ...thread().run!, status: "failed" }, ...overrides });
}

function state(overrides: Partial<State> = {}): State {
  return {
    done: undefined,
    lastEvent: "start",
    running: false,
    question: false,
    idleMinutes: 30,
    ending: { kind: "other" },
    now,
    ...overrides,
  };
}

describe("the decision table, first match wins", () => {
  const later = new Date("2026-10-25T13:00:00Z");
  const earlier = new Date("2026-10-25T11:30:00Z");
  test.each<[string, Partial<State>, string]>([
    ["an owner that is done", { done: "not DOING", running: true }, "skip not DOING"],
    ["a running thread", { running: true, question: true }, "skip running"],
    ["an open question", { question: true, lastEvent: "handback" }, "skip open question"],
    ["a handback", { lastEvent: "handback", ending: { kind: "rate-limit" } }, "skip handed back"],
    [
      "a stopped run",
      { ending: { kind: "stopped" }, idleMinutes: 90 },
      "skip stopped or cancelled",
    ],
    [
      "a rate limit before its reset",
      { ending: { kind: "rate-limit", resetAt: later }, idleMinutes: 90 },
      "skip rate limit resets 2026-10-25T13:00:00.000Z",
    ],
    [
      "a rate limit after its reset",
      { ending: { kind: "rate-limit", resetAt: earlier } },
      "nudge rate-limit",
    ],
    [
      "a rate limit naming no reset",
      { ending: { kind: "rate-limit" }, idleMinutes: 1 },
      "nudge rate-limit",
    ],
    [
      "a restart that cancelled a job",
      { ending: { kind: "restart" }, idleMinutes: 1 },
      "nudge restart",
    ],
    ["20 idle minutes", { idleMinutes: 20 }, "nudge unknown"],
    ["19 idle minutes", { idleMinutes: 19.9 }, "skip idle 19 min"],
  ])("%s", (_, overrides, expected) => {
    const decision = decide(state(overrides));
    expect(decision.kind === "skip" ? `skip ${decision.reason}` : `nudge ${decision.cause}`).toBe(
      expected,
    );
  });
});

describe("a run's tail", () => {
  test("a Claude 429 ends on a rate limit", () => {
    expect(ending(failed({ items: claudeLimit }))).toEqual({ kind: "rate-limit" });
  });

  test.each(["Usage limit reached", "Provider error"])(
    "an OpenCode quota error titled %s ends on a rate limit",
    (title) => {
      const items = [item("error", "Go usage limit exceeded", { status: "failed", title })];
      expect(ending(failed({ items }))).toEqual({ kind: "rate-limit" });
    },
  );

  test("a closing message that mentions a 429 is no rate limit", () => {
    const items = [item("assistant_message", "Fixed the 429 retry; waiting on PR #429.")];
    expect(ending(thread({ items }))).toEqual({ kind: "other" });
  });

  test("a reset time the thread names is kept", () => {
    const facts = failed({ items: claudeLimit, resetAt: "2026-10-25T15:00:00Z" });
    expect(ending(facts)).toEqual({
      kind: "rate-limit",
      resetAt: new Date("2026-10-25T15:00:00Z"),
    });
  });

  test("a rate limit in an earlier run is not this run's ending", () => {
    const items = [
      ...claudeLimit.map((entry) => ({ ...entry, runId: "older" })),
      ...thread().items,
    ];

    expect(ending(thread({ items }))).toEqual({ kind: "other" });
  });

  test.each<[string, Item]>([
    [
      "a provider failure",
      item("error", "Provider turn failed.", { status: "failed", title: "Provider error" }),
    ],
    ["a reply that does nothing", item("assistant_message", "No response requested.")],
  ])("a restart notice followed by %s ends on the restart", (_, after) => {
    expect(ending(failed({ items: [restartNotice, after] }))).toEqual({ kind: "restart" });
  });

  test("a restart notice the turn acted on is not the ending", () => {
    const command = item("command_execution", "$ tail e2e.log");
    expect(ending(thread({ items: [restartNotice, command] }))).toEqual({ kind: "other" });
  });

  test("a restart that cancelled nothing is not a restart stall", () => {
    const notice = {
      ...restartNotice,
      text: "T3 Code restarted and resumed this turn\nContinue where you left off.",
    };

    expect(ending(thread({ items: [notice] }))).toEqual({ kind: "other" });
  });

  test.each(["interrupted", "cancelled"])("a %s run was stopped", (status) => {
    const facts = thread({ run: { ...thread().run!, status }, items: claudeLimit });
    expect(ending(facts)).toEqual({ kind: "stopped" });
  });

  test.each(["interrupted", "cancelled"])(
    "a restart continuation %s by the operator was stopped",
    (status) => {
      const reply = item("assistant_message", "Checking what the restart cancelled.");
      const facts = thread({ run: { ...thread().run!, status }, items: [restartNotice, reply] });
      expect(ending(facts)).toEqual({ kind: "stopped" });
    },
  );
});

describe("work in flight", () => {
  const shell = item("command_execution", "$ skills pr green 12", { status: "running" });
  test.each<[string, ThreadFacts, number, boolean]>([
    ["a live thread", thread({ status: "running" }), 0, true],
    ["a thread whose first run has not started", thread({ status: "queued", run: null }), 0, true],
    ["a completed run with a running command", thread({ items: [shell] }), 30, true],
    [
      "an earlier run's running subagent",
      thread({ items: [{ ...shell, type: "subagent", runId: "older" }] }),
      30,
      true,
    ],
    ["a failed run whose child still runs", failed({ items: [shell, ...claudeLimit] }), 30, true],
    ["a turn that says it waits", thread({ waits: true }), 30, true],
    ["a wait past 120 idle minutes", thread({ waits: true, items: [shell] }), 120, false],
    [
      "work the restart cancelled",
      failed({ waits: true, items: [shell, restartNotice] }),
      5,
      false,
    ],
    ["nothing in flight", thread(), 30, false],
  ])("%s", (_, facts, idle, expected) => {
    expect(running(facts, idle)).toBe(expected);
  });
});

function entry(ts: string, event: string, detail: string): TrailEntry {
  return { ts, project: "fixture", id: "188", event, detail, line: "" };
}

describe("the nudge limits", () => {
  const unknown = { kind: "nudge", cause: "unknown" } as const;
  const rateLimit = { kind: "nudge", cause: "rate-limit" } as const;
  test("one nudge per stall", () => {
    const trail = [entry("2026-10-25T09:00:00Z", "nudge", `unknown ${run}`)];
    expect(limit(rateLimit, trail, run, now)).toEqual({
      kind: "skip",
      reason: "nudged this stall",
    });
  });

  test("one nudge per hour across stalls", () => {
    const trail = [entry("2026-10-25T11:30:00Z", "nudge", "rate-limit other-run")];
    expect(limit(unknown, trail, run, now)).toEqual({
      kind: "skip",
      reason: "nudged 2026-10-25T11:30:00.000Z",
    });

    const older = [entry("2026-10-25T10:59:00Z", "nudge", "rate-limit other-run")];
    expect(limit(unknown, older, run, now)).toEqual(unknown);
  });

  test("three idle nudges with no other event stop the idle nudging only", () => {
    const nudges = ["a", "b", "b", "c"].map((id, index) =>
      entry(`2026-10-2${index + 1}T09:00:00Z`, "nudge", `unknown ${id}`),
    );

    const capped = {
      kind: "skip",
      reason: "nudged 3 times while idle with no other event",
    } as const;

    expect(limit(unknown, nudges, run, now)).toEqual(capped);
    expect(limit(unknown, nudges.slice(0, 3), run, now)).toEqual(unknown);
    expect(limit(rateLimit, nudges, run, now)).toEqual(rateLimit);

    const thread = entry("2026-10-24T10:00:00Z", "thread", "mcp:abc");
    expect(limit(unknown, [...nudges.slice(0, 2), thread, ...nudges.slice(2)], run, now)).toEqual(
      capped,
    );

    const review = entry("2026-10-22T10:00:00Z", "review", "feat/stalled");
    expect(limit(unknown, [nudges[0]!, review, ...nudges.slice(1)], run, now)).toEqual(unknown);
  });

  test("a skip passes through", () => {
    const skip = { kind: "skip", reason: "running" } as const;
    expect(limit(skip, [], run, now)).toEqual(skip);
  });
});

describe("the thread a row is bound to", () => {
  test.each<[string, TrailEntry[], string | undefined]>([
    ["no binding", [entry("t", "start", "feat/x")], undefined],
    [
      "a binding after the start",
      [entry("t", "start", "feat/x"), entry("t", "thread", "mcp:a")],
      "mcp:a",
    ],
    [
      "the latest binding after the start",
      [entry("t", "start", "feat/x"), entry("t", "thread", "mcp:a"), entry("t", "thread", "mcp:b")],
      "mcp:b",
    ],
    [
      "a binding from before a review that bound nothing",
      [
        entry("t", "start", "feat/x"),
        entry("t", "thread", "mcp:a"),
        entry("t", "handback", "x"),
        entry("t", "review", "feat/x"),
      ],
      undefined,
    ],
    [
      "a binding left by a refused start",
      [
        entry("t", "thread", "mcp:refused"),
        entry("t", "start", "feat/x"),
        entry("t", "thread", "mcp:a"),
      ],
      "mcp:a",
    ],
  ])("%s", (_, trail, expected) => {
    expect(binding(trail)).toBe(expected);
  });
});

describe("PLANS_RESUME_EVERY", () => {
  function config(content: string, overrides: Partial<DeliveryConfig> = {}): DeliveryConfig {
    return {
      mode: "hands-off",
      names: [],
      notes: [],
      content,
      invalid: false,
      path: "/conf",
      ...overrides,
    };
  }

  test.each<[string, { minutes?: number; note?: string }]>([
    ["DELIVERY=prs\n", {}],
    ["PLANS_RESUME_EVERY=20m\n", { minutes: 20 }],
    ["PLANS_RESUME_EVERY=0m\n", { note: "/conf: PLANS_RESUME_EVERY=0m is not <minutes>m" }],
    ["PLANS_RESUME_EVERY=1h\n", { note: "/conf: PLANS_RESUME_EVERY=1h is not <minutes>m" }],
    [
      "PLANS_RESUME_EVERY=20m\nPLANS_RESUME_EVERY=30m\n",
      { note: "/conf: PLANS_RESUME_EVERY is set more than once" },
    ],
  ])("%j", (content, expected) => {
    expect(resumeEvery(config(content))).toEqual(expected);
  });

  test("an invalid config turns resume off", () => {
    const invalid = config("x\n", { invalid: true, notes: ["/conf: line 1: malformed"] });
    expect(resumeEvery(invalid)).toEqual({ note: "/conf: line 1: malformed" });
  });
});

describe("skills plans resume", () => {
  let temporary: string;
  let plans: string;
  let repo: string;
  let conf: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "skills-resume-"));
    plans = join(temporary, "plans");
    repo = join(temporary, "fixture");
    conf = join(temporary, "skills.conf");

    await writeFixture(temporary, "skills.conf", "DELIVERY=prs\nPLANS_RESUME_EVERY=20m\n");
    await fixtureGit(temporary, ["init", "-q", "-b", "feat/stalled", repo]);
    await writeFixture(
      plans,
      "fixture/index.tsv",
      [
        COLUMNS.join("\t"),
        "181\tother\tDOING\tP1\tS\t-\t-\tfeat/other\t2026-10-25\t-",
        "188\tstalled\tDOING\tP1\tM\t-\t-\tfeat/stalled\t2026-10-25\t-",
        "189\tdone\tDONE\tP1\tM\t-\t-\tfeat/done\t2026-10-25\t-",
        "",
      ].join("\n"),
    );
  });

  afterEach(async () => {
    setSystemTime();
    await removeTemporary(temporary);
  });

  function env(): NodeJS.ProcessEnv {
    return { ...suiteEnvironment(), PLANS_DIR: plans, SKILLS_CONF: conf };
  }

  async function pass(args: string[], facts = "") {
    const out: string[] = [];
    const err: string[] = [];
    const io = {
      cwd: repo,
      env: env(),
      capture: true,
      out: (text: string) => void out.push(text),
      err: (text: string) => void err.push(text),
    };

    const code = await resumeVerb(args, usage, io, async () => facts);
    return { code, out: out.join(""), err: err.join("") };
  }

  test("prints off and nothing else while the key is unset", async () => {
    await writeFixture(temporary, "skills.conf", "DELIVERY=prs\n");
    expect(await pass(["fixture"])).toEqual({ code: 0, out: "off\n", err: "" });
    expect(await pass(["fixture", "--facts"], "not json")).toEqual({
      code: 0,
      out: "off\n",
      err: "",
    });
  });

  test("lists each DOING row with its bound thread and checkout", async () => {
    await appendLog("fixture", "188", "start", "feat/stalled", env());
    await appendLog("fixture", "188", "thread", "mcp:abc", env());
    await appendLog("fixture", "181", "handback", "feat/other", env());
    const result = await pass(["fixture"]);
    expect(result.code).toBe(0);
    expect(result.out).toMatch(
      /^every 20m\nskip 181 handed back\nread 188 mcp:abc \/.*\/fixture\n$/,
    );
  });

  test("two passes over one stall send one nudge", async () => {
    setSystemTime(now);
    const facts = JSON.stringify([failed({ items: claudeLimit })]);
    const first = await pass(["fixture", "--facts"], facts);
    expect(first.code).toBe(0);
    expect(first.out).toBe(
      `every 20m\nskip 181 no thread\nnudge 188 rate-limit mcp:abc ${run} Your last turn stopped on a usage limit, which may have cleared by now. Carry on with plan 188 from where you stopped.\n`,
    );

    for (const line of first.out.split("\n").filter((line) => line.startsWith("nudge "))) {
      const [, id, cause, , runId] = line.split(" ");
      await appendLog("fixture", id!, "nudge", `${cause} ${runId}`, env());
    }

    setSystemTime(new Date("2026-10-25T14:00:00Z"));
    const second = await pass(["fixture", "--facts"], facts);
    expect(second.out).toBe("every 20m\nskip 181 no thread\nskip 188 nudged this stall\n");
  });

  test("a handed back row with no facts says so", async () => {
    await appendLog("fixture", "181", "handback", "feat/other", env());
    await appendLog("fixture", "181", "thread", "mcp:late", env());
    const result = await pass(["fixture", "--facts"], "[]");
    expect(result.out).toBe("every 20m\nskip 181 handed back\nskip 188 no thread\n");
  });

  test("a bad or repeated entry skips its row and names the problem", async () => {
    const facts = JSON.stringify([
      { ...thread(), asks: "no" },
      thread({ id: "189" }),
      thread({ id: "181", thread: "mcp:a b" }),
      thread({ id: "189" }),
    ]);

    const result = await pass(["fixture", "--facts"], facts);
    expect(result.out).toBe(
      "every 20m\nskip 181 bad facts\nskip 188 bad facts\nskip 189 bad facts\n",
    );

    expect(result.err).toBe(
      "resume: facts for 188: asks and waits must be booleans\nresume: facts for 181: thread is not a thread id\nresume: facts for 189: listed more than once\n",
    );
  });

  test("refuses facts that are not a JSON array", async () => {
    expect(await pass(["fixture", "--facts"], "{}")).toEqual({
      code: 1,
      out: "",
      err: "resume: facts are not a JSON array\n",
    });
  });

  test("refuses another project's checkout and a bare call", async () => {
    expect((await pass(["Other"])).err).toContain(
      "resume: this checkout is fixture, not a checkout of Other",
    );

    expect((await pass([])).code).toBe(2);
  });
});

describe("the start rerun check", () => {
  let temporary: string;
  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "skills-resume-trail-"));
  });

  afterEach(async () => {
    await removeTemporary(temporary);
  });

  test("looks past bookkeeping lines to the start", async () => {
    const env = { ...suiteEnvironment(), PLANS_DIR: temporary };
    await appendLog("fixture", "188", "start", "feat/stalled", env);
    await appendLog("fixture", "188", "thread", "mcp:abc", env);
    await appendLog("fixture", "188", "nudge", `unknown ${run}`, env);
    expect(lastEvent("fixture", "188", env)?.event).toBe("nudge");
    expect(lastEvent("fixture", "188", env, ["thread", "nudge"])).toEqual({
      event: "start",
      detail: "feat/stalled",
    });
  });
});
