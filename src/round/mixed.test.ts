import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  const value = fixture(["coderabbit", "greptile"], ["greptile"]);
  temporary.push(value.temporary);
  cpSync(
    join(repo, "skills/coderabbit/reviewer.conf"),
    join(value.root, "coderabbit/reviewer.conf"),
  );

  value.responses.set("coderabbit", success("done clean\n"));
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

test("pending gate; pending gate did not sleep once; check state reads differ for 2 passes", async () => {
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
  expect(value.calls.filter((entry) => entry.command === "sh" && entry.args[1] === join(value.root, "coderabbit/scripts/verdict.sh"))).toHaveLength(2);
});

test("limited handback; limited handback slept; score reads differ for 1 passes", async () => {
  const value = setup("limited");
  value.deps.env.REVIEW_NOW = "2026-09-27T17:11:01Z";
  value.responses.set("coderabbit", success("unavailable rate-limited 2\n"));
  value.deps.sleep = async () => {
    throw new Error("limited handback slept");
  };

  const result = await runRound(["gate", "18", "--wait"], value.deps);

  expect(result.stdout).toBe(
    "coderabbit unavailable rate-limited 2\ngreptile absent\nhandback coderabbit unavailable rate-limited 2\n",
  );

  expect(value.reads()).toBe(1);
  expect(value.calls.filter((entry) => entry.command === "sh" && entry.args[1] === join(value.root, "coderabbit/scripts/verdict.sh"))).toHaveLength(1);
});

for (const [next, expected] of [
  ["decide-expired", "rereview below-threshold"],
  ["decide-pending", "wait check-pending"],
  ["decide-completed", "triage scored"],
] as const)
  test(`decide ${next.slice(7)}; decide did not sleep once; rereview safety`, async () => {
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
    expect(value.calls.filter((entry) => entry.command === "sh" && entry.args[1] === join(value.root, "coderabbit/scripts/verdict.sh"))).toHaveLength(2);
  });

test("first decide pass; first decide pass did not sleep once; CodeRabbit state reads differ for 1 passes", async () => {
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
  expect(value.calls.filter((entry) => entry.command === "sh" && entry.args[1] === join(value.root, "coderabbit/scripts/verdict.sh"))).toHaveLength(1);
});

for (const [outcome, expected] of [
  ["fixed", "rereview below-threshold"],
  ["dismissed", "handback all-dismissed"],
] as const)
  test(`${outcome} outcome did not read fix facts; dismissed outcome counted another fix`, async () => {
    const value = setup("decide-expired");
    const result = await runRound(["decide", "18", "feature", `greptile=${outcome}`], value.deps);

    expect(result.stdout).toContain(`greptile ${expected}\n`);
    expect(
      value.calls.filter((entry) => entry.command === "git" && entry.args[0] === "log"),
    ).toHaveLength(2);
  });

test("review of the fixed tip was not triaged; fixed equal tip skips fixes", async () => {
  const value = setup("gate-completed");
  const result = await runRound(["decide", "18", "feature", "greptile=fixed"], value.deps);

  expect(result.stdout).toBe("coderabbit done clean\ngreptile triage scored\ntriage\n");
  expect(
    value.calls.filter((entry) => entry.command === "git" && entry.args[0] === "log"),
  ).toHaveLength(0);
});

test("fixed and dismissed refuse when fix reads fail", async () => {
  for (const outcome of ["fixed", "dismissed"]) {
    const value = setup("decide-expired");
    const git = value.deps.git;
    value.deps.git = (args, deadline) =>
      args[0] === "show-ref" ? Promise.resolve(failure()) : git(args, deadline);

    const result = await runRound(["decide", "18", "feature", `greptile=${outcome}`], value.deps);

    expect(result.stdout).toContain("greptile handback refused\n");
    expect(result.stderr).toContain("branch is not a local branch");
  }
});

test("PATH stub mixed Greptile and real CodeRabbit wrapper", async () => {
  const value = setup("limited");
  cpSync(join(repo, "skills/coderabbit/scripts"), join(value.root, "coderabbit/scripts"), {
    recursive: true,
  });

  mkdirSync(join(value.root, "playbook/scripts"), { recursive: true });
  mkdirSync(join(value.root, "playbook/bin"), { recursive: true });

  for (const name of [
    "reviewers.sh",
    "delivery-mode.sh",
    "extension-verdict.sh",
    "check-state.sh",
    "check-state.graphql",
  ])
    cpSync(join(repo, "skills/playbook/scripts", name), join(value.root, "playbook/scripts", name));

  symlinkSync(bin, join(value.root, "playbook/bin/skills"));

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
