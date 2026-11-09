import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { round } from "../areas/round.ts";
import { fakeReader, failedCheck, pendingCheck } from "../pr/fakes.ts";
import { WatcherQueryError } from "../pr/github.ts";
import type { GitHubReader } from "../pr/types.ts";
import type { Commit, PullRequest } from "./types.ts";
import { clampTimeout, driveUsage, runDrive, type DriveDeps } from "./drive.ts";
import { storedEvents } from "../test/stored-events.ts";
import { failure, fixture, success } from "./fixtures.ts";

const temporaries: string[] = [];

test("round area has no eager drive import", () => {
  const source = readFileSync(join(import.meta.dir, "../areas/round.ts"), "utf8");
  const imports = new Bun.Transpiler({ loader: "ts" }).scanImports(source);

  expect(
    imports.filter((entry) => entry.kind === "import-statement").map((entry) => entry.path),
  ).not.toContain("../round/drive.ts");

  expect(round.verbs[0]!.usage).toBe(driveUsage);
});

test("drive grammar marks optional round detail on every applicable word", () => {
  const grammar = round.verbs[0]!.grammar;
  for (const word of ["handoff", "refused", "triage", "red", "conflict", "wait"])
    expect(grammar.find((line) => line.startsWith(`${word} `))).toStartWith(
      `${word} [<round lines>] `,
    );
});

test("defective declarations return refused on CLI stdout", async () => {
  const value = setup();
  writeFileSync(join(value.root, "a/reviewer.conf"), "malformed\n");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../cli.ts"),
      "--root",
      value.root,
      "round",
      "drive",
      "18",
      "feat/topic",
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(code).toBe(1);
  expect(stdout).toBe(
    `refused\nreviewers: ${join(value.root, "a/reviewer.conf")}: malformed line\n`,
  );

  expect(stderr).toBe("");
});

test("green PR waits when the gate consumes the cap", async () => {
  const value = setup();
  value.deps.env.ROUND_DRIVE_CAP = "30";
  const gh = value.deps.gh;
  value.deps.gh = async (args, timeout) => {
    value.advance(30);
    return gh(args, timeout);
  };

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toBe(
    "wait\na done\nr done\ndone\n#18 green not confirmed before the cap\n",
  );

  expect(value.deps.clock()).toBe(10_030);
  expect(value.sleeps).toEqual([]);
});

test("handoff confirmation never sleeps past the shared deadline", async () => {
  const reader = fakeReader();
  const read = reader.read;
  let reads = 0;
  reader.read = async (context) => {
    const result = await read(context);
    reads++;
    return reads === 2 ? { ...result, checks: [pendingCheck()] } : result;
  };

  const value = setup(reader);
  value.deps.env.ROUND_DRIVE_CAP = "30";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(value.deps.clock()).toBeLessThanOrEqual(10_030);
  expect(result.code).toBe(6);
  expect(value.sleeps).toEqual([]);
});

test("handoff fits an exact thirty second confirmation budget", async () => {
  const value = setup();
  value.deps.env.ROUND_DRIVE_CAP = "30";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(0);
  expect(value.deps.clock()).toBe(10_030);
});

test("head moved after the round waits instead of handing off", async () => {
  const reader = fakeReader();
  const read = reader.read;
  let reads = 0;
  reader.read = async (context) => {
    const result = await read(context);
    reads++;
    return reads === 1
      ? result
      : { ...result, facts: { ...result.facts, headRefOid: "changed123456" } };
  };

  const value = setup(reader);

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toBe("wait\na done\nr done\ndone\n#18 head moved to changed\n");
});

for (const outcomes of [[], ["a=fixed"]])
  test(`round stderr retains a handback reason for ${outcomes.length ? "decide" : "gate"}`, async () => {
    const value = setup();
    value.verdicts.set("a", "invalid verdict");

    const result = await runDrive(["18", "feat/topic", ...outcomes], value.deps);

    expect(result.code).toBe(1);
    expect(result.stdout).toContain("handback a refused\n");
    expect(result.stdout).toContain("round: a: returned an invalid verdict\n");
    expect(result.stderr).toBe("");
  });

