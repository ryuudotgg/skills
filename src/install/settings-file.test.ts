import { afterEach, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addEntries, missingEntries, writeCodexHooks } from "./codex-hooks.ts";
import { parseJson, stringifyJson, type JsonObject } from "./json.ts";
import { readSettings, writeAtomic, writeSettings, type SettingsFile } from "./settings-file.ts";

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "settings-file-"));
  directories.push(directory);
  return { directory, path: join(directory, "settings.json") };
}

function read(path: string): SettingsFile {
  const file = readSettings(path);
  if ("refused" in file) throw new Error(file.refused);
  return file;
}

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test.each(["    ", "\t"])("keeps indentation %j after a one key edit", (indent) => {
  const value = fixture();
  writeFileSync(
    value.path,
    `{\n${indent}"kept": {\n${indent}${indent}"list": [\n${indent}${indent}${indent}true\n${indent}${indent}]\n${indent}},\n${indent}"edited": false\n}\n`,
  );

  const file = read(value.path);

  file.data.edited = true;

  expect(file.format.indent).toBe(indent);
  expect(writeSettings(file, file.data)).toEqual({ outcome: "written" });
  expect(readFileSync(value.path, "utf8")).toBe(
    `{\n${indent}"kept": {\n${indent}${indent}"list": [\n${indent}${indent}${indent}true\n${indent}${indent}]\n${indent}},\n${indent}"edited": true\n}\n`,
  );
});

test.each(["", "\n"])("keeps a multi line file's final newline %j", (ending) => {
  const value = fixture();
  writeFileSync(value.path, `{\n  "edited": false\n}${ending}`);
  const file = read(value.path);

  file.data.edited = true;

  expect(file.format.finalNewline).toBe(ending !== "");
  expect(writeSettings(file, file.data)).toEqual({ outcome: "written" });
  expect(readFileSync(value.path, "utf8")).toBe(`{\n  "edited": true\n}${ending}`);
});

test.each(["", "\r\n"])("keeps CRLF and its final newline %j", (ending) => {
  const value = fixture();
  writeFileSync(value.path, `{\r\n    "edited": false\r\n}${ending}`);
  const file = read(value.path);

  file.data.edited = true;

  expect(file.format).toEqual({ indent: "    ", newline: "\r\n", finalNewline: ending !== "" });
  expect(writeSettings(file, file.data)).toEqual({ outcome: "written" });
  expect(readFileSync(value.path, "utf8")).toBe(`{\r\n    "edited": true\r\n}${ending}`);
});

test.each([
  '{\n  "kept": true\n}\n',
  '{"kept":true}',
  '{\n    "kept" : true\n}',
  '{"kept":"\\u96ea"}',
  '{\r\n\t"kept": true\r\n}\r\n',
])("unchanged data keeps the bytes, inode and mtime of %j", (content) => {
  const value = fixture();
  writeFileSync(value.path, content);
  utimesSync(value.path, 1, 1);
  const before = statSync(value.path);
  const file = read(value.path);

  expect(writeSettings(file, file.data)).toEqual({ outcome: "unchanged" });
  expect(readFileSync(value.path, "utf8")).toBe(content);
  expect(statSync(value.path).ino).toBe(before.ino);
  expect(statSync(value.path).mtimeMs).toBe(before.mtimeMs);
  expect(readdirSync(value.directory)).toEqual(["settings.json"]);
});

test.each(['{"edited":false}', '{"edited":false,\n    "kept":true}'])(
  "undetected indentation uses two spaces and a final newline for %j",
  (content) => {
    const value = fixture();
    writeFileSync(value.path, content);
    const file = read(value.path);

    file.data.edited = true;

    expect(file.format).toEqual({ indent: "  ", newline: "\n", finalNewline: true });
    expect(writeSettings(file, file.data)).toEqual({ outcome: "written" });
    expect(readFileSync(value.path, "utf8")).toBe(
      content.includes("kept")
        ? '{\n  "edited": true,\n  "kept": true\n}\n'
        : '{\n  "edited": true\n}\n',
    );
  },
);

