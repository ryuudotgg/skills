import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as scan from "./comment-scan.ts";
import * as patch from "./payload.ts";
import { check } from "./post-tool-use.ts";
import {
  basename,
  codePointOrder,
  dirname,
  joinPath,
  jsonBlock,
  pyIsSpace,
  pyLstrip,
  pyRstrip,
  pyStrip,
  splitext,
  splitlines,
  textMode,
} from "./python-text.ts";
import { SequenceMatcher } from "./sequence-matcher.ts";
import { fixtureGit } from "../test/fixtures.ts";
import { startCommand, suiteEnvironment } from "../test/process.ts";
import { hooks } from "../areas/hooks.ts";

const directories: string[] = [];
const bin = resolve(import.meta.dir, "../../skills/playbook/bin/skills");

function temporary(): string {
  const directory = mkdtempSync(join(tmpdir(), "skills-edit-"));
  directories.push(directory);
  return directory;
}

afterEach(() => {
  delete scan.BY_EXT[".bats"];

  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function put(path: string, text: string): void {
  writeFileSync(path, text);
}

function write(tool: string, path: string, fields: Record<string, unknown> = {}) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: tool,
    tool_input: { file_path: path, ...fields },
  };
}

function hook(payload: unknown): string | undefined {
  return check(payload, { AGENT_HOOKS: "1" });
}

function on_disk(
  tool: string,
  name: string,
  fileText: string,
  fields: Record<string, unknown> = {},
): string | undefined {
  const path = join(temporary(), name);
  put(path, fileText);
  if (tool === "Write") fields = { content: fileText };

  return hook(write(tool, path, fields));
}

function patchPayload(body: string, cwd: string) {
  return {
    hook_event_name: "PostToolUse",
    tool_name: "apply_patch",
    cwd,
    tool_input: { command: "*** Begin Patch\n" + body + "*** End Patch" },
  };
}

function range(start: number, stop?: number, step = 1): number[] {
  if (stop === undefined) [start, stop] = [0, start];

  return Array.from(
    { length: Math.max(0, Math.ceil((stop - start) / step)) },
    (_, index) => start + index * step,
  );
}

function decodeLiteral(body: string): string {
  let text = "";
  for (let index = 0; index < body.length; index++) {
    const char = body[index]!;
    if (char !== "\\") {
      text += char;
      continue;
    }

    const escape = body[++index]!;
    const short: Record<string, string> = {
      n: "\n",
      r: "\r",
      t: "\t",
      b: "\b",
      f: "\f",
      v: "\v",
      "0": "\0",
    };

    if (escape === "\n") continue;
    if (escape === "\r") {
      if (body[index + 1] === "\n") index++;
      continue;
    }

    if (escape === "x" || escape === "u") {
      const braces = escape === "u" && body[index + 1] === "{";
      const start = index + (braces ? 2 : 1);
      const end = braces ? body.indexOf("}", start) : start + (escape === "x" ? 2 : 4);
      text += String.fromCodePoint(Number.parseInt(body.slice(start, end), 16));
      index = braces ? end : end - 1;
    } else text += short[escape] ?? escape;
  }

  return text;
}

function multilineLiterals(source: string): string[] {
  const texts: string[] = [];

  let previous = "";
  for (let index = 0; index < source.length; index++) {
    const quote = source[index]!;
    if (quote === "/" && "=(,:![".includes(previous) && previous !== "") {
      let bracket = false;
      while (++index < source.length) {
        const char = source[index]!;
        if (char === "\\") index++;
        else if (char === "[") bracket = true;
        else if (char === "]") bracket = false;
        else if (char === "/" && !bracket) break;
      }
    } else if (quote === '"' || quote === "'" || quote === "`") {
      const start = index + 1;

      while (++index < source.length)
        if (source[index] === "\\") index++;
        else if (source[index] === quote) break;

      const body = source.slice(start, index);
      if (quote !== "`" || !body.includes("${")) {
        const text = decodeLiteral(body);
        if (text.includes("\n")) texts.push(text);
      }
    }

    if (!/\s/.test(quote)) previous = quote;
  }

  return texts;
}

async function cli(input: string, overrides: NodeJS.ProcessEnv = {}): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...suiteEnvironment(), AGENT_HOOKS: "1", ...overrides };
  delete env.AGENT_HOOKS_SKIP;
  const { child, result } = startCommand([bin, "hook", "post-tool-use"], {
    cwd: import.meta.dir,
    env,
    input: true,
  });

  child.stdin!.end(input);
  const output = await result;
  expect(output.code).toBe(0);
  expect(output.stderr).toBe("");

  return output.stdout;
}

