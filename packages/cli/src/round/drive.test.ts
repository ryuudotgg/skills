import { afterEach, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { round } from "../areas/round.ts";
import { fakeReader, failedCheck, pendingCheck } from "../pr/fakes.ts";
import { WatcherQueryError } from "../pr/github.ts";
import type { GitHubReader } from "../pr/types.ts";
import { clampTimeout, driveUsage, runDrive, type DriveDeps } from "./drive.ts";
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

function setup(reader: GitHubReader = fakeReader()) {
  const value = fixture(["a", "r"]);
  temporaries.push(value.temporary);

  const sleeps: number[] = [];
  const deps: DriveDeps = {
    ...value.deps,
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