for (const stage of ["initial", "green"])
  test(`${stage} retryable unreadable returns wait`, async () => {
    const reader = fakeReader();
    const read = reader.read;
    let reads = 0;
    reader.read = async (context) => {
      reads++;

      if (stage === "initial" || reads > 1)
        throw new WatcherQueryError({ kind: "read-failed", retryable: true, detail: "timed out" });

      return read(context);
    };

    const value = setup(reader);
    value.deps.env.ROUND_DRIVE_CAP = "30";

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result.code).toBe(6);
    expect(result.stdout).toBe(
      `wait\n${stage === "green" ? "a done\nr done\ndone\n" : ""}#18 unreadable timed out\n`,
    );
  });

test("initial retryable unreadable polls every thirty seconds until the cap", async () => {
  const reader = fakeReader();
  let reads = 0;
  reader.read = async () => {
    reads++;
    throw new WatcherQueryError({ kind: "read-failed", retryable: true, detail: "timed out" });
  };

  const value = setup(reader);
  value.deps.env.ROUND_DRIVE_CAP = "100";
  const plans = join(value.temporary, "plans");
  mkdirSync(plans);
  value.deps.env.PLANS_DIR = plans;

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({ code: 6, stdout: "wait\n#18 unreadable timed out\n", stderr: "" });
  expect(reads).toBe(4);
  expect(value.sleeps).toEqual([30, 30, 30]);
  expect(value.calls).toEqual([]);
  expect(storedEvents(plans, "pr")).toEqual([]);
});

test("initial retryable unreadable proceeds once a poll reads", async () => {
  const reader = fakeReader();
  const read = reader.read;
  let reads = 0;
  reader.read = async (context) => {
    reads++;

    if (reads <= 2)
      throw new WatcherQueryError({ kind: "read-failed", retryable: true, detail: "timed out" });

    return read(context);
  };

  const value = setup(reader);
  value.deps.env.ROUND_DRIVE_CAP = "100";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 0,
    stdout: "handoff\na done\nr done\ndone\n#18 green head\n",
    stderr: "",
  });

  expect(reads).toBe(5);
  expect(value.sleeps).toEqual([30, 30, 30]);
});

test("gate rereview without an active trigger returns wait once", async () => {
  const reader = fakeReader();
  const read = reader.read;
  const value = setup(reader);
  value.configure("a");
  value.verdicts.set("r", "rereview below-threshold");
  reader.read = async (context) => {
    value.configure("r");
    return read(context);
  };

  const gh = value.deps.gh;
  let snapshots = 0;
  value.deps.gh = async (args, timeout) => {
    if (++snapshots > 1) throw new Error("gate repeated without a trigger");
    return gh(args, timeout);
  };

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toBe("wait\nr rereview below-threshold\nrereview\n");
  expect(snapshots).toBe(1);
});

for (const [facts, refusal] of [
  [{ state: "MERGED" }, "merged"],
  [{ state: "CLOSED" }, "closed"],
  [{ isDraft: true }, "draft"],
] as const)
  test(`initial ${refusal} is refused before the round`, async () => {
    const value = setup(fakeReader({ facts }));

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result).toEqual({ code: 1, stdout: `refused\n#18 ${refusal}\n`, stderr: "" });
    expect(value.calls).toEqual([]);
  });

test("an initial merged read records its pr event before drive refuses", async () => {
  const value = setup(fakeReader({ facts: { state: "MERGED", mergedAt: "2026-11-07T00:00:00Z" } }));
  const plans = join(value.temporary, "plans");
  mkdirSync(plans);
  value.deps.env.PLANS_DIR = plans;

  expect((await runDrive(["18", "feat/topic"], value.deps)).code).toBe(1);
  expect(storedEvents(plans, "pr").map((event) => event.payload)).toEqual([
    { pr: 18, branch: "feature", state: "merged", head: "head", verdict: null, failing: [] },
  ]);
});

