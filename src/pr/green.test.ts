import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { fakeReader, failedCheck, pendingCheck, type FakeReaderOptions } from "./fakes.ts";
import { GhGitHubReader, WatcherQueryError } from "./github.ts";
import { judge, lines, main, waitForGreen } from "./green.ts";
import type { GitHubReader, PrRead } from "./types.ts";
import { parsePrNumber } from "./types.ts";
import { reviewerDeclarations, type CliRuntime } from "./watch.ts";

const root = resolve(import.meta.dir, "../../skills");
const context = { owner: "owner", repo: "repo", number: parsePrNumber(1) };

describe("terminal transport failures", () => {
  for (const [cause, response] of [
    [
      "not found",
      {
        code: 1,
        stdout: JSON.stringify({
          data: { repository: { pullRequest: null } },
          errors: [
            {
              type: "NOT_FOUND",
              path: ["repository", "pullRequest"],
              message: "Could not resolve to a PullRequest with the number of 99999.",
            },
          ],
        }),
        stderr: "gh: Could not resolve to a PullRequest with the number of 99999.",
      },
    ],
    [
      "unauthenticated",
      {
        code: 1,
        stdout: JSON.stringify({
          message: "Bad credentials",
          documentation_url: "https://docs.github.com/rest",
          status: "401",
        }),
        stderr: "gh: Bad credentials (HTTP 401)",
      },
    ],
  ] as const)
    test(`green stops on ${cause} on its first pass`, async () => {
      let calls = 0;
      const reader = new GhGitHubReader(reviewerDeclarations(root), async () => {
        calls++;
        return response;
      });

      const run = harness(reader);

      expect(await waitForGreen([context], reader, run.runtime.clock, [], 10, 600)).toEqual({
        code: 1,
        lines: [`#1 unreadable ${cause}: ${response.stderr}`],
      });

      expect(calls).toBe(1);
      expect(run.sleeps).toEqual([]);
      expect(run.runtime.clock.now()).toBe(0);
    });
});

async function sample(options: FakeReaderOptions = {}): Promise<PrRead> {
  return fakeReader(options).read(context);
}

function harness(reader: GitHubReader) {
  let now = 0;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const sleeps: number[] = [];
  const runtime: CliRuntime = {
    reader,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
    clock: {
      now: () => now,
      observedAt: () => "2026-10-03T00:00:00Z",
      async sleep(seconds) {
        sleeps.push(seconds);
        now += seconds;
      },
    },
  };

  return { runtime, stdout, stderr, sleeps };
}

function sequence(reads: readonly PrRead[]): GitHubReader {
  let index = 0;
  return {
    ...fakeReader(),
    async read(requested) {
      const read = reads[Math.min(index++, reads.length - 1)]!;
      return { ...read, facts: { ...read.facts, context: requested } };
    },
  };
}