describe("NoComments", () => {
  test("test_unclosed_jsx_block_reports_only_opener", () => {
    const text = "{/* keep */ }\nexport default function App() {}\nconst x = 1;\n";
    const found = scan.commentLines(text, scan.BY_EXT[".tsx"]!);
    expect(found.map(([, line]) => line)).toEqual(["{/* keep */ }"]);
  });

  test("test_lua_block_comment_reports_its_span", () => {
    const text = "local a = 1\n--[[ narration\nstill narration\n]]\nlocal b = 2\n";
    const found = scan.commentLines(text, scan.BY_EXT[".lua"]!);
    expect(found.map(([, line]) => line)).toEqual(["--[[ narration", "still narration", "]]"]);
  });

  test("test_haskell_block_comment_reports_its_span", () => {
    const text = "x = 1\n{- narration\nstill narration\n-}\ny = 2\n";
    const found = scan.commentLines(text, scan.BY_EXT[".hs"]!);
    expect(found.map(([, line]) => line)).toEqual(["{- narration", "still narration", "-}"]);
  });

  test("test_php_attribute_is_not_a_comment", () => {
    const text = '#[Route("/home")]\n# narration\n';
    const found = scan.commentLines(text, scan.BY_EXT[".php"]!);
    expect(found.map(([, line]) => line)).toEqual(["# narration"]);
  });

  test("test_haskell_language_pragma_is_not_a_comment", () => {
    const text = "{-# LANGUAGE OverloadedStrings #-}\n";
    const found = scan.commentLines(text, scan.BY_EXT[".hs"]!);
    expect(found).toEqual([]);
  });

  test("test_comment_lines_only_reports_comment_spans", () => {
    const texts = multilineLiterals(readFileSync(import.meta.path, "utf8"));
    const specs = new Set([...Object.values(scan.BY_EXT), ...Object.values(scan.BY_NAME)]);

    let total = 0;
    for (const text of texts)
      for (const spec of specs) {
        const spans = new Set<number>();
        const lines = text.split("\n");

        let index = 0;
        while (index < lines.length) {
          const stripped = pyStrip(lines[index]!);
          const pair = spec.blocks.find(([opener]) => stripped.startsWith(opener));
          if (!pair || stripped.slice(pair[0].length).includes(pair[1])) {
            index += 1;
            continue;
          }

          const foundEnd = lines.findIndex((line, next) => next > index && line.includes(pair[1]));
          const end = foundEnd === -1 ? index : foundEnd;
          for (const line of range(index + 1, end + 2)) spans.add(line);
          index = end + 1;
        }

        const found = scan.commentLines(text, spec);
        total += found.length;

        for (const [lineNumber, line] of found)
          expect(
            spec.markers.some((marker) => line.startsWith(marker)) ||
              spec.blocks.some(([opener]) => line.startsWith(opener)) ||
              spans.has(lineNumber),
          ).toBe(true);
      }

    expect(total).toBeGreaterThan(0);
  });

  test("test_dangling_block_openers_do_not_report_source", () => {
    const spec = scan.BY_EXT[".ts"]!;
    for (const text of [
      "const x = 1; /* dangling\nexport function f() {}\nconst y = 2;\n",
      "/* a */ /* b\nexport function g() {}\nconst z = 3;\n",
    ]) {
      const found = scan.commentLines(text, spec).map(([, line]) => line);
      expect(found.map((line) => line.startsWith("export function")).some(Boolean)).toBeFalsy();
      expect(found.map((line) => line.startsWith("const ")).some(Boolean)).toBeFalsy();
    }
  });

  test("test_write_with_narration_blocks", () => {
    const out = hook(
      write("Write", "/repo/src/a.ts", { content: "// Phase 1: add cards\nconst a = 1;\n" }),
    );

    expect(out).toBeDefined();
    expect(out!).toContain("Phase 1");
  });

  test("test_clean_write_passes", () => {
    expect(
      hook(
        write("Write", "/repo/src/a.ts", {
          content: "const a = 1;\nconst url = 'http://x/y'; // not a comment line\n",
        }),
      ),
    ).toBeUndefined();
  });

  test("test_edit_flags_only_new_comment_lines", () => {
    const out = hook(
      write("Edit", "/repo/src/a.py", {
        old_string: "# kept\nx = 1\n",
        new_string: "# kept\n# added here\nx = 2\n",
      }),
    );

    expect(out!).toContain("added here");
    expect(out!).not.toContain("kept");
  });

  test("test_edit_reports_the_added_copy_not_its_twin", () => {
    const file_text = "# dup\nx = 1\ny = 2\n# dup\nz = 3\n";
    const out = on_disk("Edit", "a.py", file_text, {
      old_string: "y = 2\n",
      new_string: "y = 2\n# dup\n",
    });

    expect(
      splitlines(out!)
        .filter((line) => line.startsWith("  "))
        .map((line) => line).length,
    ).toEqual(1);

    expect(scan.added(file_text, "y = 2\n", "y = 2\n# dup\n", scan.BY_EXT[".py"]!)).toEqual([
      [4, "# dup"],
    ]);
  });

  test("test_edit_reports_comment_duplicated_out_of_its_anchor", () => {
    const file_text = "# keep\nx = 1\n# keep\n";
    const out = on_disk("Edit", "a.py", file_text, {
      old_string: "# keep\nx = 1\n",
      new_string: "# keep\nx = 1\n# keep\n",
    });

    expect(out).toBeDefined();
    expect(
      splitlines(out!)
        .filter((line) => line.startsWith("  "))
        .map((line) => line).length,
    ).toEqual(1);
  });

  test("test_write_reports_only_the_comments_it_introduces", async () => {
    const repo = join(temporary(), "repo");
    mkdirSync(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-q"]);

    const path = join(repo, "a.py");
    put(path, "# keep\nx = 1\n");
    await fixtureGit(repo, ["add", "a.py"]);

    await fixtureGit(repo, ["commit", "-q", "-m", "init"]);
    const grown = "# keep\nx = 1\n# added\ny = 2\n";
    put(path, grown);
    const out = hook(write("Write", path, { content: grown }));
    expect(
      splitlines(out!)
        .filter((line) => line.startsWith("  "))
        .map((line) => pyStrip(line)),
    ).toEqual(["a.py: # added"]);

    const rewritten = "# keep\ny = 2\n";
    put(path, rewritten);
    expect(hook(write("Write", path, { content: rewritten }))).toBeUndefined();
  });

  test("test_multiedit_reports_the_comments_it_introduces", async () => {
    const repo = join(temporary(), "repo");
    mkdirSync(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-q"]);

    const path = join(repo, "a.py");
    put(path, "# kept\nx = 1\n");
    await fixtureGit(repo, ["add", "a.py"]);

    await fixtureGit(repo, ["commit", "-q", "-m", "init"]);
    const grown = "# kept\nx = 1\n# added\ny = 2\n";
    put(path, grown);
    const out = hook(write("MultiEdit", path, { content: grown }));
    expect(
      splitlines(out!)
        .filter((line) => line.startsWith("  "))
        .map((line) => pyStrip(line)),
    ).toEqual(["a.py: # added"]);
  });

  test("a MultiEdit edits array reads the file from disk against HEAD", async () => {
    const repo = join(temporary(), "repo");
    mkdirSync(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-q"]);

    const path = join(repo, "a.py");
    put(path, "# kept\nx = 1\n");
    await fixtureGit(repo, ["add", "a.py"]);

    await fixtureGit(repo, ["commit", "-q", "-m", "init"]);
    put(path, "# kept\nx = 2\n# added\n");
    const out = hook(
      write("MultiEdit", path, {
        edits: [
          { old_string: "x = 1", new_string: "x = 2" },
          { old_string: "x = 2\n", new_string: "x = 2\n# added\n" },
        ],
      }),
    );

    expect(
      splitlines(out!)
        .filter((line) => line.startsWith("  "))
        .map((line) => pyStrip(line)),
    ).toEqual(["a.py: # added"]);
  });

  test("test_notebook_edit_is_refused_by_both_hooks", () => {
    const reason = hook({
      hook_event_name: "PostToolUse",
      tool_name: "NotebookEdit",
      tool_input: { notebook_path: "/repo/a.ipynb" },
    });

    expect(reason!).toStartWith("NotebookEdit reached this hook");
    expect(reason!.split("NotebookEdit").length).toBe(2);
  });

  test("test_an_uncovered_tool_bearing_a_path_is_scanned_not_refused", () => {
    const directory = temporary();
    const path = join(directory, "a.py");
    put(path, "# narration\nx = 1\n");

    const out = hook(write("EditNotebookCell", path));
    expect(out).toBeDefined();
    expect(out!).toContain("# narration");
    expect(out!).not.toContain("unguarded");
  });

  test("test_an_uncovered_tool_without_a_path_is_refused", () => {
    const reason = hook({
      hook_event_name: "PostToolUse",
      tool_name: "SomeFutureEdit",
      tool_input: { target: "/repo/a.py" },
    });

    expect(reason!).toStartWith("SomeFutureEdit reached this hook");
    expect(reason!.split("SomeFutureEdit").length).toBe(2);
  });

  test("test_matcher_covers_only_the_guarded_tools", () => {
    const matchers = hooks.verbs.find(
      (verb) => verb.name.join(" ") === "hook post-tool-use",
    )!.matcher!;

    expect(matchers).toEqual(patch.MATCHERS);

    for (const matcher of [matchers.claude, matchers.codex]) {
      expect(matcher).toMatch(/^\^\([A-Za-z_]+(?:\|[A-Za-z_]+)*\)\$$/);

      const pattern = new RegExp(matcher);

      for (const name of matcher.slice(2, -2).split("|"))
        expect<readonly string[]>(patch.GUARDED).toContain(name);

      for (const name of ["NotebookEdit", "preEdit", "WriteExtra", "Bashful"])
        expect(pattern.test(name)).toBe(false);
    }

    const claude = new RegExp(matchers.claude);
    for (const name of ["Edit", "MultiEdit", "Write"]) expect(claude.test(name)).toBe(true);
    expect(claude.test("Bash")).toBe(false);

    const codex = new RegExp(matchers.codex);
    for (const name of ["Bash", "apply_patch"]) expect(codex.test(name)).toBe(true);

    for (const name of patch.WRITE_LIKE) expect(patch.GUARDED).toContain(name);

    const writer = readFileSync(resolve(import.meta.dir, "../../scripts/codex-hooks.py"), "utf8");
    const entries = writer.match(/ENTRIES = \([\s\S]*?\n\)/)![0];
    expect(entries.match(/\("PostToolUse",[^\n]+/g)).toEqual([
      `("PostToolUse", "${matchers.codex}", "hook post-tool-use"),`,
    ]);

    const validator = readFileSync(resolve(import.meta.dir, "../../scripts/validate.py"), "utf8");
    expect(validator).toContain(`{"hook post-tool-use": "${matchers.claude}"}`);
  });

  test("test_reindenting_a_comment_is_not_an_addition", () => {
    expect(
      on_disk("Edit", "a.py", "    # kept\nx = 1\n", {
        old_string: "  # kept",
        new_string: "    # kept",
      }),
    ).toBeUndefined();
  });

  test("test_write_reports_a_line_its_edit_exposed_as_a_comment", async () => {
    const repo = join(temporary(), "repo");
    mkdirSync(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-q"]);

    const path = join(repo, "a.py");
    put(path, '"""\n# newly exposed comment\n"""\nx = 1\n');
    await fixtureGit(repo, ["add", "a.py"]);

    await fixtureGit(repo, ["commit", "-q", "-m", "init"]);
    const exposed = "# newly exposed comment\nx = 1\n";
    put(path, exposed);

    const out = hook(write("Write", path, { content: exposed }));
    expect(out).toBeDefined();
    expect(out!).toContain("newly exposed");
  });

  test("test_replacement_text_inside_an_untouched_comment_is_not_added", () => {
    expect(
      on_disk("Edit", "a.py", "# answer = 2\nanswer = 2\n", {
        old_string: "answer = 1",
        new_string: "answer = 2",
      }),
    ).toBeUndefined();

    expect(
      on_disk("Edit", "a.py", "x = 2\n# version 2\n", { old_string: "1", new_string: "2" }),
    ).toBeUndefined();
  });

  test("test_code_edit_inside_a_block_comment_reports_nothing", () => {
    expect(
      on_disk("Edit", "a.ts", "/*\n * kept\n */\nx=2;\n", {
        old_string: " * kept\n */\nx=1;",
        new_string: " * kept\n */\nx=2;",
      }),
    ).toBeUndefined();
  });

  test("test_blank_line_before_an_untouched_comment_is_not_an_addition", () => {
    expect(
      on_disk("Edit", "a.py", "x = 2\n\n# keep\n", {
        old_string: "x = 1\n",
        new_string: "x = 2\n\n",
      }),
    ).toBeUndefined();
  });

  test("test_large_repetitive_write_stays_fast", () => {
    const spec = scan.BY_EXT[".py"]!;
    const middle = "do_it()\n".repeat(8000);
    const body = "# one comment\n" + middle;

    const ends = "a = 0\n# one comment\n" + middle + "z = 0\n";
    const both = "a = 1\n# one comment\n" + middle + "z = 1\n";
    const started = performance.now() / 1000;

    expect(scan.added(body + "do_it()\n", body, body + "do_it()\n", spec)).toEqual([]);
    expect(scan.added(both, ends, both, spec)).toEqual([]);
    expect(performance.now() / 1000 - started).toBeLessThan(2.0);
    const sneaked = "a = 1\n# sneaked in\n" + middle + "z = 1\n";
    expect(scan.added(sneaked, "a = 0\n" + middle + "z = 0\n", sneaked, spec)).toEqual([
      [2, "# sneaked in"],
    ]);

    expect(scan.added(body + "# d\n", body, body + "# d\n", spec)).toEqual([[8002, "# d"]]);
  });

  test("test_insertion_beside_an_untouched_comment_in_a_big_file", () => {
    const spec = scan.BY_EXT[".py"]!;
    const middle = "do_it()\n".repeat(1500);
    const before = "a = 0\n" + middle + "# kept\nz = 0\n";
    const after = "a = 1\n" + middle + "inserted()\n# kept\nz = 1\n";
    expect(scan.added(after, before, after, spec)).toEqual([]);
  });

  test("test_whole_file_reorder_of_distinct_lines_stays_fast", () => {
    const spec = scan.BY_EXT[".py"]!;
    const lines = range(16000).map((index) => `line${index}()`);
    const swapped = [...lines];
    for (const index of range(0, swapped.length - 1, 2))
      [swapped[index]!, swapped[index + 1]!] = [swapped[index + 1]!, swapped[index]!];

    const before = "# c\n" + lines.join("\n") + "\n";
    const after = "# c\n" + swapped.join("\n") + "\n";
    const started = performance.now() / 1000;
    expect(scan.added(after, before, after, spec)).toEqual([]);
    expect(performance.now() / 1000 - started).toBeLessThan(2.0);
  });

  test("test_edit_that_unbalances_a_fence_reports_what_it_exposed", () => {
    const out = on_disk("Edit", "a.ts", "const t = [\n// example\n`;\n", {
      old_string: "const t = `",
      new_string: "const t = [",
    });

    expect(out).toBeDefined();
    expect(out!).toContain("example");
    expect(
      scan.added('x = ""\n# note\n"""\n', 'x = """\n', 'x = ""\n', scan.BY_EXT[".py"]!),
    ).toEqual([[2, "# note"]]);
  });

  test("test_replacement_adding_a_newline_does_not_shift_onto_a_comment", () => {
    expect(
      on_disk("Edit", "a.py", "x = 2\n\n# keep\n", { old_string: "x = 1", new_string: "x = 2\n" }),
    ).toBeUndefined();
  });

  test("test_added_case_table", () => {
    const python = scan.BY_EXT[".py"]!;
    const typescript = scan.BY_EXT[".ts"]!;
    const big = "do_it()\n".repeat(1500);
    const tripleQuote = String.fromCodePoint(34).repeat(3);
    const cases = [
      [
        "twin elsewhere in the file",
        python,
        "# dup\nx = 1\ny = 2\n# dup\nz = 3\n",
        "y = 2\n",
        "y = 2\n# dup\n",
        [[4, "# dup"]],
      ],
      [
        "copy duplicated out of its anchor",
        python,
        "# keep\nx = 1\n# keep\n",
        "# keep\nx = 1\n",
        "# keep\nx = 1\n# keep\n",
        [[3, "# keep"]],
      ],
      [
        "write introduces one comment",
        python,
        "# keep\nx = 1\n# added\ny = 2\n",
        "# keep\nx = 1\n",
        "# keep\nx = 1\n# added\ny = 2\n",
        [[3, "# added"]],
      ],
      [
        "write reintroduces the same text",
        python,
        "# keep\ny = 2\n",
        "# keep\nx = 1\n",
        "# keep\ny = 2\n",
        [],
      ],
      [
        "replacement text sits in a comment",
        python,
        "# answer = 2\nanswer = 2\n",
        "answer = 1",
        "answer = 2",
        [],
      ],
      ["short replacement matches everywhere", python, "x = 2\n# version 2\n", "1", "2", []],
      [
        "code edit inside a block comment",
        typescript,
        "/*\n * kept\n */\nx=2;\n",
        " * kept\n */\nx=1;",
        " * kept\n */\nx=2;",
        [],
      ],
      ["reindent only", python, "    # kept\nx = 1\n", "  # kept", "    # kept", []],
      [
        "reindent across the span boundary",
        python,
        "x = 2\n  # keep\n",
        "x = 1\n",
        "x = 2\n  ",
        [],
      ],
      [
        "blank line added before a comment",
        python,
        "x = 2\n\n# keep\n",
        "x = 1\n",
        "x = 2\n\n",
        [],
      ],
      ["replacement gains a trailing newline", python, "x = 2\n\n# keep\n", "x = 1", "x = 2\n", []],
      [
        "comment merely moved",
        python,
        "x = 1\ny = 2\n# keep\n",
        "# keep\nx = 1\ny = 2\n",
        "x = 1\ny = 2\n# keep\n",
        [],
      ],
      [
        "comment moved and duplicated",
        python,
        "x = 1\n# keep\ny = 2\n# keep\n",
        "# keep\nx = 1\ny = 2\n",
        "x = 1\n# keep\ny = 2\n# keep\n",
        [[4, "# keep"]],
      ],
      [
        "comment moved in a patch",
        python,
        "x = 1\ny = 2\n# keep\n",
        "# keep\nx = 1\ny = 2",
        "x = 1\ny = 2\n# keep",
        [],
      ],
      [
        "patch hunk adds a line inside a string",
        python,
        "# note\nx = 1\nDOC = " +
          String.fromCodePoint(39).repeat(3) +
          "\n# note\n" +
          String.fromCodePoint(39).repeat(3) +
          "\ny = 2\n",
        "DOC = " + String.fromCodePoint(39).repeat(3) + "\n" + String.fromCodePoint(39).repeat(3),
        "DOC = " +
          String.fromCodePoint(39).repeat(3) +
          "\n# note\n" +
          String.fromCodePoint(39).repeat(3),
        [],
      ],
      [
        "patch hunk adds a comment with a twin elsewhere",
        python,
        "# note\nx = 1\ny = 2\n# note\nz = 3\n",
        "y = 2\nz = 3",
        "y = 2\n# note\nz = 3",
        [[4, "# note"]],
      ],
      [
        "statement replaced by a comment",
        python,
        "# gone for now\ny = 2\n",
        "x = 1",
        "# gone for now",
        [[1, "# gone for now"]],
      ],
      ["pure deletion adds nothing", python, "# top\nx = 1\n", "y = 2", "", []],
      [
        "write exposes a string line",
        python,
        "# newly exposed comment\nx = 1\n",
        tripleQuote + "\n# newly exposed comment\n" + tripleQuote + "\nx = 1\n",
        "# newly exposed comment\nx = 1\n",
        [[1, "# newly exposed comment"]],
      ],
      [
        "exposure inside the edited span",
        python,
        "DOC = " + tripleQuote + "\n" + tripleQuote + "\n# note\nx = 1\n",
        "# note\n" + tripleQuote + "\n",
        tripleQuote + "\n# note\n",
        [[3, "# note"]],
      ],
      [
        "edit unbalances a fence, ts",
        typescript,
        "const t = [\n// example\n`;\n",
        "const t = `",
        "const t = [",
        [[2, "// example"]],
      ],
      [
        "edit unbalances a fence, py",
        python,
        "x = " + String.fromCodePoint(34).repeat(2) + "\n# note\n" + tripleQuote + "\n",
        "x = " + tripleQuote + "\n",
        "x = " + String.fromCodePoint(34).repeat(2) + "\n",
        [[2, "# note"]],
      ],
      [
        "decoy copy inside a template literal",
        typescript,
        "const doc = `\n// added\nfoo()\n`;\n// added\nfoo()\n",
        "x",
        "// added\nfoo()",
        [[5, "// added"]],
      ],
      [
        "unchanged comment in the fallback",
        python,
        "# kept\nx = 2\nZZZ\n",
        "# kept\nx = 1",
        "# kept\nx = 2",
        [],
      ],
      [
        "insertion beside an untouched comment",
        python,
        "a = 1\n" + big + "inserted()\n# kept\nz = 1\n",
        "a = 0\n" + big + "# kept\nz = 0\n",
        "a = 1\n" + big + "inserted()\n# kept\nz = 1\n",
        [],
      ],
    ] as const;

    for (const [name, spec, text, old, fresh, want] of cases)
      expect<readonly (readonly [number, string])[]>(
        scan.added(text, old, fresh, spec),
        name,
      ).toEqual(want);
  });

  test("test_block_comment_body_counts", () => {
    const out = hook(
      write("Write", "/repo/src/a.ts", {
        content: "/**\n * Returns the thing.\n */\nexport function f() {}\n",
      }),
    );

    expect(
      splitlines(out!)
        .filter((line) => line.startsWith("  "))
        .map((line) => line).length,
    ).toEqual(3);
  });

  test("test_pragmas_shebang_license_pass", () => {
    const content =
      "#!/usr/bin/env python3\n# noqa: E501\n# type: ignore\n# SPDX-License-Identifier: MIT\n# Copyright (c) 2026 Ryuu\nx = 1\n";

    expect(hook(write("Write", "/repo/a.py", { content: content }))).toBeUndefined();
    const typescript =
      "// eslint-disable-next-line no-console\n// @ts-expect-error bun accepts duplex\nconsole.log(1)\n";

    expect(hook(write("Write", "/repo/a.ts", { content: typescript }))).toBeUndefined();
  });

  test("test_directive_and_license_exemptions_are_per_comment_unit", () => {
    const typescript = scan.BY_EXT[".ts"]!;
    const python = scan.BY_EXT[".py"]!;
    const cases = [
      [
        typescript,
        "/* eslint-disable no-console */\n// narration about the console\nconsole.log(1)\n",
        [[2, "// narration about the console"]],
      ],
      [
        python,
        "# pragmatic caching keeps the tree warm\nx = 1\n",
        [[1, "# pragmatic caching keeps the tree warm"]],
      ],
      [
        typescript,
        "/* global state is shared between workers */\nconst a = 1;\n",
        [[1, "/* global state is shared between workers */"]],
      ],
      [
        typescript,
        "// Copyright (c) 2026 Ryuu\n// narration right below the header\nexport const a = 1;\n",
        [[2, "// narration right below the header"]],
      ],
    ] as const;

    for (const [spec, text, want] of cases)
      expect<readonly (readonly [number, string])[]>(scan.commentLines(text, spec)).toEqual(want);
  });

  test("test_license_block_and_directive_forms_stay_exempt", () => {
    const typescript =
      "/*\n * Copyright (c) 2026 Ryuu\n * MIT\n */\n// narration\nexport const a = 1;\n";

    expect(scan.commentLines(typescript, scan.BY_EXT[".ts"]!)).toEqual([[5, "// narration"]]);
    const directives = [
      [".py", "# pragma: no cover\n"],
      [".py", "# region Parsing helpers\n"],
      [".py", "# endregion\n"],
      [".ts", "/* global $, jQuery */\n"],
      [".ts", "/* istanbul ignore next */\n"],
      [".ts", "// eslint-disable-next-line no-console\n"],
      [".py", "#!/usr/bin/env python3\n"],
      [".py", "# noqa: E501\n"],
      [".py", "# type: ignore\n"],
      [".ts", "/* eslint-disable\n   no-console,\n   no-alert */\n"],
    ] as const;

    for (const [suffix, text] of directives)
      expect(scan.commentLines(text, scan.BY_EXT[suffix]!)).toEqual([]);
  });

  test("test_apache_header_body_stays_exempt", () => {
    const typescript =
      '/*\n * Copyright 2026 Ryuu\n *\n * Licensed under the Apache License, Version 2.0 (the "License");\n * you may not use this file except in compliance with the License.\n * You may obtain a copy of the License at\n *     http://www.apache.org/licenses/LICENSE-2.0\n * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND.\n */\n// narration\nconst a = 1;\n';

    expect(scan.commentLines(typescript, scan.BY_EXT[".ts"]!)).toEqual([[10, "// narration"]]);
  });

  test("test_global_directive_modes_and_multiline_form", () => {
    const typescript = scan.BY_EXT[".ts"]!;
    for (const text of [
      "/* global window: readonly, myGlobal: writable */\nconst a = 1;\n",
      "/* global\n   foo,\n   bar */\nconst a = 1;\n",
      "/* global $, jQuery */\nconst a = 1;\n",
    ])
      expect(scan.commentLines(text, typescript)).toEqual([]);

    const prose = "/* global state is shared between workers */\nconst a = 1;\n";
    expect(scan.commentLines(prose, typescript)).toEqual([
      [1, "/* global state is shared between workers */"],
    ]);
  });

  test("test_jsx_and_html_markers", () => {
    let out = hook(write("Write", "/repo/a.tsx", { content: "<div>\n  {/* header */}\n</div>\n" }));
    expect(out!).toContain("header");
    out = hook(write("Write", "/repo/a.html", { content: "<!-- nav -->\n<nav></nav>\n" }));
    expect(out!).toContain("nav");
  });

  test("test_prose_and_vendored_skip", () => {
    expect(hook(write("Write", "/repo/README.md", { content: "# Title\n" }))).toBeUndefined();
    expect(
      hook(write("Write", "/repo/node_modules/x/a.js", { content: "// x\n" })),
    ).toBeUndefined();
  });

  test("test_string_contents_are_not_comments", () => {
    const typescript = "const sample = `\n// not a comment\n# nor this\n`;\nconst x = 1;\n";
    expect(hook(write("Write", "/repo/a.ts", { content: typescript }))).toBeUndefined();
    const python = 'DOC = """\n# heading in a string\n"""\nx = 1\n';

    expect(hook(write("Write", "/repo/a.py", { content: python }))).toBeUndefined();
    const py2 = "x = 1 << 3\n# after a shift\n";
    expect(hook(write("Write", "/repo/b.py", { content: py2 }))!).toContain("after a shift");

    const shell = "cat > f <<'EOF'\n# inside heredoc\nEOF\n# real comment\n";
    const out = hook(write("Write", "/repo/a.sh", { content: shell }));
    expect(out!).toContain("real comment");
    expect(out!).not.toContain("inside heredoc");
  });

  test("test_edit_reads_lexical_context_from_disk", () => {
    const file_text = "const t = `\n// example after\n`;\n/*\n * body line\n */\nconst x = 1;\n";
    let out = on_disk("Edit", "a.ts", file_text, {
      old_string: "// example before",
      new_string: "// example after",
    });

    expect(out).toBeUndefined();
    out = on_disk("Edit", "a.ts", file_text, {
      old_string: " * old body",
      new_string: " * body line",
    });

    expect(out!).toContain("body line");
  });

  test("test_restored_rebuilds_a_pure_deletion", () => {
    const before = "const t = `\n// narration\n`;\nexport const x = 1;\n";
    const old = "const t = `\n";
    const after = before.replace(old, "");
    expect(scan.restored(after, before, old)).toEqual(before);
  });

  test("test_added_reports_a_comment_exposed_by_a_pure_deletion", () => {
    const committed = "const t = `\n// narration\n`;\nexport const x = 1;\n";
    const old = "const t = `\n";
    const after = committed.replace(old, "");
    const before = scan.restored(after, committed, old);
    expect(scan.added(after, before, after, scan.BY_EXT[".ts"]!)).toEqual([[1, "// narration"]]);
  });

  test("test_pure_deletion_exposing_a_comment_blocks_in_a_git_repo", async () => {
    const repo = join(temporary(), "repo");
    mkdirSync(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-q"]);

    const path = join(repo, "a.ts");
    const before = "const t = `\n// narration\n`;\nexport const x = 1;\n";
    put(path, before);

    await fixtureGit(repo, ["add", "a.ts"]);
    await fixtureGit(repo, ["commit", "-q", "-m", "init"]);
    const old = "const t = `\n";

    put(path, before.replace(old, ""));
    const out = hook(write("Edit", path, { old_string: old, new_string: "" }));
    expect(out).toBeDefined();
    expect(out!).toContain("// narration");
  });

  test("test_pure_deletion_stays_silent_without_a_git_repo", () => {
    const directory = temporary();
    const path = join(directory, "a.ts");
    const old = "const t = `\n";
    put(path, "// narration\n`;\nexport const x = 1;\n");
    expect(hook(write("Edit", path, { old_string: old, new_string: "" }))).toBeUndefined();
  });

  test("test_restored_widens_the_probe_to_the_whole_context", () => {
    const committed = "const start = 1;\n\nconst t = `\n// narration\n`;\n";
    const old = "const t = `\n";
    expect(scan.restored(committed.replace(old, ""), committed, old)).toEqual(committed);
  });

  test("test_restored_declines_a_one_sided_match_off_the_edge", () => {
    expect(scan.restored("\n// kept\n", "run();// kept\n", "run();")).toBeUndefined();
  });

  test("test_restored_accepts_a_one_sided_match_on_the_edge", () => {
    const committed = "const t = `\n// narration\n`;\n";
    const old = "const t = `\n";
    expect(scan.restored(committed.replace(old, ""), committed, old)).toEqual(committed);
  });

  test("test_restored_declines_a_file_too_big_to_diff_precisely", () => {
    const body = range(scan.MATCH_LINE_LIMIT + 1)
      .map((lineNumber) => `const v${lineNumber} = ${lineNumber};\n`)
      .join("");

    const committed = "const t = `\n// narration\n`;\n" + body;
    const old = "const t = `\n";
    expect(scan.restored(committed.replace(old, ""), committed, old)).toBeUndefined();
  });

  test("test_pure_deletion_does_not_report_an_untouched_comment", async () => {
    const repo = join(temporary(), "repo");
    mkdirSync(repo, { recursive: true });
    await fixtureGit(repo, ["init", "-q"]);

    const path = join(repo, "a.ts");
    const before = "// kept narration\nconst remove = 1;\nexport const x = 1;\n";
    put(path, before);

    await fixtureGit(repo, ["add", "a.ts"]);
    await fixtureGit(repo, ["commit", "-q", "-m", "init"]);
    const old = "const remove = 1;\n";
    put(path, before.replace(old, ""));
    expect(hook(write("Edit", path, { old_string: old, new_string: "" }))).toBeUndefined();
  });

  test("test_fences_inside_quotes_and_comments_do_not_open_strings", () => {
    const typescript =
      "const tick = '`';\n// real one\nconst s = \"it's\"; // has ` in trailing comment\n// second real\n";

    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out!).toContain("real one");
    expect(out!).toContain("second real");
  });

  test("test_multiline_pragma_block_exempt_as_a_whole", () => {
    const typescript =
      "/* eslint-disable\n   no-console,\n   no-alert */\n/** @type {import('vite').UserConfig} */\nexport default {};\n// narration\n";

    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out!).toContain("narration");
    expect(out!).not.toContain("no-alert");
    expect(out!).not.toContain("@type");
  });

  test("test_backtick_in_block_comment_does_not_open_string", () => {
    const typescript = "/* uses ` here\n * body */\nconst a = 1;\n// real one\n";
    expect(hook(write("Write", "/repo/a.ts", { content: typescript }))!).toContain("real one");
  });

  test("test_marker_inside_template_literal_does_not_open_string", () => {
    const typescript = "const b = `//cdn.x/a`;\n// narration\n";
    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out).toBeDefined();
    expect(out!).toContain("narration");
  });

  test("test_triple_quote_inside_quoted_string_does_not_open_docstring", () => {
    const python = 'TRIPLE = \'"""\'\n# narration\n';
    const out = hook(write("Write", "/repo/a.py", { content: python }));
    expect(out).toBeDefined();
    expect(out!).toContain("narration");
  });

  test("test_escaped_backslash_before_fence_still_closes_it", () => {
    const typescript = "const p = `a\\\\`;\n// narration\n";
    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out).toBeDefined();
    expect(out!).toContain("narration");
  });

  test("test_escaped_fence_inside_template_does_not_close_it", () => {
    let typescript = "const s = `\\``;\n// narration\n";
    let out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out).toBeDefined();

    expect(out!).toContain("narration");
    typescript = "const s = `a\\`\n// string content\n`;\n// real one\n";
    out = hook(write("Write", "/repo/b.ts", { content: typescript }));
    expect(out!).toContain("real one");
    expect(out!).not.toContain("string content");
  });

  test("test_backtick_in_substitution_string_does_not_close_template", () => {
    const typescript = 'const a = `${"`"}`;\n// narration\n';
    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out).toBeDefined();
    expect(out!).toContain("narration");
  });

  test("test_nested_multiline_substitution_still_closes", () => {
    const typescript = 'const h = `\n  ${x ? `\n  a\n  ` : ""}\n`;\n// real one\n';
    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out).toBeDefined();
    expect(out!).toContain("real one");
  });

  test("test_a_fence_that_never_closes_is_never_opened", () => {
    for (const [label, name, latch] of [
      ["regex literal holding a fence", "a.ts", "const tick = /`/;"],
      ["fence inside a regex character class", "b.ts", "const re = /[`~]/g;"],
      ["division read as a regex", "c.ts", "const n = a /`/ b;"],
      ["bare fence in jsx text", "a.tsx", "<p>a ` b</p>"],
      ["fence behind an escape", "d.ts", "const esc = /\\`/;"],
      ["fence inside a quoted span", "e.ts", 'const q = "`";'],
    ]) {
      const text = latch + "\n// narration\nconst after = 2;\n";
      const out = hook(write("Write", "/repo/" + name, { content: text }));
      expect(out, label).toBeDefined();
      expect(out!, label).toContain("narration");
      expect(out!, label).not.toContain("const after");
    }
  });

  test("test_paired_strays_resync_within_the_bound", () => {
    const bound = scan.RESYNC_BOUND;
    function latched(comment_line: number, literals: boolean) {
      const body = ["const a = /`/;\n"];
      for (const lineNumber of range(2, comment_line))
        body.push(
          literals && lineNumber % 50 === 0
            ? "const lit = `x`;\n"
            : `const f${lineNumber} = ${lineNumber};\n`,
        );

      return body.join("") + "// narration\nconst b = /`/;\n";
    }

    for (const literals of [false, true]) {
      const why = literals ? " with one-line literals in the blind span" : "";
      expect(
        scan
          .commentLines(latched(bound + 2, literals), scan.BY_EXT[".ts"]!)
          .map(([, stripped]) => stripped),
        why,
      ).toEqual(["// narration"]);

      expect(scan.commentLines(latched(bound + 1, literals), scan.BY_EXT[".ts"]!)).toEqual([]);
    }
  });

  test("test_license_block_exempt_as_a_whole", () => {
    const typescript =
      "/*\n * Copyright (c) 2026 Ryuu\n * MIT\n */\nexport const a = 1;\n// narration\n";

    const out = hook(write("Write", "/repo/a.ts", { content: typescript }));
    expect(out!).toContain("narration");
    expect(out!).not.toContain("Copyright");
    expect(out!).not.toContain("*/");
  });

  test("test_shell_shapes_that_are_not_heredocs_stay_unarmed", () => {
    for (const [label, shell] of [
      ["arithmetic shift", "mask=$(( 1 << SHIFT ))\n# narration\n"],
      ["here string", 'cat <<< "hello"\n# narration\n'],
      ["quoted angles", 'echo "a << b"\n# narration\n'],
      ["conflict marker", "<<<<<<< HEAD\n# narration\n"],
      ["nested arithmetic", "x=$(((1<<2)))\n# narration\n"],
    ]) {
      const out = hook(write("Write", "/repo/a.sh", { content: shell }));
      expect(out, label).toBeDefined();
      expect(out!, label).toContain("narration");
    }
  });

  test("test_heredoc_forms_suppress_their_body", () => {
    for (const [label, shell] of [
      ["plain", "cat <<EOF\n# inside\nEOF\n# narration\n"],
      ["tab stripped", "cat <<-EOF\n# inside\n\tEOF\n# narration\n"],
      ["quoted hyphen", "cat <<'EO-F'\n# inside\nEO-F\n# narration\n"],
      ["backslash escaped", "cat <<\\EOF\n# inside\nEOF\n# narration\n"],
    ]) {
      const out = hook(write("Write", "/repo/a.sh", { content: shell }));
      expect(out, label).toBeDefined();
      expect(out!, label).toContain("narration");
      expect(out!, label).not.toContain("inside");
    }
  });

  test("test_only_tab_stripping_heredocs_close_on_an_indented_delimiter", () => {
    const shell = "cat <<EOF\n# inside\n\tEOF\n# still inside\n";
    expect(hook(write("Write", "/repo/a.sh", { content: shell }))).toBeUndefined();
  });

  test("test_unbalanced_double_paren_does_not_hide_a_heredoc", () => {
    const shell = "[[ $s =~ ^((a|b)+)$ ]] && cat <<EOF\n# swallowed\nEOF\n# narration\n";
    const out = hook(write("Write", "/repo/a.sh", { content: shell }));
    expect(out).toBeDefined();
    expect(out!).toContain("narration");
    expect(out!).not.toContain("swallowed");
  });

  test("test_carriage_returns_do_not_latch_a_heredoc", () => {
    const shell = "cat <<EOF\r\n# swallowed\r\nEOF\r\n# narration\r\n";
    const out = hook(write("Write", "/repo/a.sh", { content: shell }));
    expect(out).toBeDefined();
    expect(out!).toContain("narration");
    expect(out!).not.toContain("swallowed");
  });

  test("test_two_heredocs_on_one_line_both_suppress_their_bodies", () => {
    const shell = "cat <<A <<B\n# body of A\nA\n# body of B\nB\n# narration\n";
    const out = hook(write("Write", "/repo/a.sh", { content: shell }));
    expect(out).toBeDefined();

    expect(out!).toContain("narration");
    expect(out!).not.toContain("body of A");
    expect(out!).not.toContain("body of B");
  });

  test("test_expansions_and_escapes_do_not_latch_the_scanner", () => {
    for (const [label, shell] of [
      ["brace replacement", "y=${x//<</lt}\n# narration\n"],
      ["brace prefix strip", "y=${x#*<<}\n# narration\n"],
      ["brace suffix strip", "y=${x%%<<*}\n# narration\n"],
      ["backtick substitution", "x=`cat <<EOF`\n# swallowed\nEOF\n# narration\n"],
      [
        "continuation after the delimiter",
        "cat <<EOF\\\n  | wc -l\n# swallowed\nEOF\n# narration\n",
      ],
      ["delimiter with a trailing space", "cat <<'EOF '\n# swallowed\nEOF \n# narration\n"],
    ]) {
      const out = hook(write("Write", "/repo/a.sh", { content: shell }));
      expect(out, label).toBeDefined();
      expect(out!, label).toContain("narration");
      expect(out!, label).not.toContain("swallowed");
    }
  });

  test("test_heredocs_behind_parens_and_quotes_keep_their_body", () => {
    for (const [label, shell] of [
      [
        "quoted command substitution",
        'x="$(cat <<EOF | tr "a" "b"\n# swallowed\nEOF\n)"\n# narration\n',
      ],
      [
        "substitution closing after the operator",
        "[[ $s =~ ^((a|b)+)$ ]] && cat <<EOF > $(dirname $(pwd))\n# swallowed\nEOF\n# narration\n",
      ],
      ["escaped space before a hash", "echo a\\ #b <<EOF\n# swallowed\nEOF\n# narration\n"],
    ]) {
      const out = hook(write("Write", "/repo/a.sh", { content: shell }));
      expect(out, label).toBeDefined();
      expect(out!, label).toContain("narration");
      expect(out!, label).not.toContain("swallowed");
    }
  });

  test("test_kill_switch", async () => {
    expect(
      await cli(JSON.stringify(write("Write", "/repo/a.ts", { content: "// x\n" })), {
        AGENT_HOOKS: "0",
      }),
    ).toBe("");
  });
});