for (const [facts, refusal] of [
  [{ state: "MERGED" }, "merged"],
  [{ state: "CLOSED" }, "closed"],
  [{ isDraft: true }, "draft"],
] as const)
  test(`last green pass supplies ${refusal} without another read`, async () => {
    const reader = fakeReader();
    const finalReader = fakeReader({ facts });
    const read = reader.read;
    let reads = 0;
    reader.read = async (context) => {
      reads++;
      return reads === 1 ? read(context) : finalReader.read(context);
    };

    const value = setup(reader);

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result).toEqual({
      code: 1,
      stdout: `refused\na done\nr done\ndone\n#18 ${refusal}\n`,
      stderr: "",
    });

    expect(reads).toBe(refusal === "closed" ? 2 : 3);
  });

for (const stage of ["initial", "green"])
  test(`${stage} nonretryable unreadable retains its query error`, async () => {
    const reader = fakeReader();
    const read = reader.read;
    let reads = 0;
    reader.read = async (context) => {
      reads++;

      if (stage === "initial" || reads > 1)
        throw new WatcherQueryError({ kind: "read-failed", retryable: false, detail: "denied" });

      return read(context);
    };

    const value = setup(reader);

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result.code).toBe(stage === "initial" ? 1 : 6);
    expect(result.stdout).toBe(
      `${stage === "initial" ? "refused" : "wait"}\n${stage === "green" ? "a done\nr done\ndone\n" : ""}#18 unreadable denied\n`,
    );

    if (stage === "initial") expect(value.sleeps).toEqual([]);
  });

test("green receives only the time left after gate", async () => {
  const value = setup(fakeReader({ checks: [pendingCheck()] }));
  value.deps.env.ROUND_DRIVE_CAP = "33";
  value.verdicts.set("a", "wait check-pending");
  const sleep = value.deps.sleep;
  value.deps.sleep = async (seconds) => {
    await sleep(seconds);
    value.verdicts.set("a", "done");
  };

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toBe(
    "wait\na done\nr done\ndone\n#18 green not confirmed before the cap\n",
  );

  expect(value.sleeps).toEqual([30]);
});

test("review read failure is refused with stderr verbatim", async () => {
  const value = setup();
  value.verdicts.set("a", "triage");
  value.deps.review = async () => failure("  read denied\n\n");

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("refused\na triage\nr done\ntriage\n  read denied\n\n");
});

test("failed rereview post is refused verbatim and never retried", async () => {
  const value = setup();
  value.verdicts.set("a", "rereview below-threshold");
  const gh = value.deps.gh;
  value.deps.gh = async (args, deadline) => {
    const result = await gh(args, deadline);
    return args[0] === "pr" ? failure("  post denied\n\n") : result;
  };

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe(
    "refused\na rereview below-threshold\nr done\nrereview\n  post denied\n\n",
  );

  expect(value.calls.filter((call) => call.args[0] === "pr")).toHaveLength(1);
});

test("round failure preserves stderr and supplied outcomes", async () => {
  const value = setup();

  const result = await runDrive(["18", "feat/topic", "unknown=fixed"], value.deps);

  expect(result.code).toBe(1);
  expect(result.stdout).toStartWith("refused\noutcomes unknown=fixed\nusage: skills round gate");
  expect(result.stderr).toBe("");
});

for (const args of [[], ["18"], ["no", "branch"], ["18", "branch", "a=invalid"]])
  test(`usage exits 2 without a word for ${JSON.stringify(args)}`, async () => {
    const value = setup();

    const result = await runDrive(args, value.deps);

    expect(result).toEqual({ code: 2, stdout: "", stderr: `usage: ${driveUsage}\n` });
    expect(value.calls).toEqual([]);
    expect((value.deps.reader as ReturnType<typeof fakeReader>).calls).toEqual([]);
  });

afterEach(() => {
  for (const temporary of temporaries.splice(0)) rmSync(temporary, { recursive: true });
});

