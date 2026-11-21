import { expect, test } from "bun:test";
import { Glob } from "bun";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = join(import.meta.dir, "..");
const settled = ["read.test.ts", "read-faults.test.ts", "hub/sync.test.ts"];

const CLOCK = /now\(\)|\.ms\b|elapsed|took|started|baseline|duration/i;
const LITERAL_LIMIT = /^\s*\.toBeLessThan(?:OrEqual)?\(\s*\d[\d_]*(?:\.\d+)?\s*,?\s*\)/;

function closing(text: string, open: number): number {
  let depth = 0;
  for (let at = open; at < text.length; at += 1) {
    if (text[at] === "(") depth += 1;
    if (text[at] === ")") depth -= 1;
    if (depth === 0) return at;
  }

  return text.length;
}

function elapsedBounds(text: string): number[] {
  const lines: number[] = [];
  for (const call of text.matchAll(/\bexpect\(/g)) {
    const open = call.index + call[0].length - 1;
    const close = closing(text, open);
    const bounded =
      CLOCK.test(text.slice(open + 1, close)) && LITERAL_LIMIT.test(text.slice(close + 1));

    if (bounded) lines.push(text.slice(0, call.index).split("\n").length);
  }

  return lines;
}

const assertion = (inside: string, matcher: string) => `expect(${inside}).${matcher};`;

test.each([
  ["performance.now() - started", "toBeLessThan(2000)"],
  ["elapsed - baseline", "toBeLessThan(1000)"],
  ["first.took", "toBeLessThan(2000)"],
  ["Date.now() - began", "toBeLessThanOrEqual(7_000)"],
  ["result.ms", "toBeLessThan(500)"],
  ["run.durationSeconds", "toBeLessThan(2.0)"],
  ["\n  performance.now() - started,\n", "toBeLessThan(2000)"],
])("refuses expect(%s).%s", (inside, matcher) => {
  expect(elapsedBounds(`const first = 1;\n${assertion(inside, matcher)}\n`)).toEqual([2]);
});

test.each([
  ["budget.bandwidth", "toBeLessThan(227)"],
  ["result.msg.length", "toBeLessThan(80)"],
  ["large.took / small.took", "toBeLessThan(4 * growth)"],
  ["performance.now() - started", "toBeGreaterThan(0)"],
])("allows expect(%s).%s", (inside, matcher) => {
  expect(elapsedBounds(assertion(inside, matcher))).toEqual([]);
});

test("no test outside the settled files holds an elapsed bound", () => {
  const files = [...new Glob("**/*.test.ts").scanSync(source)].sort();
  expect(files).toEqual(expect.arrayContaining(settled));

  const found = files
    .filter((file) => !settled.includes(file))
    .flatMap((file) =>
      elapsedBounds(readFileSync(join(source, file), "utf8")).map((line) => `${file}:${line}`),
    );

  expect(found).toEqual([]);
});