describe("SpecSelection", () => {
  test("test_a_fresh_spec_equal_to_shell_gets_heredoc_handling", () => {
    scan.BY_EXT[".bats"]! = { markers: ["#"], blocks: [], fences: [], exclude: [] };
    const spec = scan.specFor("/repo/a.bats")!;
    expect(spec).not.toBe(scan.SHELL);
    const found = scan
      .commentLines("cat <<EOF\n# inside\nEOF\n# narration\n", spec)
      .map(([, stripped]) => stripped);

    expect(found).toEqual(["# narration"]);
  });
});

function bash(command: unknown, cwd: string): string | undefined {
  return check(
    { hook_event_name: "PostToolUse", tool_name: "Bash", cwd, tool_input: { command } },
    { AGENT_HOOKS: "1" },
  );
}

describe("CodexPayloads", () => {
  test("shell heredoc apply_patch flags the added comment", () => {
    const directory = temporary();
    put(join(directory, "hello.py"), "# prints hi\nprint('hi')\n");
    const command =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: hello.py\n+# prints hi\n+print('hi')\n*** End Patch\nPATCH";

    const out = check(
      {
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        cwd: directory,
        tool_input: { command },
      },
      { AGENT_HOOKS: "1" },
    );

    expect(out!).toContain("hello.py: # prints hi");
  });

  test("shell commands that apply no patch pass in silence", () => {
    const directory = temporary();
    put(join(directory, "notes.py"), "# narration\n");
    put(join(directory, "hello.py"), "# say hi\n");

    for (const command of [
      "ls -la && git status",
      "cat notes.py",
      "printf '%s\\n' x > /dev/null\n*** Begin Patch\n*** Add File: notes.py\n+# narration\n*** End Patch",
      "cat > docs/apply-patch.md <<'EOF'\n# How apply_patch works\n*** Begin Patch\n*** Add File: hello.py\n+# say hi\n*** End Patch\nEOF",
    ])
      expect(bash(command, directory)).toBeUndefined();
  });

  test("shell apply_patch resolves a cd before it", () => {
    const directory = temporary();
    mkdirSync(join(directory, "sub"));
    put(join(directory, "sub/note.md"), "a \u2014 b\n");
    const command =
      "cd sub && apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: note.md\n+a \u2014 b\n*** End Patch\nPATCH";

    expect(bash(command, directory)!).toContain("note.md contains an em dash");
  });

  test("shell apply_patch scans every patch in one command", () => {
    const directory = temporary();
    put(join(directory, "a.py"), "x = 1\n");
    put(join(directory, "b.md"), "a \u2014 b\n");
    const command =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: a.py\n+x = 1\n*** End Patch\nPATCH\n" +
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: b.md\n+a \u2014 b\n*** End Patch\nPATCH";

    expect(bash(command, directory)!).toContain("b.md contains an em dash");
  });

  test("shell apply_patch follows a cd on an earlier line and a quoted path", () => {
    const directory = temporary();
    mkdirSync(join(directory, "sub dir"));
    put(join(directory, "sub dir/note.md"), "a \u2014 b\n");
    const patch =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: note.md\n+a \u2014 b\n*** End Patch\nPATCH";

    expect(bash(`cd 'sub dir'\n${patch}`, directory)!).toContain("note.md contains an em dash");
    expect(bash(`cd "sub dir" && ${patch}`, directory)!).toContain("note.md contains an em dash");
  });

  test("a cd inside a subshell does not move later patches", () => {
    const directory = temporary();
    mkdirSync(join(directory, "sub"));
    put(join(directory, "note.md"), "a \u2014 b\n");
    const patch =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: note.md\n+a \u2014 b\n*** End Patch\nPATCH";

    expect(bash(`(cd sub && true)\n${patch}`, directory)!).toContain("note.md contains an em dash");
    expect(bash(`(cd sub && true) && ${patch}`, directory)!).toContain(
      "note.md contains an em dash",
    );

    expect(bash(`(\n  cd sub\n)\n${patch}`, directory)!).toContain("note.md contains an em dash");
  });

  test("shell apply_patch with an escaped delimiter stops at its terminator", () => {
    const directory = temporary();
    put(join(directory, "a.py"), "x = 1\n");
    put(join(directory, "b.md"), "a \u2014 b\n");
    const command =
      "apply_patch <<\\PATCH\n*** Begin Patch\n*** Add File: a.py\n+x = 1\n*** End Patch\nPATCH\n" +
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: b.md\n+a \u2014 b\n*** End Patch\nPATCH";

    expect(bash(command, directory)!).toContain("b.md contains an em dash");
  });

  test("apply_patch as an argument is not an invocation", () => {
    const directory = temporary();
    put(join(directory, "hello.py"), "# say hi\n");
    const command =
      "printf '%s\\n' apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: hello.py\n+# say hi\n*** End Patch\nPATCH";

    expect(bash(command, directory)).toBeUndefined();
  });

  test("shell apply_patch inside an argv list and a quoted script", () => {
    const directory = temporary();
    put(join(directory, "hello.py"), "# prints hi\n");
    const script =
      "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: hello.py\n+# prints hi\n*** End Patch\nPATCH";

    expect(bash(["bash", "-lc", script], directory)!).toContain("hello.py: # prints hi");
    expect(bash(`bash -lc '${script}'`, directory)!).toContain("hello.py: # prints hi");
  });

  test("test_apply_patch_add_file_flags_added_comment", () => {
    const directory = temporary();
    put(join(directory, "hello.py"), "# prints hi\nprint('hi')\n");
    const body = "*** Add File: hello.py\n+# prints hi\n+print('hi')\n";
    const out = hook(patchPayload(body, directory));
    expect(out!).toContain("hello.py: # prints hi");
  });

  test("test_apply_patch_update_only_new_lines", () => {
    const directory = temporary();
    put(join(directory, "a.ts"), "// kept\n// fresh\nconst a = 2;\n");
    const body =
      "*** Update File: " +
      join(directory, "a.ts") +
      "\n@@\n // kept\n-const a = 1;\n+// fresh\n+const a = 2;\n";

    const out = hook(patchPayload(body, directory));
    expect(out!).toContain("fresh");
    expect(out!).not.toContain("kept");
  });

  test("test_apply_patch_string_line_is_not_a_comment", () => {
    const directory = temporary();
    put(
      join(directory, "a.py"),
      "# note\nx = 1\nDOC = " +
        String.fromCodePoint(39).repeat(3) +
        "\n# note\n" +
        String.fromCodePoint(39).repeat(3) +
        "\ny = 2\n",
    );

    const body =
      "*** Update File: " +
      join(directory, "a.py") +
      "\n@@\n DOC = " +
      String.fromCodePoint(39).repeat(3) +
      "\n+# note\n " +
      String.fromCodePoint(39).repeat(3) +
      "\n";

    expect(hook(patchPayload(body, directory))).toBeUndefined();
  });

  test("test_apply_patch_comment_with_a_twin_reports_one_line", () => {
    const directory = temporary();
    put(join(directory, "a.py"), "# note\nx = 1\ny = 2\n# note\nz = 3\n");
    const body = "*** Update File: " + join(directory, "a.py") + "\n@@\n y = 2\n+# note\n z = 3\n";
    const out = hook(patchPayload(body, directory));
    expect(out!.startsWith("1 comment line added")).toBeTruthy();
  });

  test("test_apply_patch_empty_context_line_anchors_the_right_copy", () => {
    const text =
      "class A:\n  def run(self):\n\n    # retry once\n    go()\n\nclass B:\n  def run(self):\n    # retry once\n    go()\n";

    const body =
      "*** Update File: /repo/a.py\n@@\n   def run(self):\n\n+    # retry once\n     go()\n";

    const hunk = patch.patchFiles("*** Begin Patch\n" + body + "*** End Patch")[0]!["hunks"]![0]!;
    expect(hunk["new"]!).toEqual("  def run(self):\n\n    # retry once\n    go()");
    expect(scan.added(text, hunk["old"]!, hunk["new"]!, scan.BY_EXT[".py"]!)).toEqual([
      [4, "# retry once"],
    ]);
  });

  test("test_apply_patch_unreadable_file_keeps_both_hunks", () => {
    const directory = temporary();
    const body =
      "*** Update File: " +
      join(directory, "gone.py") +
      "\n@@\n x = 1\n+# one\n@@\n y = 2\n+# two\n";

    const out = hook(patchPayload(body, directory));
    expect(out!).toContain("# one");
    expect(out!).toContain("# two");
  });

  test("test_apply_patch_delete_only_hunk_reports_exposed_comment", () => {
    const directory = temporary();
    put(join(directory, "a.py"), "# exposed\nx = 1\n");
    const body =
      "*** Update File: " +
      join(directory, "a.py") +
      "\n@@\n-" +
      String.fromCodePoint(39).repeat(3) +
      "\n # exposed\n-" +
      String.fromCodePoint(39).repeat(3) +
      "\n x = 1\n";

    const out = hook(patchPayload(body, directory));
    expect(out!).toContain("# exposed");
  });

  test("test_apply_patch_with_split_additions_reports_the_comment", () => {
    const directory = temporary();
    const path = join(directory, "a.py");
    put(path, "# fresh\na = 0\ns = '''\n# fresh\ny = 2\n'''\ny = 2\n");

    const body = "*** Update File: " + path + "\n@@\n+# fresh\n a = 0\n@@\n-x = 1\n+y = 2\n";
    const out = hook(patchPayload(body, directory));
    expect(out).toBeDefined();
    expect(out!).toContain("fresh");
  });

  test("test_apply_patch_delete_and_clean_pass", () => {
    const directory = temporary();
    const body = "*** Delete File: gone.py\n*** Add File: b.py\n+x = 1\n";
    put(join(directory, "b.py"), "x = 1\n");
    expect(hook(patchPayload(body, directory))).toBeUndefined();
  });

  test("test_em_dash_hook_reads_apply_patch", () => {
    const directory = temporary();
    put(join(directory, "notes.md"), "a \u2014 b\n");
    const body = "*** Add File: notes.md\n+a \u2014 b\n";

    const out = hook(patchPayload(body, directory));
    expect(out!).toContain("notes.md contains an em dash");
    expect(hook(write("Write", join(directory, "none.md"), { content: "x" }))).toBeUndefined();
  });
});

