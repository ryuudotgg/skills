import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ghFixture } from "../evals/gh-fake.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { GhGitHubReader } from "./github.ts";
import { main, type CliRuntime } from "./watch.ts";
import type { WatcherVerdict } from "./types.ts";

const reviewers = { checks: [], logins: [], outsideDiffHeadings: [] };
const directories: string[] = [];
const checkout = resolve(import.meta.dir, "../..");

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "skills-whole-pr-"));
  directories.push(directory);
  return directory;
}

function connection(
  nodes: readonly unknown[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function thread(number: number, unresolved = 120) {
  return {
    id: `thread-${number}`,
    isResolved: number !== unresolved,
    starter: {
      nodes: [
        {
          body: `finding ${number}`,
          createdAt: "2026-10-02T00:00:00Z",
          path: "src/example.ts",
          line: number,
          author: { login: "developer" },
        },
      ],
    },
  };
}

function head(contexts: unknown, oid = "head") {
  return { nodes: [{ commit: { oid, statusCheckRollup: { contexts } } }] };
}

function poll(
  threads: unknown,
  contexts = connection([
    { __typename: "StatusContext", context: "ci", state: "SUCCESS", targetUrl: "" },
  ]),
) {
  return {
    data: {
      repository: {
        pullRequest: {
          state: "OPEN",
          mergedAt: null,
          isDraft: false,
          mergeable: "MERGEABLE",
          mergeStateStatus: "CLEAN",
          reviewDecision: "APPROVED",
          headRefOid: "head",
          headRefName: "feature",
          baseRefName: "main",
          commits: {
            nodes: [{ commit: { oid: "head", statusCheckRollup: { state: "SUCCESS" } } }],
          },
          head: head(contexts),
          reviewThreads: threads,
        },
      },
    },
  };
}

function fixture(directory: string, argvPrefix: string, response: unknown): void {
  const key = argvPrefix.replace(/[^A-Za-z0-9._-]/gu, "_");
  writeFileSync(join(directory, `${key}.prefix`), JSON.stringify(response));
}

function harness(directory: string) {
  const calls: { argv: readonly string[]; deadline: number }[] = [];
  const events: WatcherVerdict[] = [];
  const sleeps: number[] = [];
  let now = 0;
  const reader = new GhGitHubReader(reviewers, async (argv, deadline) => {
    calls.push({ argv, deadline });
    const result = ghFixture(directory, argv.slice(1));
    return { ...result, stdout: result.stdout.toString() };
  });

  const runtime: CliRuntime = {
    reader,
    clock: {
      now: () => now,
      observedAt: () => "2026-10-02T00:00:00Z",
      async sleep(seconds) {
        sleeps.push(seconds);
        now += seconds;
      },
    },
    stdout: (text) => {
      events.push(JSON.parse(text));
    },
    stderr: (text) => {
      throw new Error(text);
    },
  };

  return { calls, events, sleeps, runtime };
}

const explicit = ["--owner", "o", "--repo", "r", "--pr", "1"];
const pollPrefix = "api graphql -f query=query PrPoll(";
const threadPrefix = "api graphql -f after=threads-100 -f query=query ReviewThreads(";
const contextPrefix = "api graphql -f after=contexts-100 -f query=query PrCheckRollup(";

test("the whole PR reader finds unresolved thread 120 and never emits READY", async () => {
  const directory = temporary();
  fixture(
    directory,
    pollPrefix,
    poll(
      connection(
        Array.from({ length: 100 }, (_, index) => thread(index + 1)),
        true,
        "threads-100",
      ),
    ),
  );

  fixture(directory, threadPrefix, {
    data: {
      repository: {
        pullRequest: {
          headRefOid: "head",
          reviewThreads: connection(Array.from({ length: 50 }, (_, index) => thread(index + 101))),
        },
      },
    },
  });

  const value = harness(directory);
  expect(await main(explicit, reviewers, value.runtime)).toBe(3);
  expect(value.events.at(-1)).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      kind: "review-threads",
      threads: [{ id: "thread-120", firstComment: { body: "finding 120" } }],
    },
  });

  expect(value.events.some((event) => event.kind === "READY")).toBe(false);
  expect(value.calls).toHaveLength(2);
  expect(value.calls.every((call) => call.argv.includes("starter=true"))).toBe(true);
});

