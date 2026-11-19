import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDirectory, writeJsonAtomic } from "./io.ts";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "io-test-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("isDirectory", () => {
  test("follows symlinks and is false on any failure", () => {
    const file = join(scratch, "file");
    writeFileSync(file, "");
    symlinkSync(scratch, join(scratch, "link"));

    expect(isDirectory(scratch)).toBe(true);
    expect(isDirectory(join(scratch, "link"))).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(isDirectory(join(scratch, "missing"))).toBe(false);
    expect(isDirectory(join(file, "child"))).toBe(false);
  });
});

describe("writeJsonAtomic", () => {
  test("makes the parent and ends the JSON with one newline", () => {
    const path = join(scratch, "a", "b", "state.json");
    writeJsonAtomic(path, { at: 1 });

    expect(readFileSync(path, "utf8")).toBe('{"at":1}\n');
    expect(readdirSync(join(scratch, "a", "b"))).toEqual(["state.json"]);
  });

  test("a failed rename throws, keeps the target and leaves no .tmp file", () => {
    const path = join(scratch, "state.json");
    writeFileSync(path, "old bytes");
    const rename = spyOn(fs, "renameSync").mockImplementation(() => {
      throw new Error("rename failed");
    });

    try {
      expect(() => writeJsonAtomic(path, { at: 2 })).toThrow("rename failed");
      expect(rename).toHaveBeenCalledTimes(1);
    } finally {
      rename.mockRestore();
    }

    expect(readFileSync(path, "utf8")).toBe("old bytes");
    expect(readdirSync(scratch)).toEqual(["state.json"]);
  });

  test("a failed write throws and leaves no .tmp file", () => {
    const path = join(scratch, "state.json");
    writeFileSync(path, "old bytes");
    const write = spyOn(fs, "writeFileSync").mockImplementation((file) => {
      fs.appendFileSync(file as string, "partial");
      throw new Error("disk full");
    });

    try {
      expect(() => writeJsonAtomic(path, { at: 3 })).toThrow("disk full");
    } finally {
      write.mockRestore();
    }

    expect(readFileSync(path, "utf8")).toBe("old bytes");
    expect(readdirSync(scratch)).toEqual(["state.json"]);
  });
});
