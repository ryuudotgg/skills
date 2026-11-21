import { readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export type Test = { name: string; passed: number; failed: number };
export type Tests = ReadonlyMap<string, Test>;
export type Report = ReadonlyMap<string, Tests>;

export type Rerunnable = {
  first(report: string): string[];
  rerun(report: string, file: string): string[];
};

// Without bun's isolation a leftover from one file can fail a test in another, which then passes alone.
const isolating = /^--(parallel(=\d+)?|isolate)$/;
const understood = /^--(parallel(=\d+)?|isolate|timeout=\d+|max-concurrency=\d+)$/;

function reporter(report: string): string[] {
  return ["--reporter=junit", `--reporter-outfile=${report}`];
}

export function rerunnable(argv: readonly string[]): Rerunnable | undefined {
  let start = 0;
  if (argv[0] === "env") {
    start = 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[start] ?? "")) start += 1;
  }

  if (basename(argv[start] ?? "") !== "bun" || argv[start + 1] !== "test") return undefined;

  const head = argv.slice(0, start + 2);
  const rest = argv.slice(start + 2);
  const flags = rest.filter((arg) => arg.startsWith("-"));
  if (!flags.every((flag) => understood.test(flag))) return undefined;
  if (!flags.some((flag) => isolating.test(flag))) return undefined;

  const alone = flags.map((flag) => (flag.startsWith("--parallel") ? "--parallel=1" : flag));
  return {
    first: (report) => [...head, ...reporter(report), ...rest],
    rerun: (report, file) => [...head, ...reporter(report), ...alone, file],
  };
}

function elements(node: Bun.XML.Node): Bun.XML.Node[] {
  return node.children.filter(
    (child): child is Bun.XML.Node => typeof child === "object" && "name" in child,
  );
}

function collect(
  node: Bun.XML.Node,
  chain: readonly string[],
  cwd: string,
  report: Map<string, Map<string, Test>>,
): void {
  for (const child of elements(node)) {
    const { name = "", file, line = "" } = child.attributes;
    if (child.name === "testsuite") collect(child, [...chain, name], cwd, report);
    if (child.name !== "testcase" || file === undefined) continue;

    const outcomes = new Set(elements(child).map((outcome) => outcome.name));
    if (outcomes.has("skipped")) continue;

    const path = resolve(cwd, file);
    const tests = report.get(path) ?? new Map<string, Test>();
    const id = JSON.stringify([line, ...chain, name]);
    const title = [...chain, name].join(" > ").replaceAll(/\s+/g, " ");
    const test = tests.get(id) ?? { name: title, passed: 0, failed: 0 };
    if (outcomes.has("failure") || outcomes.has("error")) test.failed += 1;
    else test.passed += 1;

    report.set(path, tests.set(id, test));
  }
}

export function parseReport(xml: string, cwd: string): Report | undefined {
  let root: Bun.XML.Node;
  try {
    root = Bun.XML.parse(xml, { compact: false });
  } catch {
    return undefined;
  }

  const report = new Map<string, Map<string, Test>>();
  for (const file of elements(root)) collect(file, [], cwd, report);

  return report;
}

export async function readReport(path: string, cwd: string): Promise<Report | undefined> {
  try {
    return parseReport(await readFile(path, "utf8"), cwd);
  } catch {
    return undefined;
  }
}

export function failedTests(tests: Tests): string[] {
  return [...tests].filter(([, test]) => test.failed > 0).map(([id]) => id);
}

export function failingFiles(report: Report): [file: string, tests: Tests][] {
  return [...report].filter(([, tests]) => failedTests(tests).length > 0);
}

// Bun's junit report leaves out a file that failed to load, so its summary is the only count of every failure.
export function namesEveryFailure(report: Report, run: { code: number; stderr: string }): boolean {
  const named = failingFiles(report)
    .flatMap(([, tests]) => [...tests.values()])
    .reduce((total, test) => total + test.failed, 0);

  if (run.code === 0 || named === 0) return false;

  const summary = Bun.stripANSI(run.stderr);
  const counted = [...summary.matchAll(/^ (\d+) fail$/gm)].at(-1)?.[1];
  return Number(counted) === named && !/^ \d+ errors?$/m.test(summary);
}

export function flakyTests(first: Tests, rerun: Tests | undefined): string[] {
  return [...first]
    .filter(([id, before]) => {
      const after = rerun?.get(id);
      return (
        before.failed > 0 &&
        after !== undefined &&
        after.failed === 0 &&
        after.passed >= before.passed + before.failed
      );
    })
    .map(([, test]) => test.name);
}
