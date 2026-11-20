import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { sessionsMachine } from "../test/sessions-fixture.ts";
import { sessionLines } from "./ledger.ts";
import { scanSessions } from "./scan.ts";
import { claudeTranscripts, firstLine, hostDirs, lines } from "./transcripts.ts";

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

test("first line comes back whole past 64 KiB, null without a newline, from 64 KiB on a short one", () => {
  const long = Buffer.alloc(100 * 1024, "z");
  const longPath = file(Buffer.concat([long, Buffer.from("\n{}\n")]));
  expect(firstLine(longPath, long.length + 4)?.equals(long)).toBe(true);

  const bare = Buffer.from('{"type":"unterminated"}');
  expect(firstLine(file(bare), bare.length)).toBeNull();
  expect(firstLine(file(Buffer.alloc(0)), 0)).toBeNull();

  const short = Buffer.from('{"type":"first"}');
  const big = Buffer.concat([short, Buffer.from("\n"), Buffer.alloc(8 * MIB, "w")]);
  const bigPath = file(big);

  const alloc = Buffer.alloc.bind(Buffer);
  let largest = 0;
  const spy = spyOn(Buffer, "alloc").mockImplementation((size, fill, encoding) => {
    largest = Math.max(largest, size);
    return alloc(size, fill, encoding);
  });

  cleanup.push(() => spy.mockRestore());

  expect(firstLine(bigPath, big.length)?.equals(short)).toBe(true);
  expect(largest).toBeGreaterThan(0);
  expect(largest).toBeLessThanOrEqual(64 * 1024);
});

test("a Workflow agent file folds into its session, and its journal is never a transcript", async () => {
  const m = await sessionsMachine();
  cleanup.push(m.close);

  const fixture = () => sessionLines(m.store).find((line) => line.session === "claude-fixture")!;
  const before = fixture().tokens;

  const workflow = join(dirname(m.claude), "claude-fixture/subagents/workflows/wf_one");
  const agent = join(workflow, "agent-two.jsonl");
  const journal = join(workflow, "journal.jsonl");
  const record = {
    type: "assistant",
    sessionId: "claude-fixture",
    agentId: "two",
    attributionAgent: "workflow-subagent",
    timestamp: "2026-11-07T10:05:00.000Z",
    message: {
      id: "msg_workflow_two",
      model: "claude-sonnet-5-5",
      role: "assistant",
      content: [{ type: "text", text: "done" }],
      usage: { input_tokens: 40, output_tokens: 2 },
    },
  };

  mkdirSync(workflow, { recursive: true });
  writeFileSync(agent, `${JSON.stringify(record)}\n`);
  writeFileSync(journal, `${JSON.stringify({ ...record, type: "journal" })}\n`);

  const dirs = hostDirs(m.env);
  await scanSessions(m.plans, dirs);

  expect(fixture().tokens).toBe(before + 42);
  expect(fixture().stats!.subagents).toBe(2);

  const listed = claudeTranscripts(dirs.claude);
  expect(listed).toContainEqual({
    path: agent,
    host: "claude",
    session: "claude-fixture",
    subagent: true,
  });

  expect(listed.map((each) => each.path)).not.toContain(journal);
  expect(await scanSessions(m.plans, dirs)).toEqual({ scanned: 0, changed: 0 });
});
