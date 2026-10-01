import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestText, hideCheckText } from "./digest.ts";
import { removeTemporary } from "../test/process.ts";

const fixture = join(import.meta.dir, "fixture");
let temporary: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-eval-digest-"));
});

afterEach(async () => {
  await removeTemporary(temporary);
});

test("digest matches the Python golden byte for byte", () => {
  const expected = readFileSync(join(fixture, "expected-digest.txt"), "utf8").replace(/^Full transcript: .*\n/u, `Full transcript: ${realpathSync(join(fixture, "transcript.jsonl"))}\n`);
  expect(digestText(join(fixture, "transcript.jsonl"))).toBe(expected);
});

test("hide check matches the Python golden byte for byte", () => {
  expect(hideCheckText(join(fixture, "hide"), join(fixture, "canary.txt"), join(fixture, "transcript.jsonl"))).toBe(readFileSync(join(fixture, "expected-hide.txt"), "utf8"));
});

test("digest throws when the transcript reader adds a note", () => {
  const path = join(temporary, "invalid.jsonl");
  writeFileSync(path, Buffer.from([255]));

  expect(() => digestText(path)).toThrow(`${path} is unavailable`);
  expect(() => digestText(join(temporary, "missing.jsonl"))).toThrow("is unavailable");
});

test("digest uses the real transcript path and preserves null and boolean labels", () => {
  const path = join(temporary, "transcript.jsonl");
  const link = join(temporary, "link.jsonl");
  writeFileSync(path, [
    { type: "system", subtype: "permission_denied", tool_name: null, tool: "Bash" },
    { type: "assistant", message: { content: [{ type: "tool_use", id: null, name: true }, { type: "tool_result", tool_use_id: null, is_error: [], content: { alpha: [false, 2, "é"] } }] } },
    { type: "result", result: null },
  ].map((event) => JSON.stringify(event)).join("\n"));

  symlinkSync(path, link);

  expect(digestText(link)).toBe(`Full transcript: ${realpathSync(path)}\npermission_denied None\ntool_use True id=None\ntool_result True tool_use_id=None\n{"alpha": [false, 2, "é"]}\nAgent's final reply:\n\n`);
});

test("hide check splits Python line separators and uses Unicode name boundaries", () => {
  const hide = join(temporary, "hide");
  const canary = join(temporary, "canary");
  const transcript = join(temporary, "transcript.jsonl");
  const separators = ["\n", "\r", "\r\n", "\v", "\f", "\x1c", "\x1d", "\x1e", "\x85", "\u2028", "\u2029"];

  writeFileSync(hide, "\u0085rg\u0085\n");
  writeFileSync(canary, "");
  writeFileSync(transcript, [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "lookup", name: "Bash", input: { command: "which rg" } }, { type: "tool_use", id: "other", name: "Bash", input: { command: "which érg" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "lookup", content: separators.map((separator, index) => `/not-here/${index}//./rg/.${separator}`).join("") }, { type: "tool_result", tool_use_id: "other", content: "/not-here/other/rg" }] } },
  ].map((event) => JSON.stringify(event)).join("\n"));

  const result = hideCheckText(hide, canary, transcript);
  expect(result).toStartWith("LEAKED rg\n");
  for (const [index] of separators.entries()) expect(result).toContain(`  reachable at: /not-here/${index}//./rg/.\n`);
  expect(result).not.toContain("reachable at: /not-here/other/rg");
  expect(result).not.toContain("command: which érg");
});
