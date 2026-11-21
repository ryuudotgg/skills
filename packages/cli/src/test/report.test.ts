import { describe, expect, test } from "bun:test";
import {
  failedTests,
  failingFiles,
  flakyTests,
  namesEveryFailure,
  parseReport,
  rerunnable,
  type Test,
} from "./report.ts";

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="10" failures="5">
  <testsuite name="a.test.ts" file="a.test.ts" tests="8" failures="4">
    <testsuite name="outer" file="a.test.ts" line="4">
      <testsuite name="inner" file="a.test.ts" line="5">
        <testcase name="passes &lt;always&gt; &amp; &quot;quoted&quot;" classname="inner &gt; outer" file="a.test.ts" line="6" />
        <testcase name="times&#10;  out" classname="inner &gt; outer" file="a.test.ts" line="9">
          <failure type="TimeoutError" message="test timed out" />
        </testcase>
      </testsuite>
      <testcase name="skipped" classname="outer" file="a.test.ts" line="17">
        <skipped />
      </testcase>
      <testcase name="(unnamed)" classname="outer" file="a.test.ts">
        <failure type="Error" message="hook broke">Error: hook broke</failure>
      </testcase>
    </testsuite>
    <testcase name="twice" classname="" file="a.test.ts" line="20" />
    <testcase name="twice" classname="" file="a.test.ts" line="21">
      <failure type="AssertionError" message="no">no</failure>
    </testcase>
    <testcase name="row" classname="" file="a.test.ts" line="30" />
    <testcase name="row" classname="" file="a.test.ts" line="30">
      <failure type="AssertionError" message="no">no</failure>
    </testcase>
  </testsuite>
  <testsuite name="sub/b.test.ts" file="sub/b.test.ts" tests="1" failures="1">
    <testcase name="(worker crashed)" classname="" file="sub/b.test.ts">
      <failure type="Error" message="worker process crashed before reporting results" />
    </testcase>
  </testsuite>
  <testsuite name="c.test.ts" file="c.test.ts" tests="1" failures="0">
    <testcase name="fine" classname="" file="c.test.ts" line="2" />
  </testsuite>