function setup(reader: GitHubReader = fakeReader(), names = ["a", "r"]) {
  const value = fixture(names);
  temporaries.push(value.temporary);

  const sleeps: number[] = [];
  const deps: DriveDeps = {
    ...value.deps,
    gh: async (args, deadline) => {
      const result = await value.deps.gh(args, deadline);
      const data = JSON.parse(result.stdout);
      data.data.repository.pullRequest.commits.nodes.at(-1).commit.oid = "head";

      return { ...result, stdout: JSON.stringify(data) };
    },
    reader,
    watch: {
      now: value.deps.clock,
      sleep: async (seconds) => deps.sleep(seconds),
      observedAt: () => new Date(deps.clock() * 1000).toISOString(),
    },
    sleep: async (seconds) => {
      sleeps.push(seconds);
      value.advance(seconds);
    },
    review: async () => success("review findings\n"),
  };

  return { ...value, deps, sleeps };
}

test("rereview posts each reviewer trigger once and stops on a repeat", async () => {
  const value = setup();
  value.verdicts.set("a", "rereview below-threshold");
  value.verdicts.set("r", "rereview below-threshold");

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toBe(
    "wait\na rereview below-threshold\nr rereview below-threshold\nrereview\na rereview below-threshold\nr rereview below-threshold\nrereview\n",
  );

  expect(value.calls.filter((call) => call.args[0] === "pr")).toEqual([
    { command: "gh", args: ["pr", "comment", "18", "--body", "@a review"], deadline: 30_000 },
    { command: "gh", args: ["pr", "comment", "18", "--body", "@r review"], deadline: 30_000 },
  ]);
});

test("decide triggers rereview then gates and preserves outcomes", async () => {
  const value = setup();
  value.verdicts.set("a", "rereview below-threshold");
  const gh = value.deps.gh;
  value.deps.gh = async (args, deadline) => {
    const result = await gh(args, deadline);
    if (args[0] === "pr") value.verdicts.set("a", "done");
    return result;
  };

  const result = await runDrive(["18", "feat/topic", "critical=true", "a=fixed"], value.deps);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "handoff\na rereview below-threshold\nr done\nrereview\noutcomes a=fixed\na done\nr done\ndone\n#18 green head\n",
  );

  expect(await value.inputs("a")).toEqual([
    { phase: "decide", critical: true, outcome: "fixed" },
    { phase: "gate", critical: true, outcome: null },
  ]);

  expect(value.calls.filter((call) => call.args[0] === "pr")).toHaveLength(1);
});

test("an advisory rereview beside a required done posts no trigger and hands off", async () => {
  const value = setup(fakeReader(), ["r", "s"]);
  value.configure("r s", "S_ROLE=advisory\n");
  value.verdicts.set("r", "done");
  value.verdicts.set("s", "rereview");

  const result = await runDrive(["18", "feat/topic", "r=fixed"], value.deps);

  expect(result).toEqual({
    code: 0,
    stdout: "handoff\nr done\ns rereview\ndone\noutcomes r=fixed\n#18 green head\n",
    stderr: "",
  });

  expect(value.calls.filter((call) => call.args[0] === "pr")).toEqual([]);
});

test("refused exits 1 and retains decide handback and outcomes after green passes", async () => {
  const value = setup();
  value.verdicts.set("a", "handback refused");

  const result = await runDrive(["18", "feat/topic", "a=dismissed"], value.deps);

  expect(result).toEqual({
    code: 1,
    stdout:
      "refused\na handback refused\nr done\nhandback a refused\noutcomes a=dismissed\n#18 green head\n",
    stderr: "",
  });

  expect(value.sleeps).toEqual([30]);
});

test("retryable snapshot read failure waits to the cap without green", async () => {
  const value = setup();
  value.deps.gh = async () =>
    failure("gh: HTTP 502: Bad Gateway (https://api.github.com/graphql)\n");

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toStartWith("wait\na wait unreadable\nr wait unreadable\nwait\n");
  expect(result.stdout).toContain("round: gh: HTTP 502: Bad Gateway");
  expect(result.stdout).not.toContain("#18 green");
  expect(value.sleeps.reduce((sum, seconds) => sum + seconds, 0)).toBe(570);
});

