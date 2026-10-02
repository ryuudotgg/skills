import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { facts } from "../../skills/greptile/reviewer.ts";
import { readDeclarations } from "../reviewers/declaration.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import {
  acceptanceCases,
  bin,
  failure,
  fixture,
  now,
  repo,
  response,
  reviewerInput,
  success,
} from "./fixtures.ts";
import { limits } from "./presence.ts";
import { dependencies, parseRound, roundUsage, runRound, validVerdict } from "./round.ts";
import { readSnapshot } from "./snapshot.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(names: string[] = ["a", "r", "s"], ported: string[] = names) {
  const value = fixture(names, ported);
  temporary.push(value.temporary);
  return value;
}

for (const [first, second, combined, reverse] of [
  ["done", "unavailable rate-limited", "done", "done"],
  [
    "absent",
    "unavailable rate-limited",
    "handback s unavailable rate-limited",
    "handback r unavailable rate-limited",
  ],
  ["absent", "absent", "done", "done"],
  ["triage", "unavailable skipped", "triage", "triage"],
  ["triage", "wait", "wait", "wait"],
  [
    "handback paid-cap",
    "handback round-cap",
    "handback r paid-cap, s round-cap",
    "handback r round-cap, s paid-cap",
  ],
])
  test(`check_pair ${first} / ${second}, both orders`, async () => {
    const value = setup(["r", "s"]);
    for (const [left, right, expected] of [
      [first, second, combined],
      [second, first, reverse],
    ]) {
      value.verdicts.set("r", left!);
      value.verdicts.set("s", right!);

      expect((await runRound(["gate", "18"], value.deps)).stdout).toBe(
        `r ${left}\ns ${right}\n${expected}\n`,
      );
    }

    expect(value.calls.filter((entry) => entry.command === "gh")).toHaveLength(2);
  });

test("a did not receive critical; r did not receive critical; wait reached a reviewer", async () => {
  const value = setup(["a", "r"]);

  expect((await runRound(["gate", "18", "--wait", "critical=true"], value.deps)).stdout).toBe(
    "a done\nr done\ndone\n",
  );

  expect(await value.inputs("a")).toEqual([{ phase: "gate", critical: true, outcome: null }]);
  expect(await value.inputs("r")).toEqual([{ phase: "gate", critical: true, outcome: null }]);
});

test("decide gained an outcome; outcome did not reach reviewer; outcome reached another reviewer", async () => {
  const value = setup(["a", "r"]);
  value.verdicts.set("a", "wait");

  expect((await runRound(["decide", "18", "feat/topic", "critical=true"], value.deps)).stdout).toBe(
    "a wait\nr done\nwait\n",
  );

  expect(await value.inputs("a")).toEqual([{ phase: "decide", critical: true, outcome: null }]);
  value.calls.length = 0;
  await runRound(["decide", "18", "feat/topic", "r=dismissed"], value.deps);

  expect((await value.inputs("a")).at(-1)).toEqual({
    phase: "decide",
    critical: false,
    outcome: null,
  });

  expect((await value.inputs("r")).at(-1)).toEqual({
    phase: "decide",
    critical: false,
    outcome: "dismissed",
  });
});

test("inactive outcome was accepted; missing branch was accepted", async () => {
  const value = setup(["a", "r"]);
  for (const args of [
    ["decide", "18", "feat/topic", "s=fixed"],
    ["decide", "18", "r=fixed"],
  ]) {
    const result = await runRound(args, value.deps);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  }
});

for (const output of [
  "broken verdict\n",
  "unavailable\n",
  "handback\n",
  "done\nmore\n",
  "done\r\n",
  "done \n",
  "done\n\n",
])
  test(`invalid reviewer verdict ${JSON.stringify(output)}`, async () => {
    const value = setup(["a", "r"]);
    value.verdicts.set("a", "wait");
    value.verdicts.set("r", output.replace(/\n$/, ""));

    expect((await runRound(["gate", "18"], value.deps)).stdout).toBe(
      "a wait\nr handback refused\nhandback r refused\n",
    );

    expect(validVerdict(output.replace(/\n$/, ""))).toBe(false);
  });

test("reviewer failure is refused and its error reported", async () => {
  const value = setup(["r"]);
  writeFileSync(
    join(value.root, "r/reviewer.ts"),
    'export const facts = () => { throw new Error("provider failed"); };',
  );

  expect(await runRound(["gate", "18"], value.deps)).toEqual({
    code: 0,
    stdout: "r handback refused\nhandback r refused\n",
    stderr: "round: provider failed\n",
  });
});

