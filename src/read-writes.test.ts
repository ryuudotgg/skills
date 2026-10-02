import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as reads from "./read.ts";
import { dependencies } from "./review/threads.ts";
import { git } from "./stack/restack.ts";
import { suiteEnvironment } from "./test/process.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "skills-read-writes-"));
  directories.push(cwd);
  const bin = join(cwd, "bin");
  mkdirSync(bin);

  for (const name of ["git", "gh"]) {
    const path = join(bin, name);
    writeFileSync(path, '#!/bin/sh\ncat >/dev/null\nprintf written\n');
    chmodSync(path, 0o755);
  }

  return { cwd, env: { ...suiteEnvironment(), PATH: `${bin}:${process.env.PATH}` } };
}

for (const args of [["push", "origin", "topic"], ["update-ref", "refs/heads/topic", "next"]])
  test(`restack ${args[0]} bypasses read and starts without a deadline`, async () => {
    const { cwd, env } = fixture();
    const readSpy = spyOn(reads, "read");
    const spawnSpy = spyOn(Bun, "spawn");
    try {
      const result = await git({ cwd, indexes: [], ownRows: new Set() }, args, { write: true, env, stderr: "capture" });
      expect(result).toMatchObject({ code: 0, stdout: "written" });
      expect(readSpy).not.toHaveBeenCalled();
      expect(spawnSpy).toHaveBeenCalledTimes(1);

      const options = spawnSpy.mock.calls[0]![1];
      expect(options).not.toHaveProperty("timeout");
    } finally {
      readSpy.mockRestore();
      spawnSpy.mockRestore();
    }
  });

test("a gh mutation without a deadline bypasses read and keeps its stdin", async () => {
  const { cwd, env } = fixture();
  const readSpy = spyOn(reads, "read");
  const spawnSpy = spyOn(Bun, "spawn");
  try {
    const result = await dependencies(cwd, cwd, env).gh(["api", "graphql", "--input", "-"], undefined, '{"query":"mutation { resolveReviewThread }"}');
    expect(result).toMatchObject({ code: 0, stdout: "written" });
    expect(readSpy).not.toHaveBeenCalled();
    expect(spawnSpy).toHaveBeenCalledTimes(1);

    const options = spawnSpy.mock.calls[0]![1];
    expect(options).not.toHaveProperty("timeout");
    expect(options?.stdin).toBeInstanceOf(Uint8Array);
  } finally {
    readSpy.mockRestore();
    spawnSpy.mockRestore();
  }
});

test("a zero deadline in the threads runner still selects read", async () => {
  const { cwd, env } = fixture();
  const readSpy = spyOn(reads, "read");
  try {
    await dependencies(cwd, cwd, env).gh(["api", "graphql"], 0);
    expect(readSpy).toHaveBeenCalledTimes(1);
    expect(readSpy.mock.calls[0]![1].deadline).toBe(0);
  } finally {
    readSpy.mockRestore();
  }
});