test("permanent snapshot read failure is refused without green", async () => {
  const value = setup();
  value.deps.gh = async () => ({
    code: 1,
    stdout: JSON.stringify({
      data: { repository: { pullRequest: null } },
      errors: [
        { type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 18." },
      ],
    }),
    stderr: "gh: Could not resolve to a PullRequest with the number of 18.\n",
  });

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 1,
    stdout:
      "refused\nround: not found: gh: Could not resolve to a PullRequest with the number of 18.\n",
    stderr: "",
  });
});

test("red exits 4 with failing check names and links after the round", async () => {
  const value = setup(
    fakeReader({ checks: [{ ...failedCheck("build"), link: "https://ci.test/build" }] }),
  );

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 4,
    stdout: "red\na done\nr done\ndone\n#18 failing build https://ci.test/build\n",
    stderr: "",
  });

  expect(value.sleeps).toEqual([]);
});

test("conflict exits 5 before the round when there are no outcomes", async () => {
  const value = setup(
    fakeReader({ facts: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } }),
  );

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 5,
    stdout: "conflict\n#18 conflicts with main CONFLICTING DIRTY\n",
    stderr: "",
  });

  expect(value.calls).toEqual([]);
});

test("outcomes preserve an initial conflict before decide or triggers", async () => {
  const value = setup(
    fakeReader({ facts: { mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" } }),
  );

  const result = await runDrive(["18", "feat/topic", "a=fixed"], value.deps);

  expect(result.code).toBe(5);
  expect(result.stdout).toBe(
    "conflict\n#18 conflicts with main CONFLICTING DIRTY\noutcomes a=fixed\n",
  );

  expect(value.calls).toEqual([]);
});

test("handoff exits 0 after gate waits, reads done and confirms green", async () => {
  const value = setup();
  value.verdicts.set("a", "wait check-pending");
  const sleep = value.deps.sleep;
  value.deps.sleep = async (seconds) => {
    await sleep(seconds);
    value.verdicts.set("a", "done");
  };

  const result = await runDrive(["18", "feat/topic", "critical=true"], value.deps);

  expect(result).toEqual({
    code: 0,
    stdout: "handoff\na done\nr done\ndone\n#18 green head\n",
    stderr: "",
  });

  expect(value.sleeps).toEqual([30, 30]);
  expect(await value.inputs("a")).toEqual([
    { phase: "gate", critical: true, outcome: null },
    { phase: "gate", critical: true, outcome: null },
  ]);
});

for (const [facts, notices] of [
  [{ autoMerge: "SQUASH" }, "#18 auto-merge armed SQUASH\n"],
  [{ queued: true }, "#18 in merge queue\n"],
  [{ autoMerge: "SQUASH", queued: true }, "#18 auto-merge armed SQUASH\n#18 in merge queue\n"],
] as const)
  test(`handoff reports ${notices.trim().replaceAll("\n", " and ")} after the round`, async () => {
    const value = setup(fakeReader({ facts }));

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result).toEqual({
      code: 0,
      stdout: `handoff\na done\nr done\ndone\n${notices}#18 green head\n`,
      stderr: "",
    });
  });

test("an armed draft is refused with the armed line before its refusal", async () => {
  const value = setup(fakeReader({ facts: { isDraft: true, autoMerge: "SQUASH" } }));

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 1,
    stdout: "refused\n#18 auto-merge armed SQUASH\n#18 draft\n",
    stderr: "",
  });
});

test("a round only wait keeps its last line when auto-merge is armed", async () => {
  const value = setup(fakeReader({ facts: { autoMerge: "REBASE" } }));
  value.verdicts.set("a", "wait check-pending");
  value.deps.env.ROUND_DRIVE_CAP = "3";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toEndWith("\n#18 auto-merge armed REBASE\nwait\n");
});

test("the notices follow the latest read, not the first", async () => {
  const reader = fakeReader();
  const read = reader.read;
  let reads = 0;
  reader.read = async (context) => {
    const result = await read(context);
    return reads++ ? { ...result, facts: { ...result.facts, queued: true } } : result;
  };

  const value = setup(reader);

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.stdout).toBe("handoff\na done\nr done\ndone\n#18 in merge queue\n#18 green head\n");
});

