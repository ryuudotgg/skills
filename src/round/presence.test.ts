import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDeclarations } from "../reviewers/declaration.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { acceptanceCases, fixture, now, repo, response } from "./fixtures.ts";
import { limits, presence } from "./presence.ts";
import { parseRound } from "./round.ts";

const temporary: string[] = [];
const script = join(repo, "skills/playbook/scripts/check-state.sh");

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function setup() {
  const value = fixture();
  temporary.push(value.temporary);
  const stubs = join(value.temporary, "gh");
  mkdirSync(stubs);
  const log = join(value.temporary, "gh.log");
  const env = {
    ...suiteEnvironment(),
    SKILLS_CONF: value.conf,
    PATH: `${repo}/scripts/stubs:${process.env.PATH}`,
    GH_STUB_DIR: stubs,
    GH_STUB_LOG: log,
    REVIEW_NOW: "2026-09-28T12:00:30Z",
  };

  const shell = (args: string[]) =>
    runCommand(["sh", script, ...args], { cwd: value.temporary, env, timeout: 5000 });

  return { ...value, stubs, log, shell, env };
}

test.concurrent("check limits keys differ; limits queried GitHub, TS and shell", async () => {
  const value = setup();
  const result = await value.shell(["--limits"]);

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(`window=${limits.window}\ncap=${limits.cap}\n`);
  expect(limits).toEqual({ window: 60, cap: 1200 });
  expect(result.stderr).toBe("");

  const actual = await runCommand(
    [process.execPath, "-e", `import { limits } from ${JSON.stringify(join(repo, "src/round/presence.ts"))}; console.log(JSON.stringify(limits));`],
    { cwd: value.temporary, env: value.env, timeout: 30_000 },
  );

  expect(actual).toMatchObject({ code: 0, stdout: `${JSON.stringify(limits)}\n`, stderr: "" });
  expect(existsSync(value.log)).toBe(false);
}, 30_000);

for (const args of [
  ["x", "CHECK", "TRIGGER", "LOGINS"],
  ["18", "CHECK", "TRIGGER", "one", "two"],
  ["18", "", "TRIGGER", "LOGINS"],
])
  test.concurrent(`usage: check-state.sh ${JSON.stringify(args)}, TS and shell`, async () => {
    const value = setup();
    const result = await value.shell(args);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: check-state.sh");
    expect(() => parseRound(["gate", args[0]!, ...args.slice(1)])).toThrow();
  });

for (const [body, code, reason] of [
  ["", 1, "gh failed reading PR checks"],
  ['{"data":null}', 0, "cannot parse PR checks"],
] as const)
  test.concurrent(`check-state: ${reason}, retained shell`, async () => {
    const value = setup();
    writeFileSync(join(value.stubs, "api_graphql.prefix"), body);
    writeFileSync(join(value.stubs, "api_graphql.prefix.exit"), String(code));
    const result = await value.shell(["18", "CHECK", "TRIGGER", "LOGINS"]);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`check-state: ${reason}`);
  });

test.concurrent("shared reader facts; shared reader queried more than once, TS and shell", async () => {
  const value = setup();
  const pr = structuredClone(acceptanceCases.find((entry) => entry.name === "absent")!.pr);
  pr.createdAt = now;
  pr.timelineItems.nodes = [{ createdAt: now }];
  pr.comments.nodes = [{ author: { login: "developer" }, body: " @greptileai ", createdAt: now }];
  pr.commits.nodes = [
    {
      commit: {
        oid: "a".repeat(40),
        committedDate: now,
        checkSuites: { nodes: [] },
        statusCheckRollup: {
          contexts: {
            nodes: [
              {
                __typename: "CheckRun",
                name: "Greptile Review",
                status: "QUEUED",
                startedAt: null,
                completedAt: null,
                checkSuite: { createdAt: now },
              },
            ],
          },
        },
      },
    },
  ];

  writeFileSync(join(value.stubs, "api_graphql.prefix"), response(pr));
  const result = await value.shell([
    "18",
    "rEvIeW",
    "@greptileai",
    "greptile-apps greptile-apps[bot]",
  ]);

  const declaration = { ...readDeclarations(value.root)[0]!, check: "rEvIeW" };
  const actual = presence({ pr, comments: pr.comments.nodes }, declaration, "2026-09-28T12:00:30Z");

  expect(actual).toEqual({
    check: "pending",
    seen: true,
    event: "trigger",
    elapsed: 30,
    age: 30,
    gate: "pending",
  });

  expect(result.code).toBe(0);
  expect(result.stdout).toBe(
    "check=pending seen=yes event=trigger elapsed=30 age=30 gate=pending\n",
  );

  expect((await Bun.file(value.log).text()).trim().split("\n")).toHaveLength(1);
  expect(
    presence({ pr, comments: pr.comments.nodes }, declaration, "2026-09-28T16:00:30+04:00"),
  ).toEqual(actual);
});