</testsuites>
`;

function tests(entries: Record<string, [passed: number, failed: number]>): Map<string, Test> {
  return new Map(
    Object.entries(entries).map(([id, [passed, failed]]) => [
      id,
      { name: id.slice(id.indexOf(":") + 1), passed, failed },
    ]),
  );
}

describe("report", () => {
  test("reads bun's junit report into tests by absolute file, source line and full name", () => {
    const report = parseReport(xml, "/repo/packages/core") ?? new Map();

    expect([...report.keys()]).toEqual([
      "/repo/packages/core/a.test.ts",
      "/repo/packages/core/sub/b.test.ts",
      "/repo/packages/core/c.test.ts",
    ]);

    expect([...(report.get("/repo/packages/core/a.test.ts") ?? [])]).toEqual([
      [
        '["6","outer","inner","passes <always> & \\"quoted\\""]',
        { name: 'outer > inner > passes <always> & "quoted"', passed: 1, failed: 0 },
      ],
      [
        '["9","outer","inner","times\\n  out"]',
        { name: "outer > inner > times out", passed: 0, failed: 1 },
      ],
      ['["","outer","(unnamed)"]', { name: "outer > (unnamed)", passed: 0, failed: 1 }],
      ['["20","twice"]', { name: "twice", passed: 1, failed: 0 }],
      ['["21","twice"]', { name: "twice", passed: 0, failed: 1 }],
      ['["30","row"]', { name: "row", passed: 1, failed: 1 }],
    ]);

    expect(failingFiles(report).map(([file, failing]) => [file, failedTests(failing)])).toEqual([
      [
        "/repo/packages/core/a.test.ts",
        [
          '["9","outer","inner","times\\n  out"]',
          '["","outer","(unnamed)"]',
          '["21","twice"]',
          '["30","row"]',
        ],
      ],
      ["/repo/packages/core/sub/b.test.ts", ['["","(worker crashed)"]']],
    ]);
  });

  test("names that differ only in whitespace or nesting stay different tests at one line", () => {
    const tests = (cases: string) =>
      parseReport(
        `<testsuites><testsuite name="a.test.ts" file="a.test.ts">${cases}</testsuite></testsuites>`,
        "/repo",
      )?.get("/repo/a.test.ts") ?? new Map();

    const first = tests(
      '<testcase name="row&#10;one" file="a.test.ts" line="12"><failure /></testcase>',
    );

    expect(
      flakyTests(first, tests('<testcase name="row&#10;one" file="a.test.ts" line="12" />')),
    ).toEqual(["row one"]);

    expect(
      flakyTests(first, tests('<testcase name="row one" file="a.test.ts" line="12" />')),
    ).toEqual([]);

    const nested = tests(
      '<testsuite name="a" file="a.test.ts"><testcase name="b &gt; c" file="a.test.ts" line="3"><failure /></testcase></testsuite>',
    );

    const flat = tests(
      '<testsuite name="a &gt; b" file="a.test.ts"><testcase name="c" file="a.test.ts" line="3" /></testsuite>',
    );

    expect(flakyTests(nested, flat)).toEqual([]);
  });

  test("text that is not a report reads as no report", () => {
    expect(parseReport("", "/repo")).toBeUndefined();
    expect(parseReport("<testsuites><testsuite>", "/repo")).toBeUndefined();
    expect(parseReport("<testsuites />", "/repo")?.size).toBe(0);
  });

  test("a failed run is explained only when bun's fail count is the report's and no file errored", () => {
    const report = parseReport(xml, "/repo") ?? new Map();
    const run = (lines: string, code = 1) => ({
      code,
      stderr: `(fail) twice\n\n 2 pass\n 1 skip\n${lines}Ran 10 tests\n`,
    });

    expect(namesEveryFailure(report, run(" 5 fail\n"))).toBe(true);
    expect(namesEveryFailure(report, run("\u001b[0m\u001b[31m 5 fail\u001b[0m\n"))).toBe(true);
    expect(namesEveryFailure(report, run(" 5 fail\n", 0))).toBe(false);
    expect(namesEveryFailure(report, run(" 6 fail\n"))).toBe(false);
    expect(namesEveryFailure(report, run(" 5 fail\n 2 errors\n"))).toBe(false);
    expect(namesEveryFailure(report, run(" 5 fail\n \u001b[0m\u001b[31m1 error\u001b[0m\n"))).toBe(
      false,
    );

    expect(namesEveryFailure(report, { code: 1, stderr: "killed\n" })).toBe(false);
    expect(namesEveryFailure(new Map(), { code: 1, stderr: " 0 fail\n" })).toBe(false);
  });

  test("a test is flaky only when every case at its line and name passes the rerun", () => {
    const first = tests({
      "1:steady": [1, 0],
      "2:busy": [0, 1],
      "3:row": [1, 1],
      "4:broken": [0, 1],
      "5:gone": [0, 1],
      "6:half": [1, 1],
      "7:moved": [0, 1],
    });

    const rerun = tests({
      "1:steady": [1, 0],
      "2:busy": [1, 0],
      "3:row": [2, 0],
      "4:broken": [0, 1],
      "6:half": [1, 0],
      "9:moved": [1, 0],
    });

    expect(flakyTests(first, rerun)).toEqual(["busy", "row"]);
    expect(flakyTests(first, undefined)).toEqual([]);
  });

  test("only a bun test command that isolates its files can be rerun", () => {
    expect(rerunnable(["sh", "bun", "test", "--isolate"])).toBeUndefined();
    expect(rerunnable(["bun", "run", "typecheck", "--isolate"])).toBeUndefined();
    expect(rerunnable(["env", "bun", "run", "test", "--isolate"])).toBeUndefined();
    expect(rerunnable([])).toBeUndefined();

    expect(rerunnable(["bun", "test"])).toBeUndefined();
    expect(rerunnable(["bun", "test", "--timeout=30000"])).toBeUndefined();
    expect(rerunnable(["bun", "test", "--parallel", "--no-isolate"])).toBeUndefined();

    for (const flag of ["--bail", "--retry=2", "--rerun-each=3", "--timeout", "-t", "--preload"])
      expect(rerunnable(["bun", "test", "--isolate", flag, "20000"])).toBeUndefined();

    expect(rerunnable(["/opt/bun/bin/bun", "test", "--isolate"])?.first("/r.xml")).toEqual([
      "/opt/bun/bin/bun",
      "test",
      "--reporter=junit",
      "--reporter-outfile=/r.xml",
      "--isolate",
    ]);
  });

  test("the first run keeps the suite's arguments and the rerun takes one file on one worker", () => {
    const command = rerunnable([
      "env",
      "SKILLS_TEST_VIEWS=deleted",
      "bun",
      "test",
      "--parallel",
      "--timeout=20000",
      "--max-concurrency=4",
      "packages/cli/src/plans/plans.test.ts",
      "packages/cli/src/plans/sweep.test.ts",
    ]);

    expect(command?.first("/r.xml")).toEqual([
      "env",
      "SKILLS_TEST_VIEWS=deleted",
      "bun",
      "test",
      "--reporter=junit",
      "--reporter-outfile=/r.xml",
      "--parallel",
      "--timeout=20000",
      "--max-concurrency=4",
      "packages/cli/src/plans/plans.test.ts",
      "packages/cli/src/plans/sweep.test.ts",
    ]);

    expect(command?.rerun("/r.xml", "/repo/packages/cli/src/plans/sweep.test.ts")).toEqual([
      "env",
      "SKILLS_TEST_VIEWS=deleted",
      "bun",
      "test",
      "--reporter=junit",
      "--reporter-outfile=/r.xml",
      "--parallel=1",
      "--timeout=20000",
      "--max-concurrency=4",
      "/repo/packages/cli/src/plans/sweep.test.ts",
    ]);

    expect(rerunnable(["bun", "test", "--parallel=3"])?.rerun("/r.xml", "/a.test.ts")).toEqual([
      "bun",
      "test",
      "--reporter=junit",
      "--reporter-outfile=/r.xml",
      "--parallel=1",
      "/a.test.ts",
    ]);
  });
});