test("a failed final poll keeps the last successful pass's notices", async () => {
  const reader = fakeReader({ facts: { queued: true } });
  const read = reader.read;
  let reads = 0;
  reader.read = async (context) => {
    const result = await read(context);
    reads++;

    if (reads === 2)
      return { ...result, checks: [pendingCheck()], facts: { ...result.facts, queued: false } };

    if (reads > 2)
      throw new WatcherQueryError({ kind: "read-failed", retryable: true, detail: "down" });

    return result;
  };

  const value = setup(reader);
  value.deps.env.ROUND_DRIVE_CAP = "100";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).not.toContain("in merge queue");
});

test("an unmet merge rule waits with exit 6 in place of a handoff", async () => {
  const value = setup(fakeReader({ facts: { mergeStateStatus: "BLOCKED", reviewDecision: null } }));

  value.deps.env.ROUND_DRIVE_CAP = "90";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 6,
    stdout: "wait\na done\nr done\ndone\n#18 rule unmet SUCCESS\n",
    stderr: "",
  });
});

test("wait exits 6 with a three second cap over a pending check", async () => {
  const value = setup(fakeReader({ checks: [pendingCheck("build")] }));
  value.deps.env.ROUND_DRIVE_CAP = "3";

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 6,
    stdout: "wait\na done\nr done\ndone\n#18 green not confirmed before the cap\n",
    stderr: "",
  });

  expect(value.sleeps).toEqual([]);
});

test("gate shares the cap and returns wait without another poll loop", async () => {
  const value = setup();
  value.deps.env.ROUND_DRIVE_CAP = "3";
  value.verdicts.set("a", "wait check-pending");

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(6);
  expect(result.stdout).toBe("wait\na wait check-pending\nr done\nwait\n");
  expect(value.sleeps).toEqual([3]);
});

for (const cap of [undefined, "", "0", "-1", "1.5", "invalid"])
  test(`cap ${String(cap)} uses the 570 second default`, async () => {
    const value = setup();
    value.deps.env.ROUND_DRIVE_CAP = cap;
    value.verdicts.set("a", "wait check-pending");

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result.code).toBe(6);
    expect(result.stdout.split("\n")[0]).toBe("wait");
    expect(value.deps.clock()).toBe(10_570);
    expect(value.sleeps).toEqual(Array.from({ length: 19 }, () => 30));
    expect(driveUsage).toContain("default 570");
  });

test("triage exits 3 and appends CI failures and review stdout verbatim", async () => {
  const value = setup(
    fakeReader({ checks: [{ ...failedCheck("build"), link: "https://ci.test/build" }] }),
  );

  value.verdicts.set("a", "triage");
  const review = "  unresolved finding\n\nexact trailing text";
  const reviewed: string[] = [];
  value.deps.review = async (pr) => {
    reviewed.push(pr);
    return success(review);
  };

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 3,
    stdout: `triage\na triage\nr done\ntriage\n#18 failing build https://ci.test/build\n${review}`,
    stderr: "",
  });

  expect(reviewed).toEqual(["18"]);
});

test("triage reports a check that failed while the gate waited", async () => {
  const passing = fakeReader();
  const failing = fakeReader({
    checks: [{ ...failedCheck("build"), link: "https://ci.test/build" }],
  });

  let reads = 0;
  const value = setup({
    ...passing,
    read: (context) => (reads++ ? failing : passing).read(context),
  });

  value.verdicts.set("a", "triage");

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(3);
  expect(result.stdout).toBe(
    "triage\na triage\nr done\ntriage\n#18 failing build https://ci.test/build\nreview findings\n",
  );
});

