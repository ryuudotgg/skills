import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lines } from "./transcripts.ts";

const MIB = 1024 * 1024;

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

function file(content: Buffer): string {
  const dir = mkdtempSync(join(tmpdir(), "skills-lines-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));

  const path = join(dir, "transcript.jsonl");
  writeFileSync(path, content);
  return path;
}

test("a line that spans several reads is yielded whole, and an unterminated tail never is", () => {
  const parts = ['{"type":"first"}', "x".repeat(9 * MIB), '{"type":"third"}'];
  const content = Buffer.from(`${parts.join("\n")}\n{"type":"unterminated`);
  const path = file(content);

  const expected: [Buffer, number][] = [];

  let end = 0;
  for (const part of parts) {
    end += Buffer.byteLength(part) + 1;
    expected.push([Buffer.from(part), end]);
  }

  const afterFirst = expected[0]![1];
  expect([...lines(path, 0, content.length)]).toEqual(expected);
  expect([...lines(path, afterFirst, content.length)]).toEqual(expected.slice(1));
});

test("copies a long line once", () => {
  const line = Buffer.alloc(40 * MIB, "y");
  const path = file(Buffer.concat([line, Buffer.from("\n")]));

  const concat = Buffer.concat.bind(Buffer);
  let copied = 0;
  const spy = spyOn(Buffer, "concat").mockImplementation((list, totalLength) => {
    const joined = concat(list, totalLength);
    copied += joined.length;
    return joined;
  });

  cleanup.push(() => spy.mockRestore());

  const read = [...lines(path, 0, line.length + 1)];
  expect(read.length).toBe(1);
  expect(read[0]![1]).toBe(line.length + 1);
  expect(read[0]![0].equals(line)).toBe(true);
  expect(copied).toBeLessThan(80 * MIB);
});
