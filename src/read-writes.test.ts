import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "./io.ts";
import { run } from "./publish/commit.ts";
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
      const result = await git({ cwd, env, out: () => {}, err: () => {}, capture: true, indexes: [], ownRows: new Set() }, args, { write: true, stderr: "capture" });
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

test("restack write preserves a signal exit as -1", async () => {
  const { cwd, env } = fixture();
  writeFileSync(join(cwd, "bin/git"), "#!/bin/sh\nkill -TERM $$\n");

  const result = await git({ cwd, env, out: () => {}, err: () => {}, capture: true, indexes: [], ownRows: new Set() }, ["push"], { write: true });
  expect(result.code).toBe(-1);
});

for (const runner of ["restack", "commit"] as const) {
  test(`${runner} write captures output with the passed environment`, async () => {
    const { cwd, env } = fixture();
    writeFileSync(join(cwd, "bin/git"), '#!/bin/sh\nprintf "out:%s" "$WRITE_TOKEN"\nprintf "err:%s" "$WRITE_TOKEN" >&2\n');
    let stderr = "";
    const io: Io = { cwd, env: { ...env, WRITE_TOKEN: "case" }, out: () => {}, err: (text) => { stderr += text; }, capture: true };
    if (runner === "restack") {
      const result = await git({ ...io, indexes: [], ownRows: new Set() }, ["push"], { write: true });
      expect(result).toMatchObject({ code: 0, stdout: "out:case", stderr: "err:case" });
      expect(stderr).toBe("err:case");
    } else {
      const result = await run(cwd, ["git", "commit"], { write: true }, io);
      expect(result).toEqual({ code: 0, output: "" });
      expect(stderr).toBe("err:caseout:case");
    }
  });

  test(`${runner} write stops draining a pipe held after exit`, async () => {
    const { cwd, env } = fixture();
    writeFileSync(join(cwd, "bin/git"), "#!/bin/sh\nsleep 3 &\nprintf written\nprintf hook >&2\n");
    let stderr = "";
    const io: Io = { cwd, env, out: () => {}, err: (text) => { stderr += text; }, capture: true };
    const write = runner === "restack"
      ? git({ ...io, indexes: [], ownRows: new Set() }, ["push"], { write: true })
      : run(cwd, ["git", "commit"], { write: true }, io);

    const code = await reads.within(write.then((result) => result.code), reads.GRACE * 2);
    expect(code).toBe(0);
    expect(stderr).toBe(runner === "restack" ? "hook" : "hookwritten");
    await write;
  });
}
