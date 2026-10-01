import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decide, facts, type Facts } from "../../skills/greptile/reviewer.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { presence } from "./presence.ts";
import {
  acceptanceCases,
  decisionCases,
  failure,
  fixture,
  now,
  repo,
  response,
  reviewerInput,
  scoreCases,
  success,
} from "./fixtures.ts";
import { runRound } from "./round.ts";
import { snapshotQuery } from "./snapshot.ts";
import type { Fixes, Presence, PullRequest } from "./types.ts";

const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function factsLine(value: Facts): string {
  return `score=${value.score ?? "none"} paid=${value.paid} running=${value.running ? "yes" : "no"} skipped=${value.skipped ? "yes" : "no"} reviewed=${value.fixesFrom ?? "none"} required=${value.required ?? "none"}`;
}

describe("Greptile score case ledger", () => {
  for (const entry of scoreCases)
    test(entry.name, () => {
      const snapshot = {
        headChecks: {},
        pr: entry.pr,
        comments: [
          ...entry.pr.comments.nodes,
          ...entry.triggers.map((createdAt) => ({
            author: { login: "developer" },
            body: "@greptileai",
            createdAt,
          })),
        ],
      };

      expect(factsLine(facts(reviewerInput(entry.pr, { snapshot })))).toBe(entry.expected);
    });

  test("body edit query must read newest edits", () => {
    expect(snapshotQuery.match(/userContentEdits\(first: 20\)/g)).toHaveLength(1);
  });

  test("first maximum keeps body before comment before review and body sha before review", () => {
    const pr = structuredClone(scoreCases[0]!.pr);
    pr.comments.nodes[0]!.updatedAt = "2026-09-26T00:06:00Z";
    pr.reviews.nodes[0]!.submittedAt = "2026-09-26T00:06:00Z";

    expect(facts(reviewerInput(pr))).toMatchObject({ score: 4, fixesFrom: "a".repeat(40) });
  });

  test("skip time equal to newest score is not skipped", () => {
    const pr = structuredClone(scoreCases[0]!.pr);
    pr.comments.nodes.push({
      author: { login: "greptile-apps" },
      body: "Review was skipped",
      createdAt: "2026-09-26T00:06:00Z",
      updatedAt: "2026-09-26T00:06:00Z",
    });

    expect(facts(reviewerInput(pr)).skipped).toBe(false);
  });

  test("review with a body and a null commit refuses", () => {
    const pr = structuredClone(scoreCases[0]!.pr);
    pr.reviews.nodes[0]!.commit = null;
    expect(() => facts(reviewerInput(pr))).toThrow("cannot parse PR review");
  });

  test("null bot body cannot parse PR review", () => {
    const pr = structuredClone(scoreCases[0]!.pr);
    pr.comments.nodes[0]!.body = null;
    expect(() => facts(reviewerInput(pr))).toThrow("cannot parse PR review");
  });

  for (const invalid of [
    "2026-09-26T00:09:59+00:00",
    "2026-09-26T00:09:59.000Z",
    "2026-02-30T00:00:00Z",
    "bad",
  ])
    test(`REVIEW_NOW rejects ${invalid}`, () => {
      expect(() => facts(reviewerInput(scoreCases[0]!.pr, { now: invalid }))).toThrow();
    });
});

describe("Greptile acceptance_case ledger", () => {
  for (const entry of acceptanceCases)
    test(`acceptance_case ${entry.name}`, () => {
      const input = reviewerInput(entry.pr, { now });
      input.presence = presence(input.snapshot, input.declaration, now);
      expect(String(decide(facts(input), null, input))).toBe(entry.expected);
    });

  test("appear decide differs", () => {
    const pr = acceptanceCases.find((entry) => entry.name === "appear")!.pr;
    const input = reviewerInput(pr, { phase: "decide", now });
    input.presence = presence(input.snapshot, input.declaration, now);

    expect(decide(facts(input), null, input)).toBe("wait check-appear");
  });

  test("seen push with small fix", () => {
    const pr = acceptanceCases.find((entry) => entry.name === "seen-push")!.pr;
    const input = reviewerInput(pr, { now });
    input.presence = presence(input.snapshot, input.declaration, now);

    expect(decide(facts(input), { commits: 1, lines: 5, added: 0, moved: true }, input)).toBe(
      "rereview below-threshold",
    );
  });
});