test("missing reviewer has a note", async () => {
  const value = setup(["r"], []);

  expect(await runRound(["gate", "18"], value.deps)).toEqual({
    code: 0,
    stdout: "r handback refused\nhandback r refused\n",
    stderr: "round: r has no reviewer.ts\n",
  });
});

for (const [phase, first, next, wait, expectedSleeps] of [
  ["gate", "wait check-pending", "done", true, 1],
  ["gate", "wait check-pending", "done", false, 0],
  ["decide", "wait check-pending", "done", false, 0],
  ["decide", "wait check-appear", "rereview below-threshold", false, 1],
] as const)
  test(`${phase} ${first}: waiting gate did not sleep once; plain gate slept; decide slept on pending; decide did not sleep once on appear`, async () => {
    const value = setup(["a", "r"]);
    const sleeps: number[] = [];
    value.verdicts.set("a", first);
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(seconds);
      value.verdicts.set("a", next);
    };

    const args =
      phase === "gate"
        ? [phase, "18", ...(wait ? ["--wait"] : []), "critical=true"]
        : [phase, "18", "feat/topic", "a=fixed", "critical=true"];

    const result = await runRound(args, value.deps);

    expect(sleeps).toHaveLength(expectedSleeps);
    expect(result.stdout).toBe(
      `a ${expectedSleeps ? next : first}\nr done\n${expectedSleeps ? next.split(" ")[0] : "wait"}\n`,
    );

    expect(await value.inputs("a")).toEqual(
      Array.from({ length: expectedSleeps + 1 }, () => ({
        phase,
        critical: true,
        outcome: phase === "decide" ? "fixed" : null,
      })),
    );
  });

for (const poll of [undefined, "", "bad", "0", "01", "-1", "17", "99999"])
  test(`deadline did not sleep once; deadline read another pass; ROUND_POLL=${poll}`, async () => {
    const value = setup(["a", "r"]);
    value.deps.env.ROUND_POLL = poll;
    value.verdicts.set("a", "wait check-appear");
    const sleeps: number[] = [];
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(limits.window + limits.cap);
      value.verdicts.set("a", "done");
    };

    expect((await runRound(["decide", "18", "feat/topic"], value.deps)).stdout).toBe(
      "a wait check-appear\nr done\nwait\n",
    );

    expect(sleeps).toEqual([poll === "17" ? 17 : poll === "99999" ? 1260 : 30]);
    expect(value.calls.filter((entry) => entry.command === "gh")).toHaveLength(1);
  });

for (const poll of ["7", "0", "soon", ""])
  test(`poll [${poll}] slept, expected ${poll === "7" ? 7 : 30}`, async () => {
    const value = setup(["a", "r"]);
    const sleeps: number[] = [];
    value.deps.env.ROUND_POLL = poll;
    value.verdicts.set("a", "wait check-pending");
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(seconds);
      value.verdicts.set("a", "done");
    };

    expect((await runRound(["gate", "18", "--wait"], value.deps)).stdout).toBe(
      "a done\nr done\ndone\n",
    );

    expect(sleeps).toEqual([poll === "7" ? 7 : 30]);
  });

test("empty round called gh; delivery notes suppressed; empty outcomes refuse", async () => {
  const value = setup(["greptile"], ["greptile"]);
  value.configure("");

  expect(await runRound(["decide", "18", "topic", "missing=fixed"], value.deps)).toEqual({
    code: 2,
    stdout: "",
    stderr: `${roundUsage}\n`,
  });

  expect(await runRound(["decide", "18", "topic"], value.deps)).toEqual({
    code: 0,
    stdout: "done\n",
    stderr: "",
  });

  expect(value.calls).toHaveLength(0);
  writeFileSync(value.conf, "DELIVERY=hands-off\nWITH=greptile missing\n");

  expect(await runRound(["gate", "18"], value.deps)).toEqual({
    code: 0,
    stdout: "done\n",
    stderr: "",
  });
});

for (const active of [true, false])
  test(`malformed declaration was accepted, active=${active}`, async () => {
    const value = setup(["r"]);
    if (!active) value.configure("");

    const path = join(value.root, "r/reviewer.conf");
    writeFileSync(path, readFileSync(path, "utf8") + "malformed\n");
    const result = await runRound(["gate", "18"], value.deps);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("reviewers:");
    expect(result.stderr).toEndWith("round: cannot read active reviewers\n");
  });

