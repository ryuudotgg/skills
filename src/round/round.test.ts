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

function setup(names: string[] = ["a", "r", "s"], ported: string[] = []) {
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
      value.responses.set("r", success(`${left}\n`));
      value.responses.set("s", success(`${right}\n`));

      expect((await runRound(["gate", "18"], value.deps)).stdout).toBe(
        `r ${left}\ns ${right}\n${expected}\n`,
      );
    }

    expect(value.calls.filter((entry) => entry.command === "gh")).toHaveLength(0);
  });

test("a did not receive critical; r did not receive critical; wait reached a reviewer", async () => {
  const value = setup(["a", "r"]);

  expect((await runRound(["gate", "18", "--wait", "critical=true"], value.deps)).stdout).toBe(
    "a done\nr done\ndone\n",
  );

  expect(value.calls.map((entry) => entry.args.slice(2))).toEqual([
    ["gate", "18", "critical=true"],
    ["gate", "18", "critical=true"],
  ]);
});

test("decide gained an outcome; outcome did not reach reviewer; outcome reached another reviewer", async () => {
  const value = setup(["a", "r"]);
  value.responses.set("a", success("wait\n"));

  expect((await runRound(["decide", "18", "feat/topic", "critical=true"], value.deps)).stdout).toBe(
    "a wait\nr done\nwait\n",
  );

  expect(value.calls[0]!.args.slice(2)).toEqual(["decide", "18", "feat/topic", "critical=true"]);
  value.calls.length = 0;
  await runRound(["decide", "18", "feat/topic", "r=dismissed"], value.deps);

  expect(value.calls.map((entry) => entry.args.slice(2))).toEqual([
    ["decide", "18", "feat/topic"],
    ["decide", "18", "feat/topic", "outcome=dismissed"],
  ]);
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
  test(`invalid shell verdict ${JSON.stringify(output)}`, async () => {
    const value = setup(["a", "r"]);
    value.responses.set("a", success("wait\n"));
    value.responses.set("r", success(output));

    expect((await runRound(["gate", "18"], value.deps)).stdout).toBe(
      "a wait\nr handback refused\nhandback r refused\n",
    );

    expect(validVerdict(output.replace(/\n$/, ""))).toBe(false);
  });

test("nonzero valid stdout is refused and stderr passed through", async () => {
  const value = setup(["r"]);
  value.responses.set("r", { code: 1, stdout: "done\n", stderr: "provider failed\n" });

  expect(await runRound(["gate", "18"], value.deps)).toEqual({
    code: 0,
    stdout: "r handback refused\nhandback r refused\n",
    stderr: "provider failed\n",
  });
});

test("missing verdict had no note", async () => {
  const value = setup(["r"]);
  rmSync(join(value.root, "r/scripts/verdict.sh"));

  expect(await runRound(["gate", "18"], value.deps)).toEqual({
    code: 0,
    stdout: "r handback refused\nhandback r refused\n",
    stderr: "round: r has no reviewer.ts or scripts/verdict.sh\n",
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
    value.responses.set("a", success(`${first}\n`));
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(seconds);
      value.responses.set("a", success(`${next}\n`));
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

    expect(
      value.calls
        .filter((entry) => entry.args[1]!.includes("/a/"))
        .map((entry) => entry.args.slice(2)),
    ).toEqual(
      Array.from({ length: expectedSleeps + 1 }, () =>
        phase === "gate"
          ? ["gate", "18", "critical=true"]
          : ["decide", "18", "feat/topic", "outcome=fixed", "critical=true"],
      ),
    );
  });

for (const poll of [undefined, "", "bad", "0", "01", "-1", "17", "99999"])
  test(`deadline did not sleep once; deadline read another pass; ROUND_POLL=${poll}`, async () => {
    const value = setup(["a", "r"]);
    value.deps.env.ROUND_POLL = poll;
    value.responses.set("a", success("wait check-appear\n"));
    const sleeps: number[] = [];
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(limits.window + limits.cap);
      value.responses.set("a", success("done\n"));
    };

    expect((await runRound(["decide", "18", "feat/topic"], value.deps)).stdout).toBe(
      "a wait check-appear\nr done\nwait\n",
    );

    expect(sleeps).toEqual([poll === "17" ? 17 : poll === "99999" ? 1260 : 30]);
    expect(value.calls).toHaveLength(2);
  });

for (const poll of ["7", "0", "soon", ""])
  test(`poll [${poll}] slept, expected ${poll === "7" ? 7 : 30}`, async () => {
    const value = setup(["a", "r"]);
    const sleeps: number[] = [];
    value.deps.env.ROUND_POLL = poll;
    value.responses.set("a", success("wait check-pending\n"));
    value.deps.sleep = async (seconds) => {
      sleeps.push(seconds);
      value.advance(seconds);
      value.responses.set("a", success("done\n"));
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

test("shell stderr streams before exit and buffers later reviewers in order", async () => {
  const value = setup(["a", "r"]);
  const emitted: string[] = [];
  const streams = new Map<string, (text: string) => void>();
  const completions = new Map<string, (result: ReturnType<typeof success>) => void>();
  value.deps.stderr = (text) => { emitted.push(text); };
  value.deps.shell = (args, stderr) => {
    const name = args[1]!.split("/").at(-3)!;
    streams.set(name, stderr!);
    return new Promise((resolve) => { completions.set(name, resolve); });
  };

  const running = runRound(["gate", "18"], value.deps);
  streams.get("r")!("later first\n");

  expect(emitted).toEqual([]);

  streams.get("a")!("earlier first\n");

  expect(emitted).toEqual(["earlier first\n"]);

  completions.get("a")!(success("done\n"));
  await Promise.resolve();

  expect(emitted).toEqual(["earlier first\n", "later first\n"]);

  streams.get("r")!("later second\n");
  completions.get("r")!(success("done\n"));
  const result = await running;

  expect(result.stderr).toBe(emitted.join(""));
  expect(result.stdout).toBe("a done\nr done\ndone\n");
});

test("uncaught round error preserves collected stderr before refusal", async () => {
  const value = setup(["r"]);
  const emitted: string[] = [];
  value.deps.stderr = (text) => { emitted.push(text); };
  value.responses.set("r", { code: 0, stdout: "wait check-appear\n", stderr: "provider note\n" });
  value.deps.sleep = async () => { throw new Error("sleep failed"); };

  const result = await runRound(["decide", "18", "topic"], value.deps);

  expect(result).toEqual({ code: 1, stdout: "", stderr: "provider note\nround: sleep failed\n" });
  expect(emitted).toEqual(["provider note\n", "round: sleep failed\n"]);
});

test("spawn reads stderr while verdict process is still running", async () => {
  const value = setup(["r"]);
  const release = join(value.temporary, "release");
  const emitted: string[] = [];
  const result = await dependencies(value.root, value.temporary).shell(
    ["sh", "-c", 'printf "provider note\\n" >&2; while [ ! -f "$1" ]; do sleep 0.01; done; printf "done\\n"', "sh", release],
    (text) => {
      emitted.push(text);
      writeFileSync(release, "");
    },
  );

  expect(result).toEqual({ code: 0, stdout: "done\n", stderr: "provider note\n" });
  expect(emitted.join("")).toBe(result.stderr);
}, 30_000);

for (const verb of ["round gate 18", "settings greptile"])
test(`wrapper writes notes before stdout: ${verb}`, async () => {
  const value = setup(["greptile"], ["greptile"]);
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=bad\n");
  const stubs = join(value.temporary, "gh");
  mkdirSync(stubs);
  writeFileSync(join(stubs, "api_graphql.prefix"), response(acceptanceCases.find((entry) => entry.name === "absent")!.pr));

  const result = await runCommand(
    ["sh", "-c", '"$@" 2>&1', "sh", bin, "--root", value.root, ...verb.split(" ")],
    {
      cwd: value.temporary,
      env: { ...suiteEnvironment(), PATH: `${repo}/scripts/stubs:${process.env.PATH}`, SKILLS_CONF: value.conf, REVIEW_NOW: now, GH_STUB_DIR: stubs, GH_STUB_LOG: join(value.temporary, "gh.log") },
      timeout: 30_000,
    },
  );

  expect(result.code).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(`settings: ${value.conf}: GREPTILE_REREVIEWS=bad is not valid, skipped\n${verb.startsWith("round") ? "greptile absent\ndone\n" : "rereviews=2\nthreshold=4\ncritical-threshold=5\n"}`);
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

test("snapshot starts concurrently with shell verdict and outputs reviewer order", async () => {
  const value = setup(["a", "testbot"], ["testbot"]);
  let release: (result: ReturnType<typeof success>) => void = () => {};
  let started = false;
  value.deps.gh = () => {
    started = true;

    return new Promise((resolve) => {
      release = resolve;
    });
  };

  value.deps.shell = async () => {
    expect(started).toBe(true);
    release(success(response(acceptanceCases[0]!.pr)));
    return success("triage\n");
  };

  expect((await runRound(["gate", "18"], value.deps)).stdout).toBe(
    "a triage\ntestbot done\ntriage\n",
  );
});

for (const broken of [failure("offline\n"), success("bad json"), success('{"data":null}')])
  test(`shared reader refuses all ported reviewers: ${broken.stdout || broken.stderr}`, async () => {
    const value = setup(["a", "greptile", "testbot"], ["greptile", "testbot"]);
    value.deps.gh = async () => broken;
    const result = await runRound(["gate", "18"], value.deps);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "a done\ngreptile handback refused\ntestbot handback refused\nhandback greptile refused, testbot refused\n",
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
  expect(result.stdout).toBe("rereviews=2\nthreshold=4\ncritical-threshold=5\n");
});

test("reviewer scripts still wait", async () => {
  for (const reviewer of ["greptile", "coderabbit"]) {
    const directory = join(repo, "skills", reviewer);
    for (const path of new Bun.Glob("**/*").scanSync({ cwd: directory, onlyFiles: true })) {
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
  test(`usage: verdict.sh ${legacy}`, async () => {
    const value = setup(["greptile"], ["greptile"]);
    const result = await runRound(args, value.deps);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toStartWith("usage: skills round ");
    expect(value.calls).toHaveLength(0);
  });
