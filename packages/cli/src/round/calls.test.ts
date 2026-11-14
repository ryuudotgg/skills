import { afterEach, expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { failure, fixture, response, success } from "./fixtures.ts";
import { coderabbitFixture, macroscopeFixture } from "./reviewer-fixtures.ts";
import { runRound } from "./round.ts";
import { storedEvents } from "../test/stored-events.ts";
import { readSnapshot } from "./snapshot.ts";
import type { ReadResult } from "./types.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("all three real reviewers share one gate snapshot and only one settings git read", async () => {
  const value = fixture(["greptile", "coderabbit", "macroscope"]);
  temporary.push(value.temporary);
  const snapshot = coderabbitFixture("completed-head");
  value.deps.env.REVIEW_NOW = "2026-09-27T16:58:30Z";
  value.deps.gh = async (args, deadline) => {
    value.calls.push({ command: "gh", args, deadline });
    return success(response(snapshot.pr));
  };

  const spies = [
    spyOn(Bun, "spawn"),
    spyOn(Bun, "spawnSync"),
    spyOn(childProcess, "spawn"),
    spyOn(childProcess, "spawnSync"),
    spyOn(childProcess, "execFile"),
    spyOn(childProcess, "execFileSync"),
  ];

  try {
    const result = await runRound(["gate", "18"], value.deps);

    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("coderabbit done clean\n");
    expect(result.stdout).toContain("greptile ");
    expect(result.stdout).toContain("macroscope ");

    expect(value.calls.filter((call) => call.command === "gh")).toHaveLength(1);
    expect(value.calls.filter((call) => call.command === "git")).toHaveLength(1);
    expect(value.calls[0]).toMatchObject({
      command: "git",
      args: ["config", "--local", "--includes", "--null", "--get-regexp", "^skills\\."],
    });

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

const approvability = "Macroscope - Approvability Check";
const correctness = "Macroscope - Correctness Check";
const checkRun = (name: string, conclusion: string) => ({
  __typename: "CheckRun" as const,
  name,
  status: "COMPLETED",
  conclusion,
  startedAt: "2026-09-30T14:20:00Z",
  completedAt: "2026-09-30T14:20:00Z",
});

const restRows = (runs: ReturnType<typeof checkRun>[], args: readonly string[]) =>
  runs
    .filter((run) => args[2]!.includes(`check_name=${encodeURIComponent(run.name)}&`))
    .map((run) =>
      JSON.stringify([
        run.status.toLowerCase(),
        run.conclusion.toLowerCase(),
        run.startedAt,
        run.completedAt,
      ]),
    )
    .join("\n");

function pageTwoRound(conclusion: string, truncated: boolean) {
  const value = fixture(["greptile", "coderabbit", "macroscope"]);
  temporary.push(value.temporary);

  const snapshot = macroscopeFixture("context-page");
  const contexts = snapshot.pr.commits.nodes.at(-1)!.commit.statusCheckRollup!.contexts;
  const builds = Array.from({ length: 148 }, () => checkRun("build", "SUCCESS"));
  const reviewer = [checkRun(correctness, "SUCCESS"), checkRun(approvability, conclusion)];
  const all = truncated ? [...builds, ...reviewer] : [...reviewer, ...builds];

  contexts.nodes = all.slice(0, 100);
  contexts.pageInfo = { hasNextPage: truncated, endCursor: "context-100" };
  value.deps.env.REVIEW_NOW = "2026-09-30T14:30:00Z";

  return { value, all, page: all.slice(0, 100), pr: snapshot.pr };
}

for (const [conclusion, verdict] of [
  ["NEUTRAL", "done clean not-approved"],
  ["SUCCESS", "done approved"],
] as const)
  test(`correctness on page two reads as on page one: ${conclusion.toLowerCase()}`, async () => {
    const counts: number[] = [];
    const outputs: string[] = [];
    for (const truncated of [false, true]) {
      const { value, all, page, pr } = pageTwoRound(conclusion, truncated);
      value.deps.gh = async (args, deadline) => {
        value.calls.push({ command: "gh", args, deadline });
        return success(args[1] === "graphql" ? response(pr) : restRows(all.slice(100), args));
      };

      const result = await runRound(["gate", "18"], value.deps);
      const calls = value.calls.filter((call) => call.command === "gh");
      counts.push(calls.length);
      outputs.push(result.stdout);

      expect(all).toHaveLength(150);
      expect(page.some((run) => run.name.startsWith("Macroscope"))).toBe(!truncated);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`macroscope ${verdict}\n`);

      if (truncated)
        expect(calls.slice(1).map((call) => call.args)).toEqual(
          [approvability, correctness].map((name) => [
            "api",
            "--paginate",
            `repos/{owner}/{repo}/commits/${"a".repeat(40)}/check-runs?check_name=${encodeURIComponent(name)}&per_page=100`,
            "--jq",
            ".check_runs[] | [.status, .conclusion, .started_at, .completed_at] | @json",
          ]),
        );
    }

    expect(counts).toEqual([1, 3]);
    expect(outputs[1]).toBe(outputs[0]);
  });

test("head checks supplement never changes the first page", async () => {
  const pr = macroscopeFixture("full-contexts").pr;
  const before = structuredClone(pr);
  let calls = 0;
  const snapshot = await readSnapshot(
    "18",
    async () => (++calls === 1 ? success(response(pr)) : success('["queued",null,null,null]')),
    () => {},
    ["Macroscope - Approvability Check", "Macroscope - Approvability Check"],
  );

  expect(snapshot.pr).toEqual(before);
  expect(snapshot.headChecks).toEqual({
    "Macroscope - Approvability Check": [
      {
        __typename: "CheckRun",
        name: "Macroscope - Approvability Check",
        status: "QUEUED",
        conclusion: null,
        startedAt: null,
        completedAt: null,
      },
    ],
  });

  expect(calls).toBe(2);
});

for (const name of ["greptile", "coderabbit"])
  test(`${name} needs no head check supplement`, async () => {
    const value = fixture([name]);
    temporary.push(value.temporary);
    const pr = macroscopeFixture("full-contexts").pr;
    value.deps.gh = async (args, deadline) => {
      value.calls.push({ command: "gh", args, deadline });
      return success(response(pr));
    };

    await runRound(["gate", "18"], value.deps);

    expect(value.calls.filter((call) => call.command === "gh")).toHaveLength(1);
  });

async function failedHeadCheckRound(
  broken: ReadResult | null,
  args = ["gate", "18"],
  names = ["greptile", "coderabbit", "macroscope"],
) {
  const value = fixture(names);
  temporary.push(value.temporary);

  const plans = join(value.temporary, "plans");
  mkdirSync(plans);
  value.deps.env.PLANS_DIR = plans;

  const snapshot = macroscopeFixture("full-contexts");
  value.deps.env.REVIEW_NOW = "2026-09-30T14:30:00Z";
  value.deps.gh = async (args, deadline) => {
    value.calls.push({ command: "gh", args, deadline });
    if (args[1] === "graphql") return success(response(snapshot.pr));
    if (broken && args[2]!.includes("Approvability")) return broken;

    return success('["completed","neutral","2026-09-30T14:20:00Z","2026-09-30T14:20:00Z"]');
  };

  const result = await runRound(args, value.deps);
  const line = (name: string) =>
    result.stdout.split("\n").find((entry) => entry.startsWith(`${name} `));

  return { result, line, events: storedEvents(plans, "round") };
}

for (const [name, broken] of [
  [
    "deadline",
    {
      code: -1,
      stdout: "",
      stderr: "gh api: no exit within 60 s\n",
      failure: { kind: "deadline", read: "gh api", deadline: 60_000 },
    },
  ],
  ["exit", failure("offline\n")],
] as const)
  test(`a failed head check read that can succeed later waits: ${name}`, async () => {
    const read = await failedHeadCheckRound(null);
    const { result, line } = await failedHeadCheckRound(broken);

    expect(line("macroscope")).toBe("macroscope wait unreadable");
    expect(line("greptile")).toBe(read.line("greptile"));
    expect(line("coderabbit")).toBe(read.line("coderabbit"));
    expect(result.stderr).toContain("round: Macroscope - Approvability Check: ");
    expect(result.stderr).not.toContain("round: macroscope:");
  });

test("a failed head check read gh names forbidden refuses only macroscope", async () => {
  const { result, line } = await failedHeadCheckRound({
    code: 1,
    stdout: JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "not allowed" }] }),
    stderr: "gh: not allowed\n",
  });

  expect(line("macroscope")).toBe("macroscope handback refused");
  expect(line("greptile")).not.toBe("greptile handback refused");
  expect(line("coderabbit")).not.toBe("coderabbit handback refused");
  expect(result.stderr).toBe(
    "round: Macroscope - Approvability Check: forbidden: gh: not allowed\nround: macroscope: cannot parse PR review\n",
  );
});

test("a failed head check read that can succeed later records no round event", async () => {
  const decide = ["decide", "18", "feat/topic", "macroscope=fixed"];
  const read = await failedHeadCheckRound(null, decide, ["macroscope"]);
  const missed = await failedHeadCheckRound(failure("offline\n"), decide, ["macroscope"]);

  expect(read.events).toHaveLength(1);
  expect(missed.line("macroscope")).toBe("macroscope wait unreadable");
  expect(missed.events).toEqual([]);
});