test("uncaught round error preserves collected stderr before refusal", async () => {
  const value = setup(["r"]);
  const emitted: string[] = [];
  const gh = value.deps.gh;
  value.deps.stderr = (text) => {
    emitted.push(text);
  };

  value.verdicts.set("r", "wait check-appear");
  value.deps.gh = async (args, deadline) => ({
    ...(await gh(args, deadline)),
    stderr: "provider note\n",
  });

  value.deps.sleep = async () => {
    throw new Error("sleep failed");
  };

  const result = await runRound(["decide", "18", "topic"], value.deps);

  expect(result).toEqual({
    code: 1,
    stdout: "",
    stderr: "round: provider note\nround: sleep failed\n",
  });

  expect(emitted).toEqual(["round: provider note\n", "round: sleep failed\n"]);
});

for (const verb of ["round gate 18", "settings greptile"])
  test(`wrapper writes notes before stdout: ${verb}`, async () => {
    const value = setup(["greptile"], ["greptile"]);
    writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=bad\n");
    const stubs = join(value.temporary, "gh");
    mkdirSync(stubs);
    writeFileSync(
      join(stubs, "api_graphql.prefix"),
      response(acceptanceCases.find((entry) => entry.name === "absent")!.pr),
    );

    const result = await runCommand(
      ["sh", "-c", '"$@" 2>&1', "sh", bin, "--root", value.root, ...verb.split(" ")],
      {
        cwd: value.temporary,
        env: {
          ...suiteEnvironment(),
          PATH: `${repo}/scripts/stubs:${process.env.PATH}`,
          SKILLS_CONF: value.conf,
          REVIEW_NOW: now,
          GH_STUB_DIR: stubs,
          GH_STUB_LOG: join(value.temporary, "gh.log"),
        },
        timeout: 30_000,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toBe(
      `settings: ${value.conf}: GREPTILE_REREVIEWS=bad is not valid, skipped\n${verb.startsWith("round") ? "greptile absent\ndone\n" : "rereviews=2\nthreshold=4\ncritical-threshold=5\nauto=yes\n"}`,
    );
  }, 30_000);

for (const args of [
  [],
  ["wrong", "18"],
  ["gate", "x"],
  ["gate", "18", "--wait", "--wait"],
  ["gate", "18", "r=fixed"],
  ["decide", "18", "topic", "--wait"],
  ["decide", "18", "topic", "r=fixed", "r=dismissed"],
  ["gate", "18", "critical=false"],
])
  test(`round grammar ${args.join(" ")}`, () => {
    expect(() => parseRound(args)).toThrow();
  });

test("snapshot completes before reviewers run and outputs reviewer order", async () => {
  const value = setup(["a", "testbot"]);
  let release: (result: ReturnType<typeof success>) => void = () => {};
  let started: () => void = () => {};
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });

  value.deps.gh = () => {
    started();
    return new Promise((resolve) => {
      release = resolve;
    });
  };

  const running = runRound(["gate", "18"], value.deps);
  await reading;

  expect(await value.inputs("a")).toEqual([]);
  expect(await value.inputs("testbot")).toEqual([]);
  release(success(response(acceptanceCases[0]!.pr)));

  expect((await running).stdout).toBe("a done\ntestbot done\ndone\n");
});

for (const broken of [failure("offline\n"), success("bad json"), success('{"data":null}')])
  test(`shared reader refuses all ported reviewers: ${broken.stdout || broken.stderr}`, async () => {
    const value = setup(["a", "greptile", "testbot"]);
    value.deps.gh = async () => broken;
    const result = await runRound(["gate", "18"], value.deps);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "a handback refused\ngreptile handback refused\ntestbot handback refused\nhandback a refused, greptile refused, testbot refused\n",
    );

    expect(result.stderr).toStartWith("round: ");
  });

test("gh deadline rejection becomes a reviewer refusal", async () => {
  const value = setup(["testbot"], ["testbot"]);
  value.deps.gh = async () => {
    throw new Error("read deadline");
  };

  expect(await runRound(["gate", "18"], value.deps)).toEqual({
    code: 0,
    stdout: "testbot handback refused\nhandback testbot refused\n",
    stderr: "round: read deadline\n",
  });
});

for (const source of [
  'export const facts = () => ({ fixesFrom: null }); export const decide = () => "handback";',
  'export const facts = () => ({ fixesFrom: null }); export const decide = () => "done\\nmore";',
  "export const broken = ;",
])
  test(`reviewer import and vocabulary refusal ${source}`, async () => {
    const value = setup(["testbot"], ["testbot"]);
    writeFileSync(join(value.root, "testbot/reviewer.ts"), source);

    expect((await runRound(["gate", "18"], value.deps)).stdout).toBe(
      "testbot handback refused\nhandback testbot refused\n",
    );
  });