describe("PostToolUse parity", () => {
  test("both findings print dash first with one blank line", async () => {
    const path = join(temporary(), "a.py");
    put(path, "# narration \u2014 here\n");
    const input = JSON.stringify(write("Write", path, { content: "# narration \u2014 here\n" }));

    expect(await cli(input)).toBe(
      '{"decision": "block", "reason": "a.py contains an em dash (U+2014) (line 1). No em dashes, en dashes or hyphen as dash in anything you write. Rewrite with a comma, colon, parenthesis or full stop, then continue.\\n\\n1 comment line added:\\n  a.py: # narration \\u2014 here\\nDefault is none. Delete each. Keep one line only where it names an external constraint, a landmine, or why the obvious approach lost."}\n',
    );
  });

  test("stdout escapes non ASCII code units like Python", async () => {
    const input = JSON.stringify(
      write("Edit", "/repo/a.py", { old_string: "", new_string: "# caf\u00e9 \ud83d\ude00\n" }),
    );

    expect(await cli(input)).toBe(
      '{"decision": "block", "reason": "1 comment line added:\\n  a.py: # caf\\u00e9 \\ud83d\\ude00\\nDefault is none. Delete each. Keep one line only where it names an external constraint, a landmine, or why the obvious approach lost."}\n',
    );
  });

  test("non object and malformed stdin stay silent", async () => {
    for (const input of ["null", "[]", "42", '"text"', "{", "", "\ufeff{}"])
      expect(await cli(input)).toBe("");
  });

  test("Python whitespace excludes BOM and splitlines excludes a trailing empty item", () => {
    const whitespace =
      "\t\n\v\f\r\x1c\x1d\x1e\x1f \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000";

    expect(pyIsSpace(whitespace)).toBe(true);
    expect(pyIsSpace("")).toBe(false);
    expect(pyIsSpace("\ufeff")).toBe(false);

    expect(pyStrip(whitespace + "value" + whitespace)).toBe("value");
    expect(pyLstrip(whitespace + "value ")).toBe("value ");
    expect(pyRstrip(" value" + whitespace)).toBe(" value");
    expect(pyStrip("\ufeffvalue\ufeff")).toBe("\ufeffvalue\ufeff");

    for (const boundary of [
      "\n",
      "\r",
      "\r\n",
      "\v",
      "\f",
      "\x1c",
      "\x1d",
      "\x1e",
      "\x85",
      "\u2028",
      "\u2029",
    ])
      expect(splitlines("first" + boundary + "second" + boundary)).toEqual(["first", "second"]);

    expect(splitlines("")).toEqual([]);
    expect(splitlines("\n")).toEqual([""]);
    expect(splitlines("first\x1fsecond")).toEqual(["first\x1fsecond"]);

    expect(scan.commentLines("\x85# narration\x1f\n", scan.HASH)).toEqual([[1, "# narration"]]);
    expect(scan.commentLines("\ufeff# narration\n", scan.HASH)).toEqual([]);
    expect(scan.skipPath("/repo/build/a.ts", { AGENT_HOOKS_SKIP: "\x85/build/\x1f" })).toBe(true);
    expect(scan.skipPath("/repo/build/a.ts", { AGENT_HOOKS_SKIP: "\ufeff/build/" })).toBe(false);
  });

  test("Python path operations preserve joins and leading dot runs", () => {
    expect(joinPath("", "a/../b.py")).toBe("a/../b.py");
    expect(joinPath("/repo/", "a/../b.py")).toBe("/repo/a/../b.py");
    expect(joinPath("/repo", "/other/a.py")).toBe("/other/a.py");

    expect(basename("/repo/a.py/")).toBe("");
    expect(dirname("///")).toBe("///");
    expect(dirname("/repo//a.py")).toBe("/repo");

    expect(dirname("a.py")).toBe("");
    for (const path of [".py", "..ts", "....sh"]) expect(splitext(path)).toBe("");
    expect(splitext(".config.py")).toBe(".py");

    expect(scan.specFor("/repo/.py")).toBeUndefined();
    expect(scan.specFor("/repo/Dockerfile")).toBe(scan.SHELL);
    expect(scan.specFor("/repo/file.PY")).toBe(scan.HASH);
    expect(scan.clip("\ud83d\ude00".repeat(91))).toBe("\ud83d\ude00".repeat(87) + "...");
    expect(codePointOrder("\ue000", "\ud83d\ude00")).toBeLessThan(0);
  });

  test("text reads retain BOM, replace invalid UTF8 and translate newlines", async () => {
    expect(textMode(new Uint8Array([239, 187, 191, 255, 13, 10, 13]))).toBe("\ufeff\ufffd\n\n");
    const path = join(temporary(), "a.py");
    writeFileSync(path, Buffer.from("# narration\rnext\r\n# fresh\r\n"));

    const reason = hook(write("Edit", path, { old_string: "", new_string: "# fresh\n" }));
    expect(reason).toContain("a.py: # fresh");
    expect(reason).not.toContain("narration");
    expect(
      hook(write("Edit", path, { old_string: "", new_string: "# payload\r\n" })),
    ).toBeUndefined();

    const missing = join(temporary(), "gone.py");
    expect(hook(write("Edit", missing, { new_string: "# first\r# second" }))).toContain(
      "1 comment line added",
    );

    const repo = join(temporary(), "repo");
    mkdirSync(repo);
    await fixtureGit(repo, ["init", "-q"]);

    put(join(repo, "a.py"), "# kept\r\nx = 1\r");
    await fixtureGit(repo, ["add", "a.py"]);
    await fixtureGit(repo, ["-c", "commit.gpgsign=false", "commit", "-qm", "init"]);
    put(join(repo, "a.py"), "# kept\nx = 1\n");
    expect(
      check(write("Write", join(repo, "a.py")), {
        AGENT_HOOKS: "1",
        GIT_DIR: "/missing",
        GIT_WORK_TREE: "/missing",
      }),
    ).toBeUndefined();
  });

  test("Unicode pragma classes and quoted escapes follow Python", () => {
    expect(scan.commentLines("#\x85noqa\n", scan.HASH)).toEqual([]);
    expect(scan.commentLines("# pragma once\u03b1\n", scan.HASH)).toEqual([
      [1, "# pragma once\u03b1"],
    ]);

    expect(scan.commentLines("/* global \u03b1: \u03b2 */\n", scan.C)).toEqual([]);
    expect(scan.commentLines("# Copyright \u0662\u0660\u0662\u0666\n", scan.HASH)).toEqual([]);
    expect(scan.commentLines("const quote = '\\\u2028`';\n// narration\n", scan.C)).toEqual([
      [2, "// narration"],
    ]);
  });

  test("patch paths accept CR and Unicode line separators", () => {
    for (const char of ["\r", "\u2028", "\u2029"])
      expect(patch.patchFiles("*** Add File: a" + char + ".py\n+# note\n", "")[0]!.path).toBe(
        "a" + char + ".py",
      );

    expect(patch.patchFiles("*** Add File: a/../b.py\n+# note\n", "/repo/")[0]!.path).toBe(
      "/repo/a/../b.py",
    );
  });

  test("dash line numbers preserve Python splitlines and URL whitespace", () => {
    const path = join(temporary(), "notes.md");
    put(path, "```\n\u2014\n```\n`\u2013`\nhttps://x/\u2014\x85\u2013\v\u2014\n");
    expect(hook(write("Write", path))).toContain(
      "an em dash (U+2014) and an en dash (U+2013) (lines 6, 7)",
    );
  });

  test("duplicate patch paths retain dash occurrences but dedupe comments", () => {
    const path = join(temporary(), "a.py");
    put(path, "# fresh\nvalue = '\u2014'\n");
    const body = "*** Update File: a.py\n@@\n+# fresh\n*** Update File: a.py\n@@\n+# fresh\n";
    const read = spyOn(fs, "readFileSync");
    try {
      const reason = hook(patchPayload(body, dirname(path)))!;
      expect(reason.split("a.py contains")).toHaveLength(3);
      expect(reason).toContain("1 comment line added");
      expect(read.mock.calls.filter(([target]) => target === path)).toHaveLength(1);
    } finally {
      read.mockRestore();
    }
  });

  test("unreadable patch hunks retain distinct fallback scopes", () => {
    const payload = patchPayload("*** Update File: gone.py\n@@\n+# one\n@@\n+# two\n", temporary());
    expect(hook(payload)).toContain("2 comment lines added");
  });

  test("non regular paths retain legacy comment reads", () => {
    const path = join(temporary(), "a.py");
    fs.symlinkSync("/dev/null", path);

    expect(hook(write("Write", path, { content: "# fresh\n" }))).toBeUndefined();
    expect(hook(write("Edit", path, { new_string: "# fresh\n" }))).toBeUndefined();
  });

  test("Python JSON uses short escapes and lowercase ASCII escapes", () => {
    expect(jsonBlock('"\\\n\r\t\b\f\0\x1f\x7f\u00e9\u2028\ud83d\ude00')).toBe(
      '{"decision": "block", "reason": "\\"\\\\\\n\\r\\t\\b\\f\\u0000\\u001f\\u007f\\u00e9\\u2028\\ud83d\\ude00"}\n',
    );
  });

  test("SequenceMatcher preserves earliest ties and adjacent blocks", () => {
    const matcher = new SequenceMatcher(["a", "b"], ["a", "c", "a", "b"]);
    expect(matcher.b2j.get("a")).toEqual([0, 2]);
    expect(matcher.findLongestMatch()).toEqual([0, 2, 2]);
    expect(matcher.getMatchingBlocks()).toEqual([
      [0, 2, 2],
      [2, 4, 0],
    ]);

    expect(matcher.getOpcodes()).toEqual([
      ["insert", 0, 0, 0, 2],
      ["equal", 0, 2, 2, 4],
    ]);

    const tied = new SequenceMatcher(["a", "b", "a"], ["b", "a", "b"]);
    expect(tied.findLongestMatch()).toEqual([0, 1, 2]);
    expect(tied.getOpcodes()).toEqual([
      ["insert", 0, 0, 0, 1],
      ["equal", 0, 2, 1, 3],
      ["delete", 2, 3, 3, 3],
    ]);

    expect(new SequenceMatcher([], ["x"]).getOpcodes()).toEqual([["insert", 0, 0, 0, 1]]);
    expect(new SequenceMatcher(["x"], ["y"]).getOpcodes()).toEqual([["replace", 0, 1, 0, 1]]);
    expect(new SequenceMatcher(["x"], ["x"]).getMatchingBlocks()).toEqual([
      [0, 0, 1],
      [1, 1, 0],
    ]);

    expect(
      new SequenceMatcher(Array(250).fill("x"), Array(251).fill("x")).getMatchingBlocks(),
    ).toEqual([
      [0, 0, 250],
      [250, 251, 0],
    ]);
  });
});
