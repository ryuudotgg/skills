import { afterAll, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { decide } from "../../skills/greptile/reviewer.ts";
import { failure, fixture, response, reviewerInput, scoreCases, success } from "./fixtures.ts";
import { macroscopeFixture } from "./reviewer-fixtures.ts";
import { runRound } from "./round.ts";
import type { CheckRun, PullRequest } from "./types.ts";

const temporary: string[] = [];

afterAll(() => {
  for (const path of temporary) rmSync(path, { recursive: true, force: true });
});

function cleanPeers(): PullRequest {
  const pr = macroscopeFixture("clean").pr;
  const head = pr.commits.nodes.at(-1)!.commit;

  head.statusCheckRollup!.contexts.nodes.push({
    __typename: "StatusContext",
    context: "CodeRabbit",
    state: "SUCCESS",
    description: "Review completed",
    createdAt: "2026-09-30T14:20:00Z",
  });

  pr.reviews.nodes.push({
    author: { login: "coderabbitai" },
    state: "COMMENTED",
    body: "Reviewed this commit.",
    commit: { oid: head.oid },
    submittedAt: null,
  });

  return pr;
}

function greptileCheck(status: string, startedAt: string, completedAt: string | null): CheckRun {
  return {
    __typename: "CheckRun",
    name: "Greptile Review",
    status,
    conclusion: status === "COMPLETED" ? "SUCCESS" : null,
    title: "",
    startedAt,
    completedAt,
    checkSuite: { createdAt: startedAt },
  };
}

test("auto off leaves the first review to the agent, then reads a requested one like the base", async () => {
  const value = fixture(["coderabbit", "greptile", "macroscope"]);
  temporary.push(value.temporary);

  let pr = cleanPeers();
  value.deps.gh = async () => success(response(pr));
  value.deps.git = async (args) =>
    args.includes("--get-regexp") ? failure() : success("main");

  const gate = async (now: string, auto: "yes" | "no") => {
    writeFileSync(
      value.conf,
      `DELIVERY=prs\nWITH=coderabbit greptile macroscope\n${auto === "no" ? "GREPTILE_AUTO=no\n" : ""}`,
    );

    value.deps.env.REVIEW_NOW = now;
    const result = await runRound(["gate", "18"], value.deps);
    expect(result.code).toBe(0);
    return result.stdout;
  };

  const peers = (greptile: string, combined: string) =>
    `coderabbit done clean\ngreptile ${greptile}\nmacroscope done approved\n${combined}\n`;

  expect(await gate("2026-09-30T14:30:00Z", "yes")).toBe(peers("absent", "done"));
  expect(await gate("2026-09-30T14:30:00Z", "no")).toBe(peers("absent optional", "done"));

  pr = structuredClone(pr);
  pr.comments.nodes.push({
    author: { login: "developer" },
    body: "@greptileai",
    createdAt: "2026-09-30T14:31:00Z",
  });

  expect(await gate("2026-09-30T14:31:10Z", "no")).toBe(peers("wait check-appear", "wait"));
  expect(await gate("2026-09-30T14:33:00Z", "no")).toBe(peers("unavailable no-review", "done"));

  const head = pr.commits.nodes.at(-1)!.commit;
  head.statusCheckRollup!.contexts.nodes.push(
    greptileCheck("IN_PROGRESS", "2026-09-30T14:31:30Z", null),
  );

  expect(await gate("2026-09-30T14:32:00Z", "no")).toBe(peers("wait check-pending", "wait"));

  head.statusCheckRollup!.contexts.nodes.pop();
  head.statusCheckRollup!.contexts.nodes.push(
    greptileCheck("COMPLETED", "2026-09-30T14:31:30Z", "2026-09-30T14:35:00Z"),
  );

  pr.reviews.nodes.push({
    author: { login: "greptile-apps" },
    body: "Confidence Score: 5/5",
    submittedAt: "2026-09-30T14:35:00Z",
    commit: { oid: head.oid },
  });

  const base = await gate("2026-09-30T14:36:00Z", "yes");
  expect(base).toBe(peers("triage scored", "triage"));
  expect(await gate("2026-09-30T14:36:00Z", "no")).toBe(base);
});

test("auto off counts the first review outside the rereviews budget", () => {
  const input = reviewerInput(scoreCases[0]!.pr, { phase: "decide", outcome: "fixed" });
  input.settings.auto = "no";
  const fixes = { commits: 1, lines: 5, added: 0, moved: true };
  const facts = (paid: number) => ({
    score: 3,
    paid,
    running: false,
    skipped: false,
    fixesFrom: "a".repeat(40),
    required: null,
  });

  expect(decide(facts(2), fixes, input)).toBe("rereview below-threshold");
  expect(decide(facts(3), fixes, input)).toBe("handback paid-cap");

  input.settings.auto = "yes";
  expect(decide(facts(2), fixes, input)).toBe("handback paid-cap");
});