test("one snapshot per pass, no REST trigger read, settings notes once", async () => {
  const value = setup(["testbot", "thirdbot"], ["testbot", "thirdbot"]);
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=testbot thirdbot\nTHIRDBOT_BUDGET=wrong\n");
  writeFileSync(
    join(value.root, "testbot/reviewer.ts"),
    'let passes = 0; export const facts = () => ({ fixesFrom: null }); export const decide = () => ++passes === 1 ? "wait check-appear" : "done";',
  );

  const result = await runRound(["decide", "18", "topic"], value.deps);

  expect(result.stdout).toBe("testbot done\nthirdbot done\ndone\n");
  expect(result.stderr.match(/THIRDBOT_BUDGET=wrong/g)).toHaveLength(1);
  expect(value.calls.filter((entry) => entry.command === "git")).toHaveLength(1);
  expect(value.calls.filter((entry) => entry.command === "gh")).toHaveLength(2);
  expect(
    value.calls
      .filter((entry) => entry.command === "gh")
      .every((entry) => entry.deadline === 60_000 && entry.args.includes("graphql")),
  ).toBe(true);
});

test("acceptance 2: declared @greptile-test counts paid, @greptileai does not", async () => {
  const value = setup(["greptile"], ["greptile"]);
  const path = join(value.root, "greptile/reviewer.conf");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace("TRIGGER=@greptileai", "TRIGGER=@greptile-test"),
  );

  for (const [body, paid] of [
    [" \t@greptile-test\n", 1],
    ["@greptileai", 0],
  ] as const) {
    const pr = structuredClone(acceptanceCases[0]!.pr);
    pr.comments.nodes = [{ author: { login: "developer" }, body, createdAt: now }];
    value.deps.gh = async () => success(response(pr));
    const snapshot = await readSnapshot("18", value.deps.gh, () => {});

    expect(
      facts(reviewerInput(pr, { snapshot, declaration: readDeclarations(value.root)[0]!, now }))
        .paid,
    ).toBe(paid);
  }
});

for (const phase of ["gate", "decide"] as const)
  test(`PATH stub wrapper end to end round ${phase}`, async () => {
    const value = setup(["greptile"], ["greptile"]);
    const stubs = join(value.temporary, "gh");
    const log = join(value.temporary, "gh.log");
    mkdirSync(stubs);
    writeFileSync(
      join(stubs, "api_graphql.prefix"),
      response(acceptanceCases.find((entry) => entry.name === "absent")!.pr),
    );

    const result = await runCommand(
      [bin, "--root", value.root, "round", phase, "18", ...(phase === "decide" ? ["topic"] : [])],
      {
        cwd: value.temporary,
        env: {
          ...suiteEnvironment(),
          PATH: `${repo}/scripts/stubs:${process.env.PATH}`,
          SKILLS_CONF: value.conf,
          REVIEW_NOW: now,
          GH_STUB_DIR: stubs,
          GH_STUB_LOG: log,
        },
        timeout: 5000,
      },
    );

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("greptile absent\ndone\n");
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(1);
    expect(readFileSync(log, "utf8")).toContain("api graphql");
  });

test("wrapper end to end settings", async () => {
  const value = setup(["greptile"], []);
  const result = await runCommand([bin, "--root", value.root, "settings", "greptile"], {
    cwd: value.temporary,
    env: { ...suiteEnvironment(), SKILLS_CONF: value.conf },
    timeout: 5000,
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe("rereviews=2\nthreshold=4\ncritical-threshold=5\nauto=yes\n");
});

test("reviewer scripts still wait", async () => {
  for (const reviewer of ["greptile", "coderabbit", "macroscope"]) {
    const directory = join(repo, "skills", reviewer);
    for (const path of new Bun.Glob("**/*.{ts,sh}").scanSync({ cwd: directory, onlyFiles: true })) {
      const source = await Bun.file(join(directory, path)).text();
      expect(source).not.toMatch(/sleep|--wait/);
    }
  }
});

for (const [legacy, args] of [
  ["gate x", ["gate", "x"]],
  ["gate 18 outcome=fixed", ["gate", "18", "greptile=fixed"]],
  ["decide 18 main outcome=other", ["decide", "18", "main", "greptile=other"]],
] as const)
  test(`usage: reviewer round ${legacy}`, async () => {
    const value = setup(["greptile"], ["greptile"]);
    const result = await runRound(args, value.deps);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("usage: skills round ");
    expect(value.calls).toHaveLength(0);
  });