test("every read is bounded to a hard stop 25 seconds past the cap", async () => {
  const value = setup();
  const stops: number[] = [];
  value.deps.bound = (stop) => stops.push(stop);

  await runDrive(["18", "feat/topic"], value.deps);

  expect(stops).toEqual([10_000 + 570 + 25]);
  expect(clampTimeout(60_000, 10_595, 10_000)).toBe(60_000);
  expect(clampTimeout(60_000, 10_595, 10_580)).toBe(15_000);
  expect(clampTimeout(30_000, 10_595, 10_600)).toBe(1000);
});

for (const [decision, ending, code] of [
  ["CHANGES_REQUESTED", "#18 green head\n#18 changes requested\n", 1],
  ["REVIEW_REQUIRED", "#18 green head\n#18 approval required\n", 1],
  ["APPROVED", "#18 green head\n", 0],
  [null, "#18 green head\n", 0],
] as const)
  test(`a green done round with review decision ${decision} ends ${ending.split("\n")[1] || "in handoff"}`, async () => {
    const value = setup(fakeReader({ facts: { reviewDecision: decision } }));
    decided(value, decision);

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result.code).toBe(code);
    expect(result.stdout).toStartWith(code ? "refused\n" : "handoff\n");
    expect(result.stdout).toEndWith(`done\n${ending}`);
  });

function decided(value: ReturnType<typeof setup>, decision: PullRequest["reviewDecision"]) {
  const gh = value.deps.gh;
  value.deps.gh = async (args, deadline) => {
    const result = await gh(args, deadline);
    const data = JSON.parse(result.stdout);
    data.data.repository.pullRequest.reviewDecision = decision;

    return success(JSON.stringify(data));
  };
}

for (const [decision, ending] of [
  ["REVIEW_REQUIRED", "#18 approval required\n"],
  ["CHANGES_REQUESTED", "#18 changes requested\n"],
] as const)
  test(`a decision that turns ${decision} after green is read fresh`, async () => {
    const value = setup(fakeReader({ facts: { reviewDecision: "APPROVED" } }));
    decided(value, decision);

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result.code).toBe(1);
    expect(result.stdout).toEndWith(`#18 green head\n${ending}`);
  });

type Activity = { login: string; at: string; review?: string; bot?: boolean };

function humanPr(
  value: ReturnType<typeof setup>,
  activity: Activity,
  suites = true,
  change: (
    data: { viewer?: { login: string } },
    commit: Commit,
    pr: PullRequest,
  ) => void = () => {},
) {
  const gh = value.deps.gh;
  value.deps.gh = async (args, deadline) => {
    const result = await gh(args, deadline);
    const data = JSON.parse(result.stdout);
    const pr: PullRequest = data.data.repository.pullRequest;
    const commit = pr.commits.nodes.at(-1)!.commit;
    const author = activity.bot
      ? { __typename: "Bot", login: activity.login }
      : { login: activity.login };

    pr.author = { login: "ryuu" };
    commit.committedDate = "2026-11-09T09:50:00Z";
    commit.checkSuites.nodes = suites ? [{ createdAt: "2026-11-09T10:00:00Z" }] : [];

    if (activity.review)
      pr.reviews.nodes.push({
        author,
        state: activity.review,
        body: "",
        submittedAt: activity.at,
        commit: null,
      });
    else
      pr.comments.nodes.push({
        author,
        body: "hm",
        createdAt: activity.at,
      });

    change(data.data, commit, pr);
    return success(JSON.stringify(data));
  };
}

