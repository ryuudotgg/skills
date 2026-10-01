import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTemporary } from "../test/process.ts";
import { recordsFromFile } from "./jsonl.ts";

let temporary: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-jsonl-"));
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function read(content: string | Buffer) {
  const path = join(temporary, "a.jsonl");
  await writeFile(path, content);

  const notes: string[] = [];
  const records = [...recordsFromFile(path, notes)];
  return { records, notes };
}

describe("recordsFromFile splits lines like Python universal newlines", () => {
  test("\\n, \\r\\n and bare \\r all end a line, and a last line needs no newline", async () => {
    const { records } = await read('{"a":1}\n{"a":2}\r\n{"a":3}\r{"a":4}');
    expect(records).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }, { a: 4 }]);
  });

  test("a \\r\\n split across a read boundary is one line ending", async () => {
    const first = `{"pad":"${"x".repeat(65536 - 11)}"}`;

    expect(first.length + 1).toBe(65536);

    const { records } = await read(`${first}\r\n{"a":2}\n`);

    expect(records.map((record) => Object.keys(record))).toEqual([["pad"], ["a"]]);
  });

  test("arrays, scalars, blank and broken lines are skipped", async () => {
    const { records, notes } = await read('[1]\n3\n\nnope\n{"a":1}\n');
    expect(records).toEqual([{ a: 1 }]);
    expect(notes).toEqual([]);
  });

  test("a leading BOM spoils the first line as it does for json.loads", async () => {
    const { records } = await read('﻿{"a":1}\n{"a":2}\n');
    expect(records).toEqual([{ a: 2 }]);
  });

  test("a directory or invalid UTF-8 is noted as unavailable", async () => {
    const directory = join(temporary, "dir.jsonl");
    await mkdir(directory);

    const notes: string[] = [];
    expect([...recordsFromFile(directory, notes)]).toEqual([]);
    expect(notes).toEqual([`${directory} is unavailable`]);

    const invalid = await read(Buffer.from([0x7b, 0x7d, 0x0a, 0xff, 0x0a]));
    expect(invalid.notes).toEqual([`${join(temporary, "a.jsonl")} is unavailable`]);
  });
});
