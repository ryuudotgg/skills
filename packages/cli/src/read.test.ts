import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, floored, read, readSync, type Read, type ReadFailure } from "./read.ts";
import { runCommand, suiteEnvironment } from "./test/process.ts";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    try {
      process.kill(Number(readFileSync(join(directory, "pid"), "utf8")), "SIGKILL");
    } catch {}

    rmSync(directory, { recursive: true, force: true });
  }
});

function command(body: string): string[] {
  const directory = mkdtempSync(join(tmpdir(), "skills-read-"));
  directories.push(directory);
  return ["sh", "-c", body, "sh", join(directory, "pid")];
}

function failure(result: Read, kind: ReadFailure["kind"]): void {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failed read");
  expect(result.failure.kind).toBe(kind);
}

const held = 'sleep 30 & echo $! > "$1"; printf out';
const hung = 'sleep 30 & echo $! > "$1"; wait';
const ignoresTerm = 'trap "" TERM; sleep 30 & echo $! > "$1"; wait';
const stderrHeld = 'sleep 30 >&2 & echo $! > "$1"; printf out';

function floor(value?: string): Record<string, string | undefined> {
  return { ...suiteEnvironment(), SKILLS_READ_FLOOR_MS: value };
}

test("an exited child with held stdout ends after the fixed grace", async () => {
  const started = performance.now();
  const result = await read(command(held), { deadline: 1500 });
  failure(result, "held");
  expect(performance.now() - started).toBeLessThan(2500);
});

test("exit near the deadline still gets a full pipe grace", async () => {
  const started = performance.now();
  const result = await read(command("sleep 0.2; " + held), { deadline: 500, env: floor() });
  failure(result, "held");
  expect(performance.now() - started).toBeGreaterThan(1100);
  expect(performance.now() - started).toBeLessThan(2000);
});

for (const body of [hung, ignoresTerm])
  test(`a hung child is bounded even with TERM ignored: ${body}`, async () => {
    const started = performance.now();
    const result = await read(command(body), { deadline: 150, env: floor() });
    failure(result, "deadline");
    expect(performance.now() - started).toBeLessThan(1500);
  });

test("stderr held after stdout EOF does not fail an async read", async () => {
  const started = performance.now();
  const result = await read(command(stderrHeld), { deadline: 1500 });
  expect(result).toMatchObject({ ok: true, code: 0, stdout: "out" });
  expect(performance.now() - started).toBeLessThan(2500);
});