test("a hung gh api read ends the spawned watch at its five second timeout", async () => {
  const directory = temporary();
  const shim = join(directory, "bin");
  mkdirSync(shim);

  const originalPath = process.env.PATH ?? "";
  const executable = join(shim, "gh");
  writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = api ]; then exec sleep 30; fi\necho "gh shim: unexpected $*" >&2\nexit 1\n`,
  );

  chmodSync(executable, 0o755);

  const started = performance.now();
  const result = await runCommand(
    [join(checkout, "skills/playbook/bin/skills"), "pr", "watch", ...explicit, "--timeout", "5"],
    {
      cwd: checkout,
      env: { ...suiteEnvironment(), PATH: `${shim}:${originalPath}` },
      timeout: 10_000,
    },
  );

  expect(result.code).toBe(5);
  expect(result.timedOut).toBe(false);
  expect(performance.now() - started).toBeLessThan(7_000);
  const events = result.stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));

  expect(events.at(-1)).toMatchObject({
    kind: "TIMEOUT",
    exitCode: 5,
    reason: { kind: "status-unavailable" },
  });

  expect(events.some((event) => event.kind === "RETRY")).toBe(false);
}, 12_000);

test("repeating a contexts cursor fails with a bounded status-query blocker", async () => {
  const directory = temporary();
  const contexts = connection(
    [{ __typename: "StatusContext", context: "ci", state: "SUCCESS" }],
    true,
    "contexts-100",
  );

  fixture(directory, pollPrefix, poll(connection([]), contexts));
  fixture(directory, contextPrefix, {
    data: { repository: { pullRequest: { headRefOid: "head", head: head(contexts) } } },
  });

  const value = harness(directory);
  expect(await main([...explicit, "--max-query-errors", "2"], reviewers, value.runtime)).toBe(7);
  expect(value.events.at(-1)).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      kind: "status-query",
      failures: 2,
      failure: {
        kind: "missing-key",
        detail: 'invalid contexts.pageInfo.endCursor: "contexts-100"',
      },
    },
  });

  expect(value.calls).toHaveLength(4);
});

test("pending CI below the page limits needs only one gh call per poll", async () => {
  const directory = temporary();
  const response = poll(
    connection([]),
    connection([{ __typename: "StatusContext", context: "ci", state: "PENDING" }]),
  );

  response.data.repository.pullRequest.mergeStateStatus = "UNKNOWN";
  fixture(directory, pollPrefix, response);

  const value = harness(directory);
  expect(await main([...explicit, "--timeout", "1"], reviewers, value.runtime)).toBe(5);
  expect(value.calls).toHaveLength(1);
  expect(value.sleeps).toEqual([1]);
  expect(value.events.at(-1)).toMatchObject({
    kind: "TIMEOUT",
    reason: { kind: "pending-checks" },
  });
});

test("changing head on thread page two twice discards both reads and never emits READY", async () => {
  const directory = temporary();
  fixture(
    directory,
    pollPrefix,
    poll(
      connection(
        Array.from({ length: 100 }, (_, index) => thread(index + 1, 0)),
        true,
        "threads-100",
      ),
    ),
  );

  fixture(directory, threadPrefix, {
    data: {
      repository: {
        pullRequest: {
          headRefOid: "other-head",
          reviewThreads: connection(
            Array.from({ length: 50 }, (_, index) => thread(index + 101, 0)),
          ),
        },
      },
    },
  });

  const value = harness(directory);
  expect(await main([...explicit, "--max-query-errors", "1"], reviewers, value.runtime)).toBe(7);
  expect(value.events.some((event) => event.kind === "READY")).toBe(false);
  expect(value.events.at(-1)).toMatchObject({
    kind: "BLOCKER",
    blocker: {
      failure: {
        kind: "merge-state-unknown",
        detail: "head of #1 moved from head to other-head during one poll",
      },
    },
  });

  expect(value.calls).toHaveLength(4);
  expect(value.sleeps).toEqual([]);
});