describe("judge", () => {
  test("green identifies the full head and renders seven characters", async () => {
    const verdict = judge(await sample({ facts: { headRefOid: "abcdef123456" } }), []);
    expect(verdict).toEqual({ kind: "green", head: "abcdef123456" });
    expect(lines(context.number, verdict)).toEqual(["#1 green abcdef1"]);
  });

  test("collects conflicts and failing checks before pending checks", async () => {
    const verdict = judge(
      await sample({
        facts: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" },
        checks: [
          pendingCheck(),
          { ...failedCheck("Test"), link: "https://ci.test/1" },
          failedCheck("Lint"),
        ],
      }),
      [],
    );

    expect(lines(context.number, verdict)).toEqual([
      "#1 conflicting CONFLICTING DIRTY",
      "#1 failing Test https://ci.test/1",
      "#1 failing Lint -",
    ]);
  });

  test("BEHIND and CONFLICTING merge states are red even when mergeable", async () => {
    for (const mergeStateStatus of ["BEHIND", "CONFLICTING"] as const) {
      const verdict = judge(await sample({ facts: { mergeStateStatus } }), []);
      expect(lines(context.number, verdict)).toEqual([
        `#1 conflicting MERGEABLE ${mergeStateStatus}`,
      ]);
    }
  });

  test("merged and closed take precedence over unavailable heads and checks", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const verdict = judge(
        await sample({ facts: { state, headRefOid: null }, checks: [failedCheck()] }),
        [],
      );

      expect(lines(context.number, verdict)).toEqual([
        state === "MERGED" ? "#1 merged" : "#1 closed",
      ]);
    }

    expect(judge(await sample({ facts: { state: "CLOSED", mergedAt: "2026-10-03" } }), [])).toEqual(
      { kind: "merged" },
    );
  });

  test("an unavailable head waits before classifying conflicts", async () => {
    const verdict = judge(
      await sample({ facts: { headRefOid: null, mergeable: "CONFLICTING" } }),
      [],
    );

    expect(lines(context.number, verdict)).toEqual(["#1 unreadable PR head sha is unavailable"]);
  });

  test("ignores reviewer name substrings case insensitively and code review gates", async () => {
    const verdict = judge(
      await sample({
        checks: [
          ...(await sample()).checks,
          pendingCheck("Review GREPTILE check"),
          failedCheck("Greptile review"),
          failedCheck("Code Review Gate"),
          { ...pendingCheck(), kind: "code-review-gate", name: "Code Review Gate" },
        ],
      }),
      ["greptile"],
    );

    expect(verdict).toEqual({ kind: "green", head: "head" });
  });

  test("collects pending, unknown mergeability and missing head checks", async () => {
    const verdict = judge(
      await sample({ facts: { mergeable: "UNKNOWN" }, checks: [pendingCheck("Test")] }),
      [],
    );

    expect(lines(context.number, verdict)).toEqual(["#1 pending Test", "#1 mergeability unknown"]);

    const missing = judge(
      await sample({ checks: [], commitRollups: [{ oid: "old", state: "FAILURE" }] }),
      [],
    );

    expect(lines(context.number, missing)).toEqual(["#1 no checks yet on head"]);
  });

  test("zero head checks always wait regardless of earlier rollups", async () => {
    for (const commitRollups of [
      [],
      [{ oid: "old", state: null }],
      [{ oid: "head", state: "SUCCESS" }],
    ] as const)
      expect(judge(await sample({ checks: [], commitRollups }), [])).toEqual({
        kind: "waiting",
        holds: [{ kind: "no-checks", head: "head" }],
      });
  });

  test("a blocked failure rollup catches hidden failing runs", async () => {
    for (const state of ["FAILURE", "ERROR"] as const) {
      const verdict = judge(
        await sample({
          facts: { mergeStateStatus: "BLOCKED" },
          commitRollups: [
            { oid: "old", state: "SUCCESS" },
            { oid: "head", state },
          ],
        }),
        [],
      );

      expect(lines(context.number, verdict)).toEqual([`#1 blocked ${state}`]);
    }

    expect(
      judge(
        await sample({
          facts: { mergeStateStatus: "BLOCKED" },
          commitRollups: [
            { oid: "old", state: "FAILURE" },
            { oid: "head", state: "SUCCESS" },
          ],
        }),
        [],
      ).kind,
    ).toBe("green");
  });
});

