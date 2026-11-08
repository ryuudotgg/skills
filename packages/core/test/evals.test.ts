import { expect, test } from "bun:test";
import { evalFrom, evalResult, type EvalRecord } from "../src/index.ts";

const record: EvalRecord = {
  case: "plans-new-preflight",
  models: ["opus"],
  roster: "claude codex",
  exit: 0,
  verdict: "pass",
  grade: "PASS 3/3",
  duration: 600000,
};

test("an eval payload parses only with every field in its recorded shape", () => {
  expect(evalFrom(record)).toEqual(record);
  expect(evalFrom({ ...record, verdict: null, grade: null })).toEqual({
    ...record,
    verdict: null,
    grade: null,
  });

  for (const broken of [
    null,
    [],
    { ...record, case: "" },
    { ...record, models: "opus" },
    { ...record, roster: ["claude"] },
    { ...record, exit: 0.5 },
    { ...record, verdict: "ungraded" },
    { ...record, grade: 3 },
    { ...record, duration: -1 },
    { ...record, duration: undefined, durationMs: 600000 },
  ])
    expect(evalFrom(broken)).toBeUndefined();
});

test("a run passes on exit 0 with a pass or no verdict, and fails otherwise", () => {
  expect(evalResult(record)).toBe("pass");
  expect(evalResult({ ...record, verdict: null, grade: null })).toBe("ungraded");
  expect(evalResult({ ...record, verdict: "fail" })).toBe("fail");
  expect(evalResult({ ...record, exit: 1, verdict: null })).toBe("fail");
  expect(evalResult({ ...record, exit: 1, verdict: "pass" })).toBe("fail");
});
