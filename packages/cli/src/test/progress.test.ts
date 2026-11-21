import { expect, test } from "bun:test";
import { liveView, renderEnd, renderTable, type SuiteState, type ViewOptions } from "./progress.ts";

const home = "/home/me";
function view(fields: Partial<ViewOptions> = {}): ViewOptions {
  return {
    repo: `${home}/skills`,
    home,
    color: false,
    started: 0,
    now: 42_000,
    stopped: false,
    ...fields,
  };
}

const states: SuiteState[] = [
  { name: "bun", estimate: 70, status: "running", started: 0 },
  { name: "docs", estimate: 3, status: "ok", seconds: 8, output: "hidden\n", flaky: [] },
  {
    name: "typecheck",
    estimate: 1,
    status: "fail",
    seconds: 2.84,
    output: "\n\nerror one\n",
    flaky: [],
  },
  { name: "format", estimate: 2, status: "running", started: 41_200 },
  { name: "check", estimate: 0.2, status: "queued" },
];

test("one row per suite in run order, lined up, with live seconds and the estimate", () => {
  expect(renderTable(states, view())).toEqual([
    "",
    "skills test · ~/skills",
    "",
    "  bun        running  42s of ~70s",
    "  docs       ok       8.0s",
    "  typecheck  FAIL     2.8s",
    "  format     running  0s of ~2s",
    "  check      queued",
  ]);
});

test("the estimate drops once a suite runs past it", () => {
  const [bun] = renderTable(states, view({ now: 85_400 })).slice(3);
  expect(bun).toBe("  bun        running  85s");
});

test("a stopped run marks running suites stopped and queued ones not run", () => {
  expect(renderTable(states, view({ stopped: true })).slice(3)).toEqual([
    "  bun        stopped",
    "  docs       ok       8.0s",
    "  typecheck  FAIL     2.8s",
    "  format     stopped",
    "  check      not run",
  ]);
});

test("color only when asked, with the same text underneath", () => {
  const plain = renderTable(states, view()).join("\n");
  const colored = renderTable(states, view({ color: true })).join("\n");

  expect(plain).not.toContain("\u001b[");
  expect(colored).toContain("\u001b[32mok\u001b[39m");
  expect(colored).toContain("\u001b[1m\u001b[31mFAIL\u001b[39m\u001b[22m");
  expect(Bun.stripANSI(colored)).toBe(plain);
  expect(Bun.stripANSI(renderEnd(states, view({ color: true })))).toBe(renderEnd(states, view()));
});

test("failures print their output verbatim under a header, then one summary", () => {
  const done: SuiteState[] = [
    {
      name: "bun",
      estimate: 70,
      status: "fail",
      seconds: 97.5,
      output: `at ${home}/x.ts\n`,
      flaky: [],
    },
    { name: "docs", estimate: 3, status: "ok", seconds: 8, output: "hidden\n", flaky: [] },
    { name: "lint", estimate: 1, status: "fail", seconds: 1, output: "", flaky: [] },
    {
      name: "typecheck",
      estimate: 1,
      status: "fail",
      seconds: 2.84,
      output: "\n\n  error\n\n",
      flaky: [],
    },
  ];

  expect(renderEnd(done, view({ now: 98_100 }))).toBe(
    [
      "",
      "FAIL bun 97.5s",
      "",
      `at ${home}/x.ts`,
      "",
      "FAIL lint 1.0s",
      "",
      "no output",
      "",
      "FAIL typecheck 2.8s",
      "",
      "  error",
      "",
      "3 of 4 suites failed in 98.1s: bun, lint, typecheck",
      "",
    ].join("\n"),
  );
});

test("a clean run ends on one line", () => {
  const done: SuiteState[] = [
    { name: "check", estimate: 0.2, status: "ok", seconds: 0.3, output: "", flaky: [] },
  ];

  expect(renderEnd(done, view({ now: 400 }))).toBe("\n1 suite passed in 0.4s\n");
  expect(renderEnd([], view())).toBe("No suites to run.\n");
});

test("a suite held for its rerun says so, and flaky tests are listed above the summary", () => {
  const held: SuiteState[] = [{ name: "bun", estimate: 70, status: "rerun", seconds: 71.26 }];
  expect(renderTable(held, view()).slice(3)).toEqual(["  bun  rerun    failed in 71.3s"]);
  expect(renderTable(held, view({ stopped: true })).slice(3)).toEqual([
    "  bun  rerun    failed in 71.3s",
  ]);

  const done: SuiteState[] = [
    { name: "bun", estimate: 70, status: "ok", seconds: 80, output: "", flaky: ["a.test.ts: one"] },
    {
      name: "hub",
      estimate: 10,
      status: "fail",
      seconds: 9,
      output: "broke\n",
      flaky: ["b.test.ts: two"],
    },
  ];

  expect(renderEnd(done.slice(0, 1), view({ now: 81_000 }))).toBe(
    "\nflaky a.test.ts: one\n\n1 suite passed in 81.0s, 1 flaky\n",
  );

  expect(renderEnd(done, view({ now: 81_000 }))).toBe(
    [
      "",
      "FAIL hub 9.0s",
      "",
      "broke",
      "",
      "flaky a.test.ts: one",
      "flaky b.test.ts: two",
      "",
      "1 of 2 suites failed in 81.0s: hub",
      "",
    ].join("\n"),
  );

  const colored = renderEnd(done, view({ now: 81_000, color: true }));
  expect(colored).toContain("\u001b[33mflaky\u001b[39m a.test.ts: one");
  expect(Bun.stripANSI(colored)).toBe(renderEnd(done, view({ now: 81_000 })));
});

test("a stopped run counts what finished and names what failed", () => {
  expect(renderEnd(states, view({ stopped: true, now: 12_340 }))).toEndWith(
    "\nStopped after 12.3s with 2 of 5 suites finished, 1 failed: typecheck\n",
  );

  expect(renderEnd(states.slice(0, 2), view({ stopped: true }))).toBe(
    "\nStopped after 42.0s with 1 of 2 suites finished\n",
  );
});

test("the live view needs a terminal that can move the cursor", () => {
  const tty = { isTTY: true, columns: 120 } as NodeJS.WriteStream;
  const pipe = { isTTY: false } as unknown as NodeJS.WriteStream;

  expect(liveView(pipe, {})).toBeUndefined();
  expect(liveView(tty, { TERM: "dumb" })).toBeUndefined();
  expect(liveView(tty, { HOME: home })).toMatchObject({ color: true, home });
  expect(liveView(tty, { NO_COLOR: "1" })?.color).toBe(false);
  expect(liveView(tty, {})?.columns()).toBe(120);
});