for (const [activity, ending, suites] of [
  [{ login: "sam", at: "2026-11-09T10:05:00Z" }, "#18 human sam commented\n", true],
  [
    { login: "sam", at: "2026-11-09T10:05:00Z", review: "COMMENTED" },
    "#18 human sam reviewed\n",
    true,
  ],
  [
    { login: "sam", at: "2026-11-09T10:05:00Z", review: "CHANGES_REQUESTED" },
    "#18 human sam reviewed\n",
    true,
  ],
  [{ login: "sam", at: "2026-11-09T09:59:00Z" }, null, true],
  [{ login: "ryuu", at: "2026-11-09T10:05:00Z" }, null, true],
  [{ login: "greptile-apps[bot]", at: "2026-11-09T10:05:00Z" }, null, true],
  [{ login: "codecov", at: "2026-11-09T10:05:00Z", bot: true }, null, true],
  [{ login: "sam", at: "2026-11-09T10:05:00Z", review: "APPROVED" }, null, true],
  [{ login: "sam", at: "2026-11-09T10:05:00Z", review: "DISMISSED" }, null, true],
  [{ login: "sam", at: "2026-11-09T09:55:00Z" }, "#18 human sam commented\n", false],
] as const)
  test(`${activity.login} ${activity.review ?? "comment"} at ${activity.at.slice(11, 16)}${suites ? "" : " with no check suite"} ${ending ? `ends ${ending.trim()}` : "leaves handoff"}`, async () => {
    const value = setup(fakeReader({ facts: { reviewDecision: null } }), ["a", "r", "greptile"]);
    value.configure("a r");
    humanPr(value, activity, suites);

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result.code).toBe(ending ? 1 : 0);
    expect(result.stdout).toBe(
      `${ending ? "refused" : "handoff"}\na done\nr done\ndone\n#18 green head\n${ending ?? ""}`,
    );
  });

test("the operator's own comment on a teammate's PR leaves handoff", async () => {
  const value = setup(fakeReader({ facts: { reviewDecision: null } }));
  humanPr(value, { login: "lee", at: "2026-11-09T10:05:00Z" }, true, (data) => {
    data.viewer = { login: "lee" };
  });

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("handoff\na done\nr done\ndone\n#18 green head\n");
});

test("a head that moves after green waits instead of reading activity on it", async () => {
  const value = setup(fakeReader({ facts: { reviewDecision: "REVIEW_REQUIRED" } }));
  humanPr(value, { login: "sam", at: "2026-11-09T09:59:00Z" }, true, (_, commit) => {
    commit.oid = "fresh123456";
  });

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result).toEqual({
    code: 6,
    stdout: "wait\na done\nr done\ndone\n#18 head moved to fresh12\n",
    stderr: "",
  });
});

test("a changes requested decision stops without reading the PR again", async () => {
  const value = setup(fakeReader({ facts: { reviewDecision: "CHANGES_REQUESTED" } }));
  await runDrive(["18", "feat/topic"], value.deps);
  expect(value.calls.filter((call) => call.args[0] === "api")).toHaveLength(1);
});

for (const [read, line] of [
  [failure("HTTP 502: Bad Gateway"), "HTTP 502: Bad Gateway"],
  [success("not json"), "cannot parse PR snapshot"],
] as const)
  test(`a hold read that fails with ${line} waits`, async () => {
    const reader = fakeReader({ facts: { reviewDecision: null } });
    const value = setup({ ...reader, read: async (context) => (reads++, reader.read(context)) });
    let reads = 0;
    const gh = value.deps.gh;
    value.deps.gh = async (args, deadline) => (reads >= 3 ? read : gh(args, deadline));

    const result = await runDrive(["18", "feat/topic"], value.deps);

    expect(result).toEqual({
      code: 6,
      stdout: `wait\na done\nr done\ndone\n#18 unreadable ${line}\n`,
      stderr: "",
    });
  });

test("the newest of several human activities names the stop, a pending review aside", async () => {
  const value = setup(fakeReader({ facts: { reviewDecision: null } }));
  humanPr(value, { login: "sam", at: "2026-11-09T10:05:00Z" }, true, (_, __, pr) => {
    pr.reviews.nodes.push(
      {
        author: { login: "kim" },
        state: "COMMENTED",
        body: "",
        submittedAt: "2026-11-09T10:07:00Z",
        commit: null,
      },
      { author: { login: "lee" }, state: "PENDING", body: "", submittedAt: null, commit: null },
    );

    pr.comments.nodes.push({
      author: { login: "max" },
      body: "hm",
      createdAt: "2026-11-09T10:06:00Z",
    });
  });

  const result = await runDrive(["18", "feat/topic"], value.deps);

  expect(result.code).toBe(1);
  expect(result.stdout).toEndWith("#18 green head\n#18 human kim reviewed\n");
});
