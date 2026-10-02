import { afterEach, expect, spyOn, test } from "bun:test";
import childProcess from "node:child_process";
import { rmSync } from "node:fs";
import { failure, fixture, response, success } from "./fixtures.ts";
import { coderabbitFixture, macroscopeFixture } from "./reviewer-fixtures.ts";
import { runRound } from "./round.ts";
import { readSnapshot } from "./snapshot.ts";

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

for (const [conclusion, verdict] of [
  ["neutral", "done clean not-approved"],
  ["success", "done approved"],
] as const)
  test(`150 head contexts read approvability on page two: ${conclusion}`, async () => {
    const counts: number[] = [];
    for (const truncated of [false, true]) {
      const value = fixture(["greptile", "coderabbit", "macroscope"]);
      temporary.push(value.temporary);
      const snapshot = macroscopeFixture("context-page");
      const contexts = snapshot.pr.commits.nodes.at(-1)!.commit.statusCheckRollup!.contexts;
      const remaining = Array.from({ length: 50 }, (_, index) => ({
        __typename: "CheckRun" as const,
        name: index === 49 ? "Macroscope - Approvability Check" : "build",
        status: "COMPLETED",
        conclusion: conclusion.toUpperCase(),
        startedAt: "2026-09-30T14:20:00Z",
      }));

      const allContexts = [...contexts.nodes, ...remaining];
      contexts.pageInfo = { hasNextPage: truncated, endCursor: "context-100" };
      value.deps.env.REVIEW_NOW = "2026-09-30T14:30:00Z";
      value.deps.gh = async (args, deadline) => {
        value.calls.push({ command: "gh", args, deadline });

        return success(
          args[1] === "graphql"
            ? response(snapshot.pr)
            : remaining
                .filter((check) => check.name === "Macroscope - Approvability Check")
                .map((check) =>
                  JSON.stringify([
                    check.status.toLowerCase(),
                    check.conclusion.toLowerCase(),
                    check.startedAt,
                  ]),
                )
                .join("\n"),
        );
      };

      const result = await runRound(["gate", "18"], value.deps);
      const calls = value.calls.filter((call) => call.command === "gh");
      counts.push(calls.length);

      expect(contexts.nodes).toHaveLength(100);
      expect(allContexts).toHaveLength(150);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain(`macroscope ${truncated ? verdict : "done clean"}\n`);

      if (truncated)
        expect(calls[1]!.args).toEqual([
          "api",
          "--paginate",
          `repos/{owner}/{repo}/commits/${"a".repeat(40)}/check-runs?check_name=Macroscope%20-%20Approvability%20Check&per_page=100`,
          "--jq",
          ".check_runs[] | [.status, .conclusion, .started_at] | @json",
        ]);
    }

    expect(counts).toEqual([1, 2]);
  });

test("head checks supplement never changes the first page", async () => {
  const pr = macroscopeFixture("full-contexts").pr;
  const before = structuredClone(pr);
  let calls = 0;
  const snapshot = await readSnapshot(
    "18",
    async () => (++calls === 1 ? success(response(pr)) : success('["queued",null,null]')),
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

test("a failed head check read refuses only the reviewer that declared it", async () => {
  const value = fixture(["greptile", "coderabbit", "macroscope"]);
  temporary.push(value.temporary);
  const snapshot = macroscopeFixture("full-contexts");
  value.deps.env.REVIEW_NOW = "2026-09-30T14:30:00Z";
  value.deps.gh = async (args, deadline) => {
    value.calls.push({ command: "gh", args, deadline });
    return args[1] === "graphql" ? success(response(snapshot.pr)) : failure("offline\n");
  };

  const result = await runRound(["gate", "18"], value.deps);
  const lines = result.stdout.split("\n");

  expect(lines.find((line) => line.startsWith("macroscope "))).toBe("macroscope handback refused");
  expect(lines.find((line) => line.startsWith("coderabbit "))).not.toBe("coderabbit handback refused");
  expect(lines.find((line) => line.startsWith("greptile "))).not.toBe("greptile handback refused");
  expect(result.stderr).toBe(
    "round: Macroscope - Approvability Check: offline\nround: Macroscope - Approvability Check: gh failed reading head checks\nround: macroscope: cannot parse PR review\n",
  );
});
