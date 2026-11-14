import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digestText, hideCheckText } from "./digest.ts";

const fixture = join(import.meta.dir, "fixture");
let temporary: string;

beforeEach(() => {
  temporary = mkdtempSync(join(tmpdir(), "skills-eval-digest-"));
});

afterEach(() => {
  rmSync(temporary, { recursive: true, force: true });
});

test("digest matches its golden", () => {
  const expected = readFileSync(join(fixture, "expected-digest.txt"), "utf8").replace(
    /^Full transcript: .*\n/u,
    `Full transcript: ${realpathSync(join(fixture, "transcript.jsonl"))}\n`,
  );

  expect(digestText(join(fixture, "transcript.jsonl"))).toBe(expected);
});

test("hide check matches its golden", () => {
  expect(
    hideCheckText(
      join(fixture, "hide"),
      join(fixture, "canary.txt"),
      join(fixture, "transcript.jsonl"),
    ),
  ).toBe(readFileSync(join(fixture, "expected-hide.txt"), "utf8"));
});

test("digest throws when the transcript reader adds a note", () => {
  const path = join(temporary, "invalid.jsonl");
  writeFileSync(path, Buffer.from([255]));

  expect(() => digestText(path)).toThrow(`${path} is unavailable`);
  expect(() => digestText(join(temporary, "missing.jsonl"))).toThrow("is unavailable");
});

test("digest uses the real transcript path and JSON literals for null and boolean labels", () => {
  const path = join(temporary, "transcript.jsonl");
  const link = join(temporary, "link.jsonl");
  writeFileSync(
    path,
    [
      { type: "system", subtype: "permission_denied", tool_name: null, tool: "Bash" },
      { type: "system", subtype: "permission_denied", tool_name: false },
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: null, name: true },
            {
              type: "tool_result",
              tool_use_id: null,
              is_error: [],
              content: { alpha: [false, 2, "é"] },
            },
          ],
        },
      },
      { type: "result", result: null },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );

  symlinkSync(path, link);

  expect(digestText(link)).toBe(
    `Full transcript: ${realpathSync(path)}\npermission_denied null\npermission_denied false\ntool_use true id=null\ntool_result true tool_use_id=null\n{"alpha":[false,2,"é"]}\nAgent's final reply:\n\n`,
  );
});

test("hide check splits at every Unicode line break and uses Unicode name boundaries", () => {
  const hide = join(temporary, "hide");
  const canary = join(temporary, "canary");
  const transcript = join(temporary, "transcript.jsonl");
  const separators = ["\n", "\r", "\r\n", "\v", "\f", "\u0085", "\u2028", "\u2029"];

  writeFileSync(hide, "\u00a0rg\u00a0\n");
  writeFileSync(canary, "");
  writeFileSync(
    transcript,
    [
      {
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "lookup", name: "Bash", input: { command: "which rg" } },
            { type: "tool_use", id: "other", name: "Bash", input: { command: "which érg" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "lookup",
              content: separators
                .map((separator, index) => `/not-here/${index}//./rg/.${separator}`)
                .join(""),
            },
            { type: "tool_result", tool_use_id: "other", content: "/not-here/other/rg" },
          ],
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );

  const result = hideCheckText(hide, canary, transcript);
  expect(result).toStartWith("LEAKED rg\n");

  for (const [index] of separators.entries())
    expect(result).toContain(`  reachable at: /not-here/${index}//./rg/.\n`);

  expect(result).not.toContain("reachable at: /not-here/other/rg");
  expect(result).not.toContain("command: which érg");
});

function lookupCheck(command: string, content: string, isError: boolean): string {
  const hide = join(temporary, "hide");
  const canary = join(temporary, "canary");
  const transcript = join(temporary, "transcript.jsonl");
  writeFileSync(hide, "codex\n");
  writeFileSync(canary, "");
  writeFileSync(
    transcript,
    [
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", id: "lookup", name: "Bash", input: { command } }],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "lookup", is_error: isError, content }],
        },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
  );

  return hideCheckText(hide, canary, transcript);
}

test("hide check leaves a denied lookup unchecked", () => {
  const result = lookupCheck(
    "which codex",
    "Claude requested permissions to use Bash, but you haven't granted it yet.",
    true,
  );

  expect(result.split("\n")[0]).toBe("UNCHECKED codex");

  const quoted = lookupCheck(
    "which codex || echo 'codex not found'",
    "This Bash command contains multiple operations. The following part requires approval: which codex || echo 'codex not found'",
    true,
  );

  expect(quoted.split("\n")[0]).toBe("UNCHECKED codex");
});

test("hide check reads only exit code 1 as an empty miss", () => {
  expect(lookupCheck("which codex", "Exit code 130", true).split("\n")[0]).toBe("UNCHECKED codex");
  expect(lookupCheck("which codex", "Exit code 1\n", true).split("\n")[0]).toBe("HIDDEN codex");
});

test("hide check reads an empty miss only from a command that is one lookup", () => {
  for (const command of ["test -x foo && which codex", "command -v opencode && command -v codex"])
    expect(lookupCheck(command, "Exit code 1", true).split("\n")[0]).toBe("UNCHECKED codex");

  for (const command of ["command -v codex\n", "command -v codex;", "which codex opencode"])
    expect(lookupCheck(command, "Exit code 1", true).split("\n")[0]).toBe("HIDDEN codex");

  expect(lookupCheck("which codex 2>/dev/null", "Exit code 1", true).split("\n")[0]).toBe(
    "HIDDEN codex",
  );
});

test("hide check leaves a resolving lookup unchecked and hides an empty miss", () => {
  expect(lookupCheck("command -v codex", "codex", false).split("\n")[0]).toBe("UNCHECKED codex");

  expect(lookupCheck("command -v codex", "alias codex='npx codex'", false).split("\n")[0]).toBe(
    "UNCHECKED codex",
  );

  expect(lookupCheck("command -v codex", "Exit code 1", true).split("\n")[0]).toBe("HIDDEN codex");
});