describe("pr green main", () => {
  test("confirms green with one default interval and infers the current PR", async () => {
    const reader = fakeReader();
    const run = harness(reader);

    expect(await main([], root, run.runtime)).toBe(0);
    expect(run.sleeps).toEqual([30]);
    expect(reader.calls.filter((call) => call === "read")).toHaveLength(2);
    expect(reader.calls[0]).toBe("currentPr");

    expect(run.stdout).toEqual(["#1 green head\n"]);
    expect(run.stderr).toEqual(["waiting: #1 green head\n"]);
  });

  test("failing checks print their link without sleeping", async () => {
    const run = harness(
      fakeReader({ checks: [{ ...failedCheck("Test"), link: "https://ci.test/1" }] }),
    );

    expect(await main(["#1"], root, run.runtime)).toBe(1);
    expect(run.stdout).toEqual(["#1 failing Test https://ci.test/1\n"]);
    expect(run.sleeps).toEqual([]);
  });

  test("pending becomes green, then gets a confirmation pass", async () => {
    const run = harness(
      sequence([await sample({ checks: [pendingCheck("Test")] }), await sample()]),
    );

    expect(await main(["1", "--interval", "2"], root, run.runtime)).toBe(0);
    expect(run.sleeps).toEqual([2, 2]);
    expect(run.stdout).toEqual(["#1 green head\n"]);
    expect(run.stderr[0]).toBe("waiting: #1 pending Test\n");
  });

  test("confirms merged PRs but exits immediately for closed PRs", async () => {
    for (const state of ["MERGED", "CLOSED"] as const) {
      const run = harness(fakeReader({ facts: { state } }));
      expect(await main(["1"], root, run.runtime)).toBe(state === "MERGED" ? 0 : 1);
      expect(run.stdout).toEqual([state === "MERGED" ? "#1 merged\n" : "#1 closed\n"]);
      expect(run.sleeps).toEqual(state === "MERGED" ? [30] : []);
    }
  });

  test("timeout prints the last pending pass", async () => {
    const run = harness(fakeReader({ checks: [pendingCheck("Test")] }));
    expect(await main(["1", "--interval=2", "--timeout=5"], root, run.runtime)).toBe(1);
    expect(run.stdout).toEqual(["#1 pending Test\n"]);
    expect(run.sleeps).toEqual([2, 2]);
    expect(run.stderr).toHaveLength(2);
  });

  test("ready passes confirm beyond the deadline", async () => {
    for (const timeout of [1, 30]) {
      const run = harness(fakeReader());
      expect(await main(["1", "--timeout", String(timeout)], root, run.runtime)).toBe(0);
      expect(run.sleeps).toEqual([30]);
    }
  });

  test("a confirmation that finishes after the deadline succeeds", async () => {
    const run = harness(fakeReader());
    const base = fakeReader();
    let reads = 0;
    const reader: GitHubReader = {
      ...base,
      async read(requested) {
        if (reads++ > 0) await run.runtime.clock.sleep(100);
        return base.read(requested);
      },
    };

    expect(await main(["1", "--timeout", "30"], root, { ...run.runtime, reader })).toBe(0);
    expect(run.sleeps).toEqual([30, 100]);
  });

  test("no CI requires 120 seconds on the same head and a confirmation", async () => {
    for (const commitRollups of [[], [{ oid: "old", state: "FAILURE" }]] as const) {
      const early = harness(fakeReader({ checks: [], commitRollups }));
      expect(await main(["1", "--timeout", "119"], root, early.runtime)).toBe(1);
      expect(early.stdout).toEqual(["#1 no checks yet on head\n"]);

      const run = harness(fakeReader({ checks: [], commitRollups }));
      expect(await main(["1", "--timeout", "120"], root, run.runtime)).toBe(0);
      expect(run.sleeps).toEqual([30, 30, 30, 30, 30]);
      expect(run.stdout).toEqual(["#1 green head\n"]);
    }
  });

  test("a new unchecked head restarts its no CI window", async () => {
    const run = harness(
      sequence([
        await sample({ checks: [] }),
        await sample({ checks: [], facts: { headRefOid: "newhead123" } }),
      ]),
    );

    expect(await main(["1", "--timeout", "120"], root, run.runtime)).toBe(1);
    expect(run.stdout).toEqual(["#1 no checks yet on newhead\n"]);
  });

  test("no CI does not clear an unknown mergeability hold", async () => {
    const run = harness(fakeReader({ checks: [], facts: { mergeable: "UNKNOWN" } }));
    const result = await waitForGreen(
      [context],
      run.runtime.reader,
      run.runtime.clock,
      [],
      30,
      180,
    );

    expect(result).toEqual({ lines: ["#1 mergeability unknown"], code: 1 });
  });

  test("a changed head restarts confirmation", async () => {
    const run = harness(
      sequence([await sample(), await sample({ facts: { headRefOid: "newhead123" } })]),
    );

    expect(await main(["1"], root, run.runtime)).toBe(0);
    expect(run.sleeps).toEqual([30, 30]);
    expect(run.stdout).toEqual(["#1 green newhead\n"]);
  });

  test("late checks cancel a green candidate", async () => {
    const run = harness(
      sequence([
        await sample({ checks: [], commitRollups: [] }),
        await sample({ checks: [pendingCheck()] }),
        await sample(),
      ]),
    );

    expect(await main(["1"], root, run.runtime)).toBe(0);
    expect(run.sleeps).toEqual([30, 30, 30]);
  });

  test("a historical rollup waits for checks on the new head", async () => {
    const run = harness(
      sequence([
        await sample({ checks: [], commitRollups: [{ oid: "old", state: "SUCCESS" }] }),
        await sample(),
      ]),
    );

    expect(await main(["1"], root, run.runtime)).toBe(0);
    expect(run.stderr[0]).toBe("waiting: #1 no checks yet on head\n");
    expect(run.sleeps).toEqual([30, 30]);
  });

  test("a red PR among several prints every PR in argument order without waiting", async () => {
    const base = fakeReader();
    const reader: GitHubReader = {
      ...base,
      async read(requested) {
        return fakeReader({
          checks: requested.number === 2 ? [failedCheck()] : [pendingCheck()],
        }).read(requested);
      },
    };

    const run = harness(reader);
    expect(await main(["3", "2", "1"], root, run.runtime)).toBe(1);
    expect(run.stdout).toEqual(["#3 pending ci\n#2 failing ci -\n#1 pending ci\n"]);
    expect(run.sleeps).toEqual([]);
  });

  test("a query error becomes an unreadable hold, then can recover", async () => {
    const base = fakeReader();
    let reads = 0;
    const run = harness({
      ...base,
      async read(requested) {
        if (reads++ === 0)
          throw new WatcherQueryError({
            kind: "checks-unavailable",
            retryable: true,
            detail: "not ready\nyet",
          });

        return base.read(requested);
      },
    });

    expect(await main(["1"], root, run.runtime)).toBe(0);
    expect(run.stderr[0]).toBe("waiting: #1 unreadable not ready yet\n");
    expect(run.sleeps).toEqual([30, 30]);
  });

  test("a nonretryable query error prints all PRs and stops immediately", async () => {
    const base = fakeReader();
    const run = harness({
      ...base,
      async read(requested) {
        if (requested.number === 2)
          throw new WatcherQueryError({
            kind: "read-failed",
            retryable: false,
            detail: "permission denied",
          });

        return base.read(requested);
      },
    });

    expect(await main(["3", "2", "1"], root, run.runtime)).toBe(1);
    expect(run.stdout).toEqual(["#3 green head\n#2 unreadable permission denied\n#1 green head\n"]);
    expect(run.sleeps).toEqual([]);
  });

  test("usage errors and help never touch the reader", async () => {
    for (const argv of [
      ["1", "#1"],
      ["0"],
      ["bad"],
      ["--unknown"],
      ["--interval"],
      ["--interval", "0"],
      ["--interval=1=2"],
      ["--timeout", "NaN"],
    ]) {
      const reader = fakeReader();
      const run = harness(reader);

      expect(await main(argv, root, run.runtime)).toBe(2);
      expect(run.stdout).toEqual([]);
      expect(run.stderr.join("")).toContain("usage:");
      expect(reader.calls).toEqual([]);
    }

    const reader = fakeReader();
    const run = harness(reader);
    expect(await main(["--help"], root, run.runtime)).toBe(0);
    expect(run.stdout.join("")).toContain("skills pr green");
    expect(reader.calls).toEqual([]);
  });
});