describe("Greptile decision table ledger", () => {
  for (const [index, [line, expected]] of decisionCases.entries()) {
    const grammarOnly =
      line.includes("unknown=") ||
      line.includes("malformed") ||
      (line.includes("score=3") && line.includes("score=4")) ||
      line.includes("critical=yes") ||
      line.includes("present=") ||
      line.includes("gate=");

    if (grammarOnly) continue;

    test(`decision ${index + 1}: ${line} | ${expected}`, () => {
      const fields = Object.fromEntries(line.split(" ").map((word) => word.split("=")));
      const nullable = (value: string | undefined) => (value === "none" ? null : Number(value));
      const value: Facts = {
        score: nullable(fields.score),
        paid: Number(fields.paid),
        running:
          fields.running === "yes"
            ? true
            : fields.running === "no"
              ? false
              : (undefined as unknown as boolean),
        skipped:
          fields.skipped === "yes"
            ? true
            : fields.skipped === "no"
              ? false
              : (undefined as unknown as boolean),
        fixesFrom: fields.reviewed === "none" ? null : fields.reviewed!,
        required: nullable(fields.required),
      };

      const fixes: Fixes | null =
        fields.commits === undefined
          ? null
          : {
              commits: Number(fields.commits),
              lines: Number(fields.lines),
              added: Number(fields.added),
              moved:
                fields.moved === "yes"
                  ? true
                  : fields.moved === "no"
                    ? false
                    : (undefined as unknown as boolean),
            };

      const input = reviewerInput(scoreCases[0]!.pr, { critical: fields.critical === "true" });
      if (expected === "usage")
        expect(() => decide(value, fixes, input)).toThrow("cannot decide review state");
      else expect(String(decide(value, fixes, input))).toBe(expected);
    });
  }

  test("quoted decision: got handback no-reviewed-commit", () => {
    expect(
      decide(
        { score: 3, paid: 1, running: false, skipped: false, fixesFrom: null, required: null },
        null,
        reviewerInput(scoreCases[0]!.pr),
      ),
    ).toBe("handback no-reviewed-commit");
  });

  for (const [name, config, score, critical, expected] of [
    ["base paid cap", "", 3, false, "handback paid-cap"],
    ["configured paid cap", "GREPTILE_REREVIEWS=3\n", 3, false, "rereview below-threshold"],
    ["configured threshold", "GREPTILE_THRESHOLD=3\n", 3, false, "done threshold"],
    ["configured critical threshold", "GREPTILE_CRITICAL_THRESHOLD=4\n", 4, true, "done threshold"],
  ] as const)
    test(name, async () => {
      const value = fixture();
      temporary.push(value.temporary);
      writeFileSync(value.conf, `DELIVERY=prs\nWITH=greptile\n${config}`);

      const pr = structuredClone(acceptanceCases.find((entry) => entry.name === "seen-push")!.pr);
      pr.reviews.nodes[0]!.body = `Confidence Score: ${score}/5`;
      pr.reviews.nodes[0]!.commit = { oid: "a".repeat(40) };

      pr.comments.nodes = ["2026-09-28T11:00:00Z", "2026-09-28T11:00:01Z"].map((createdAt) => ({
        author: { login: "developer" },
        body: "@greptileai",
        createdAt,
      }));

      const check = pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes[0]!;
      if (check.__typename === "CheckRun") check.title = "";

      value.deps.gh = async () => success(response(pr));
      value.deps.git = async (args) => {
        if (args[0] === "config")
          return args.includes("--get-regexp") ? failure() : success("main");

        if (args[0] === "rev-list") return success("b".repeat(40));
        if (args[0] === "log") return success(args.includes("--numstat") ? "5\t0\tshared\0" : "");

        return success(
          args.includes(`${"a".repeat(40)}^{commit}`) ? "a".repeat(40) : "b".repeat(40),
        );
      };

      expect(facts(reviewerInput(pr, { now }))).toEqual({
        score,
        paid: 2,
        running: false,
        skipped: false,
        fixesFrom: "a".repeat(40),
        required: null,
      });

      const result = await runRound(
        ["decide", "18", "feature", "greptile=fixed", ...(critical ? ["critical=true"] : [])],
        value.deps,
      );

      expect(result).toEqual({
        code: 0,
        stdout: `greptile ${expected}\n${expected.startsWith("handback") ? `handback greptile ${expected.slice(9)}` : expected.split(" ")[0]}\n`,
        stderr: "",
      });
    });

  test("missing Greptile settings refuses instead of comparing NaN", async () => {
    const input = reviewerInput(scoreCases[0]!.pr, { settings: {} });

    expect(() => decide(facts(input), null, input)).toThrow("cannot decide review state");

    const value = fixture();
    temporary.push(value.temporary);
    const path = join(value.root, "greptile/reviewer.ts");
    rmSync(path);
    writeFileSync(
      path,
      `import { decide as greptileDecide } from ${JSON.stringify(join(repo, "skills/greptile/reviewer.ts"))}; export const facts = () => (${JSON.stringify(facts(input))}); export const decide = (facts, fixes, input) => greptileDecide(facts, fixes, { ...input, settings: {} });`,
    );

    const result = await runRound(["gate", "18"], value.deps);

    expect(result).toEqual({
      code: 0,
      stdout: "greptile handback refused\nhandback greptile refused\n",
      stderr: "round: cannot decide review state\n",
    });
  });

  for (const key of ["rereviews", "threshold", "critical-threshold"])
    for (const invalid of [undefined, "", "bad", "1.5", "-1", "NaN"])
      test(`Greptile refuses ${key}=${invalid}`, () => {
        const input = reviewerInput(scoreCases[0]!.pr);
        if (invalid === undefined) delete input.settings[key];
        else input.settings[key] = invalid;

        expect(() => decide(facts(input), null, input)).toThrow("cannot decide review state");
      });

  test("decision called gh", async () => {
    const value = fixture();
    temporary.push(value.temporary);
    const stubs = join(value.temporary, "gh");
    const log = join(value.temporary, "gh.log");
    mkdirSync(stubs);

    const input = reviewerInput(scoreCases[0]!.pr, { critical: true });
    input.settings["critical-threshold"] = "4";
    const score: Facts = {
      score: 4,
      paid: 2,
      running: false,
      skipped: false,
      fixesFrom: "a".repeat(40),
      required: null,
    };

    const fixes: Fixes = { commits: 1, lines: 5, added: 0, moved: true };
    const program = `import { decide } from ${JSON.stringify(join(repo, "skills/greptile/reviewer.ts"))}; console.log(decide(${JSON.stringify(score)}, ${JSON.stringify(fixes)}, ${JSON.stringify(input)}));`;
    const result = await runCommand([process.execPath, "-e", program], {
      cwd: value.temporary,
      env: {
        ...suiteEnvironment(),
        PATH: `${repo}/scripts/stubs:${process.env.PATH}`,
        GH_STUB_DIR: stubs,
        GH_STUB_LOG: log,
      },
      timeout: 30_000,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("done threshold\n");
    expect(existsSync(log)).toBe(false);
  }, 30_000);

  test("pending presence rejects forged fact values", () => {
    const input = reviewerInput(scoreCases[0]!.pr);
    input.presence = { ...input.presence, check: "invalid" as Presence["check"] };
    expect(() => decide(facts(input), null, input)).toThrow();
  });
});

function verdictCheckFixture(): PullRequest {
  const pr = structuredClone(scoreCases[0]!.pr);
  pr.timelineItems = { nodes: [] };
  pr.reviewThreads = { nodes: [] };
  for (const comment of pr.comments.nodes) comment.createdAt = comment.updatedAt!;

  for (const { commit } of pr.commits.nodes) {
    commit.committedDate = pr.createdAt;
    commit.checkSuites = { nodes: [] };
  }

  return pr;
}

for (const [name, args, expected] of [
  ["gate verdict differs", ["gate", "18"], "triage scored"],
  ["critical gate verdict differs", ["gate", "18", "critical=true"], "triage scored"],
  ["decide without outcome differs", ["decide", "18", "main"], "triage scored"],
] as const)
  test(name, async () => {
    const value = fixture();
    temporary.push(value.temporary);
    const pr = verdictCheckFixture();

    value.deps.env.REVIEW_NOW = "2026-09-26T00:09:59Z";
    value.deps.gh = async () => success(response(pr));
    const result = await runRound(args, value.deps);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      `greptile ${expected}\n${expected.split(" ")[0] === "handback" ? `handback greptile ${expected.slice(9)}` : "triage"}\n`,
    );

    expect(result.stderr).toBe("");
  });

for (const outcome of ["fixed", "dismissed"] as const)
  test(`${outcome} without reviewed commit differs`, () => {
    const check = verdictCheckFixture();
    const score = scoreCases.find((entry) => entry.name === "score_case no-reviewed 20")!.pr;
    const input = reviewerInput(score, { phase: "decide", outcome });
    input.presence = presence(
      { pr: check, comments: check.comments.nodes, headChecks: {} },
      input.declaration,
      input.now,
    );

    expect(input.presence.gate).toBe("decide");
    expect(facts(input)).toMatchObject({ score: 4, fixesFrom: null });
    expect(decide(facts(input), null, input)).toBe("handback no-reviewed-commit");
  });

test("appear decide read check state more than once", async () => {
  const value = fixture();
  temporary.push(value.temporary);
  const pr = acceptanceCases.find((entry) => entry.name === "appear")!.pr;
  value.deps.gh = async (args, deadline) => {
    value.calls.push({ command: "gh", args, deadline });
    return success(response(pr));
  };

  value.deps.sleep = async () => {
    value.advance(1260);
  };

  const result = await runRound(["decide", "18", "main"], value.deps);

  expect(result).toEqual({ code: 0, stdout: "greptile wait check-appear\nwait\n", stderr: "" });
  expect(value.calls.filter((entry) => entry.command === "gh")).toHaveLength(1);
});