test("a missing file reads as an empty object and uses the default format", () => {
  const value = fixture();
  const file = read(value.path);

  expect(file.data).toEqual({});
  expect(file.stats).toBeUndefined();
  expect(file.text).toBeUndefined();
  expect(file.bytes).toBeUndefined();
  expect(file.format).toEqual({ indent: "  ", newline: "\n", finalNewline: true });

  expect(writeSettings(file, file.data)).toEqual({ outcome: "unchanged" });
  expect(existsSync(value.path)).toBe(false);

  file.data.edited = true;

  expect(writeSettings(file, file.data)).toEqual({ outcome: "written" });
  expect(readFileSync(value.path, "utf8")).toBe('{\n  "edited": true\n}\n');
});

test("changed bytes refuse a write even when the length and mtime are unchanged", () => {
  const value = fixture();
  writeFileSync(value.path, '{"kept":"first"}');
  const before = statSync(value.path);
  const file = read(value.path);

  file.data.edited = true;
  const other = '{"kept":"other"}';
  writeFileSync(value.path, other);
  utimesSync(value.path, before.atime, before.mtime);

  expect(writeSettings(file, file.data)).toEqual({
    outcome: "refused",
    reason: "changed on disk since it was read",
  });

  expect(readFileSync(value.path)).toEqual(Buffer.from(other));
  expect(readdirSync(value.directory)).toEqual(["settings.json"]);
});

test("a file created after a missing read refuses a write", () => {
  const value = fixture();
  const file = read(value.path);

  file.data.edited = true;
  const other = '{"other":true}\r\n';
  writeFileSync(value.path, other);

  expect(writeSettings(file, file.data)).toEqual({
    outcome: "refused",
    reason: "changed on disk since it was read",
  });

  expect(readFileSync(value.path)).toEqual(Buffer.from(other));
  expect(readdirSync(value.directory)).toEqual(["settings.json"]);
});

test("a dangling symlink created after a missing read refuses a write", () => {
  const value = fixture();
  const file = read(value.path);

  file.data.edited = true;
  symlinkSync(join(value.directory, "missing.json"), value.path);

  expect(writeSettings(file, file.data)).toEqual({
    outcome: "refused",
    reason: "changed on disk since it was read",
  });

  expect(lstatSync(value.path).isSymbolicLink()).toBe(true);
  expect(existsSync(value.path)).toBe(false);
  expect(readdirSync(value.directory)).toEqual(["settings.json"]);
});

test("a file deleted after reading stays deleted without a temporary file", () => {
  const value = fixture();
  writeFileSync(value.path, '{"kept":true}');
  const file = read(value.path);

  file.data.edited = true;
  unlinkSync(value.path);

  expect(writeSettings(file, file.data)).toEqual({
    outcome: "refused",
    reason: "changed on disk since it was read",
  });

  expect(existsSync(value.path)).toBe(false);
  expect(readdirSync(value.directory)).toEqual([]);
});

test("the atomic guard runs after the temporary file is complete and removes it on refusal", () => {
  const value = fixture();
  const other = '{"other":true}';
  let guarded = false;
  const written = writeAtomic(value.path, "replacement", 0o640, value.path, () => {
    const entries = readdirSync(value.directory);
    expect(entries).toHaveLength(1);
    const temporary = join(value.directory, entries[0]!);
    expect(readFileSync(temporary, "utf8")).toBe("replacement");
    expect(statSync(temporary).mode & 0o777).toBe(0o640);

    writeFileSync(value.path, other);
    guarded = true;

    return false;
  });

  expect(guarded).toBe(true);
  expect(written).toBe(false);
  expect(readFileSync(value.path, "utf8")).toBe(other);
  expect(readdirSync(value.directory)).toEqual(["settings.json"]);
});

test("Codex hook installation keeps four space indentation", () => {
  const value = fixture();
  const path = join(value.directory, "hooks.json");
  const agents = join(value.directory, "skills");
  writeFileSync(path, '{\n    "mine": true,\n    "hooks": {}\n}\n');

  const output = writeCodexHooks(path, join(value.directory, "copies"), agents);
  const content = readFileSync(path, "utf8");

  expect(output).toContain("codex  add SessionStart");
  expect(content).toStartWith('{\n    "mine": true,\n    "hooks": {\n        "SessionStart": [');
  expect(content).toContain('\n                "hooks": [\n                    {');
  expect(content).toEndWith("\n}\n");
  expect(missingEntries(parseJson(content), agents)).toEqual([]);
});