for (const [name, run] of [
  ["async", read],
  ["sync", readSync],
] as const) {
  test(`${name} nonzero exit is output, not failure`, async () => {
    const result = await run(["sh", "-c", "printf out; printf error >&2; exit 1"], {
      deadline: 1500,
    });

    expect(result).toMatchObject({ ok: true, code: 1, stdout: "out", stderr: "error" });
  });

  test(`${name} missing binary is a spawn failure`, async () => {
    failure(await run(["/no/such/skills-read-binary"], { deadline: 1500 }), "spawn");
  });

  test(`${name} unsolicited signal is distinct from a deadline`, async () => {
    failure(await run(["sh", "-c", "kill -TERM $$"], { deadline: 1500 }), "signal");
  });

  test(`${name} preserves bytes and disables optional git locks`, async () => {
    const result = await run(
      ["sh", "-c", "printf '\\357\\273\\277%s\\r\\n' \"$GIT_OPTIONAL_LOCKS\""],
      {
        deadline: 1500,
        env: { GIT_OPTIONAL_LOCKS: "1" },
      },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(describe(result.failure));

    expect(result.stdout).toBe("0\r\n");
    expect([...result.bytes]).toEqual([239, 187, 191, 48, 13, 10]);
  });
}

for (const [name, run] of [
  ["async", read],
  ["sync", readSync],
] as const) {
  const slow = ["sh", "-c", "sleep 0.3; printf out"];
  const endless = ["sleep", "30"];

  test(`${name} floor from the process outlasts a short deadline`, async () => {
    expect(process.env.SKILLS_READ_FLOOR_MS).toBe("60000");
    expect(await run(slow, { deadline: 50 })).toMatchObject({ ok: true, code: 0, stdout: "out" });
  });

  test(`${name} floor from the call's environment outlasts a short deadline`, async () => {
    const result = await run(slow, { deadline: 50, env: floor("60000") });
    expect(result).toMatchObject({ ok: true, code: 0, stdout: "out" });
  });

  for (const value of [undefined, "", "0", "abc", "-1", "1.5"])
    test(`${name} floor ${value === undefined ? "unset" : JSON.stringify(value)} leaves the caller's deadline`, async () => {
      const result = await run(endless, { deadline: 50, env: floor(value) });
      failure(result, "deadline");
      if (result.ok) throw new Error("expected a failed read");

      expect(describe(result.failure)).toBe("sleep 30: no exit within 0.05 s");
    });

  test(`${name} floor under the caller's deadline never shortens it`, async () => {
    const result = await run(endless, { deadline: 50, env: floor("20") });
    if (result.ok) throw new Error("expected a failed read");
    expect(describe(result.failure)).toBe("sleep 30: no exit within 0.05 s");
  });

  test(`${name} floor that applied is the deadline the failure names`, async () => {
    const result = await run(endless, { deadline: 50, env: floor("80") });
    if (result.ok) throw new Error("expected a failed read");
    expect(describe(result.failure)).toBe("sleep 30: no exit within 0.08 s");
  });
}

test("floor leaves a longer deadline and no deadline as the caller passed them", () => {
  expect(floored(120_000, floor("60000"))).toBe(120_000);
  expect(floored(Number.POSITIVE_INFINITY, floor("60000"))).toBe(Number.POSITIVE_INFINITY);
  expect(floored(50, floor("60000"))).toBe(60_000);
  expect(floored(50, floor("9".repeat(400)))).toBe(2 ** 31 - 1);
});

for (const [body, kind] of [
  [held, "held"],
  [hung, "deadline"],
  [ignoresTerm, "deadline"],
  [stderrHeld, "held"],
] as const)
  test(`sync pipes and child are bounded: ${body}`, () => {
    const started = performance.now();
    failure(readSync(command(body!), { deadline: 150, env: floor() }), kind!);
    expect(performance.now() - started).toBeLessThan(1000);
  });

test("labels exclude query bodies and clip long tokens", async () => {
  const result = await read(
    ["/no/such/binary", "api", "graphql", "-f", `query=${"secret ".repeat(1000)}`],
    { deadline: 100 },
  );

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error("expected a failed read");

  expect(result.failure.read).toBe("/no/such/binary api graphql -f");
  expect(describe({ kind: "held", read: "gh api graphql -f" })).toBe(
    "gh api graphql -f: a child process kept its output open",
  );

  expect(
    describe({ kind: "deadline", read: "git config --get branch.x.skills-base", deadline: 2000 }),
  ).toBe("git config --get branch.x.skills-base: no exit within 2 s");

  const clipped = await read(["/no/such/binary", "x".repeat(80) + " rest"], { deadline: 100 });
  if (clipped.ok) throw new Error("expected a failed read");

  expect(clipped.failure.read).toBe("/no/such/binary " + "x".repeat(40));
});

test("a fast read leaves no deadline timer keeping its caller alive", async () => {
  const started = performance.now();
  const result = await runCommand(
    [
      process.execPath,
      "-e",
      `import { read } from ${JSON.stringify(join(import.meta.dir, "read.ts"))}; await read(["true"], { deadline: 3000 });`,
    ],
    { cwd: import.meta.dir, env: suiteEnvironment(), timeout: 5000 },
  );

  expect(result).toMatchObject({ code: 0, timedOut: false, stderr: "" });
  expect(performance.now() - started).toBeLessThan(1000);
});
