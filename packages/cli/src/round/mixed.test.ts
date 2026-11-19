import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { bin, failure, fixture, repo, response, success } from "./fixtures.ts";
import mixed from "./mixed-fixtures.json";
import { runRound } from "./round.ts";
import type { PullRequest } from "./types.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(start: keyof typeof mixed) {
  const value = fixture(["coderabbit", "greptile"]);
  temporary.push(value.temporary);
  let current = start;
  let reads = 0;
  value.deps.gh = async (args, deadline) => {
    value.calls.push({ command: "gh", args, deadline });
    reads += 1;
    return success(response(mixed[current] as PullRequest));
  };

  value.deps.git = async (args, deadline) => {
    value.calls.push({ command: "git", args, deadline });
    if (args[0] === "config") return args.includes("--get-regexp") ? failure() : success("main");
    if (args[0] === "rev-list") return success("c".repeat(40));
    if (args[0] === "log") return success(args.includes("--numstat") ? "1\t0\tshared\0" : "");

    return success(args.includes(`${"a".repeat(40)}^{commit}`) ? "a".repeat(40) : "b".repeat(40));
  };

  return {
    ...value,
    reads: () => reads,
    next: (name: keyof typeof mixed) => {
      current = name;
    },
  };
}

test("gate --wait on a pending check sleeps once and reads the PR twice", async () => {
  const value = setup("gate-pending");
  const sleeps: number[] = [];
  value.deps.sleep = async (seconds) => {
    sleeps.push(seconds);
    value.advance(seconds);
    value.next("gate-completed");
  };

  const result = await runRound(["gate", "18", "--wait"], value.deps);

  expect(result.stdout).toBe("coderabbit done clean\ngreptile triage scored\ntriage\n");
  expect(sleeps).toHaveLength(1);
  expect(value.reads()).toBe(2);
});

test("gate --wait hands back a rate limit after one read, without sleeping", async () => {
  const value = setup("limited");
  value.deps.env.REVIEW_NOW = "2026-09-27T17:11:01Z";
  value.deps.sleep = async () => {
    throw new Error("limited handback slept");
  };

  const result = await runRound(["gate", "18", "--wait"], value.deps);

  expect(result.stdout).toBe(
    "coderabbit unavailable rate-limited 2\ngreptile absent\nhandback coderabbit unavailable rate-limited 2\n",
  );

  expect(value.reads()).toBe(1);
});

for (const [next, expected] of [
  ["decide-expired", "rereview below-threshold"],
  ["decide-pending", "wait check-pending"],
  ["decide-completed", "triage scored"],
] as const)
  test(`decide sleeps once and reads the ${next.slice(7)} state`, async () => {
    const value = setup("decide-start");
    const sleeps: number[] = [];
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(seconds);
      value.next(next);
    };

    const result = await runRound(["decide", "18", "feature", "greptile=fixed"], value.deps);

    expect(result.stdout).toBe(
      `coderabbit done clean\ngreptile ${expected}\n${expected.split(" ")[0]}\n`,
    );

    expect(sleeps).toHaveLength(1);
    expect(value.reads()).toBe(2);
  });

test("decide that sleeps past its deadline waits after one read", async () => {
  const value = setup("decide-start");
  const sleeps: number[] = [];
  value.deps.sleep = async (seconds) => {
    sleeps.push(seconds);
    value.advance(10_000_000_000);
    value.next("decide-expired");
  };

  const result = await runRound(["decide", "18", "feature", "greptile=fixed"], value.deps);

  expect(result.stdout).toBe("coderabbit done clean\ngreptile wait check-appear\nwait\n");
  expect(sleeps).toHaveLength(1);
  expect(value.reads()).toBe(1);
});

for (const [outcome, expected, reads] of [
  ["fixed", "rereview below-threshold", 2],
  ["dismissed", "handback all-dismissed", 0],
] as const)
  test(`${outcome} outcome ${reads ? "counts fixes from git log" : "skips git log"}`, async () => {
    const value = setup("decide-expired");
    const result = await runRound(["decide", "18", "feature", `greptile=${outcome}`], value.deps);

    expect(result.stdout).toContain(`greptile ${expected}\n`);
    expect(
      value.calls.filter((entry) => entry.command === "git" && entry.args[0] === "log"),
    ).toHaveLength(reads);
  });

test("a review of the fixed tip triages without reading fixes", async () => {
  const value = setup("gate-completed");
  const result = await runRound(["decide", "18", "feature", "greptile=fixed"], value.deps);

  expect(result.stdout).toBe("coderabbit done clean\ngreptile triage scored\ntriage\n");
  expect(
    value.calls.filter((entry) => entry.command === "git" && entry.args[0] === "log"),
  ).toHaveLength(0);
});

test("fixed refuses when fix reads fail", async () => {
  const value = setup("decide-expired");
  const git = value.deps.git;
  value.deps.git = (args, deadline) =>
    args[0] === "show-ref" ? Promise.resolve(failure()) : git(args, deadline);

  const result = await runRound(["decide", "18", "feature", "greptile=fixed"], value.deps);

  expect(result.stdout).toContain("greptile handback refused\n");
  expect(result.stderr).toContain("branch is not a local branch");
});

test("dismissed reads no fix facts, so a failing fix read cannot refuse it", async () => {
  const value = setup("decide-expired");
  const calls: string[] = [];
  value.deps.git = (args) => {
    calls.push(args.join(" "));
    return Promise.resolve(failure());
  };

  const result = await runRound(["decide", "18", "feature", "greptile=dismissed"], value.deps);

  expect(result.stdout).toContain("greptile handback all-dismissed\n");
  expect(calls.filter((call) => !call.startsWith("config"))).toEqual([]);
});

test("PATH stub Greptile and CodeRabbit round", async () => {
  const value = setup("limited");
  const stubs = join(value.temporary, "gh");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "api_graphql.prefix"), response(mixed.limited as PullRequest));
  const result = await runCommand([bin, "--root", value.root, "round", "gate", "18"], {
    cwd: value.temporary,
    env: {
      ...suiteEnvironment(),
      PATH: `${repo}/scripts/stubs:${process.env.PATH}`,
      SKILLS_CONF: value.conf,
      REVIEW_NOW: "2026-09-27T17:11:01Z",
      GH_STUB_DIR: stubs,
    },
    timeout: 30_000,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "coderabbit unavailable rate-limited 2\ngreptile absent\nhandback coderabbit unavailable rate-limited 2\n",
  );
}, 30_000);