function withCp(directory: string, script: string, run: () => void): void {
  const bin = join(directory, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "cp"), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  process.env.PATH = `${bin}:${previousPath ?? ""}`;

  try {
    run();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

test("a deleted key is left out of the rewrite", () => {
  const value = fixture();
  writeFileSync(
    value.path,
    '{\n  "gone": true,\n  "nested": {\n    "gone": 1,\n    "kept": 2\n  }\n}\n',
  );

  const file = read(value.path);

  delete file.data.gone;
  delete (file.data.nested as Record<string, unknown>).gone;

  expect(writeSettings(file, file.data)).toEqual({ outcome: "written" });
  expect(readFileSync(value.path, "utf8")).toBe('{\n  "nested": {\n    "kept": 2\n  }\n}\n');
});

test("a change made while the temporary file is written refuses at the rename", () => {
  const value = fixture();
  const other = '{"other":true}';
  writeFileSync(value.path, '{"kept":true}');
  const file = read(value.path);

  file.data.edited = true;

  withCp(value.directory, `/bin/cp -p "$2" "$3"\nprintf '%s' '${other}' > "$2"`, () => {
    expect(writeSettings(file, file.data)).toEqual({
      outcome: "refused",
      reason: "changed on disk since it was read",
    });
  });

  expect(readFileSync(value.path, "utf8")).toBe(other);
  expect(readdirSync(value.directory).sort()).toEqual(["bin", "settings.json"]);
});

test("a change that breaks the metadata copy refuses instead of throwing", () => {
  const value = fixture();
  writeFileSync(value.path, '{"kept":true}');
  const file = read(value.path);

  file.data.edited = true;

  withCp(value.directory, `rm "$2"\nmkdir "$2"\nexit 1`, () => {
    expect(writeSettings(file, file.data)).toEqual({
      outcome: "refused",
      reason: "changed on disk since it was read",
    });
  });

  expect(statSync(value.path).isDirectory()).toBe(true);
});

test("a symlink replaced by a file after reading refuses a write", () => {
  const value = fixture();
  const target = join(value.directory, "target.json");
  writeFileSync(target, '{"kept":true}');
  symlinkSync(target, value.path);
  const file = read(value.path);

  file.data.edited = true;
  unlinkSync(value.path);
  writeFileSync(value.path, '{"kept":true}');

  expect(writeSettings(file, file.data)).toEqual({
    outcome: "refused",
    reason: "changed on disk since it was read",
  });

  expect(readFileSync(target, "utf8")).toBe('{"kept":true}');
  expect(readFileSync(value.path, "utf8")).toBe('{"kept":true}');
});

test("a minified CRLF file and a blank line after the brace", () => {
  const minified = read(
    (() => {
      const value = fixture();
      writeFileSync(value.path, '{"kept":true}\r\n');
      return value.path;
    })(),
  );

  const spaced = read(
    (() => {
      const value = fixture();
      writeFileSync(value.path, '{\n\n    "kept": true\n}\n');
      return value.path;
    })(),
  );

  expect(minified.format).toEqual({ indent: "  ", newline: "\n", finalNewline: true });
  expect(spaced.format).toEqual({ indent: "    ", newline: "\n", finalNewline: true });
});

test("a two space Codex hooks file is rewritten with today's exact bytes", () => {
  const value = fixture();
  const path = join(value.directory, "hooks.json");
  const agents = join(value.directory, "skills");
  writeFileSync(path, '{\n  "mine": true,\n  "hooks": {}\n}\n');

  writeCodexHooks(path, join(value.directory, "copies"), agents);

  const expected: JsonObject = { mine: true, hooks: {} };
  addEntries(expected, missingEntries(expected, agents));

  expect(readFileSync(path, "utf8")).toBe(`${stringifyJson(expected)}\n`);
});
