import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createRepo, fakeSuite, writeFixture } from "./fixtures.ts";
import { removeTemporary, runCommand, startCommand, suiteEnvironment } from "./process.ts";
import { runSuites } from "./runner.ts";

const repositories: string[] = [];

async function fixture(): Promise<string> {
  const repo = await createRepo();
  repositories.push(repo);
  return repo;
}

function capture() {
  const output = { stdout: "", stderr: "" };
  const options = {
    stdout: (text: string) => {
      output.stdout += text;
    },
    stderr: (text: string) => {
      output.stderr += text;
    },
  };

  return { output, options };
}

async function waitForFile(path: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!existsSync(path)) {
    if (performance.now() > deadline) throw new Error(`missing fixture output: ${path}`);
    await delay(10);
  }
}

async function expectDescendantGone(repo: string, path: string): Promise<void> {
  const pid = Number((await readFile(join(repo, path), "utf8")).trim());
  expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
  const deadline = performance.now() + 5000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      expect(error).toHaveProperty("code", "ESRCH");
      return;
    }

    if (performance.now() > deadline) throw new Error(`descendant still exists: ${pid}`);

    await delay(10);
  }
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeTemporary));
});

describe("runner", () => {
  test("prints one line per suite, captures failure output and removes distinct TMPDIRs", async () => {
    const repo = await fixture();
    await writeFixture(
      repo,
      "pass.sh",
      'printf "%s\\n" "$TMPDIR" > pass.path\nprintf "hidden success\\n"\n',
    );

    await writeFixture(
      repo,
      "fail.sh",
      'printf "%s\\n" "$TMPDIR" > fail.path\nprintf "failed stdout\\n"\nprintf "failed stderr\\n" >&2\nexit 7\n',
    );

    const { output, options } = capture();

    expect(
      await runSuites(repo, [fakeSuite("pass"), fakeSuite("fail")], { ...options, jobs: 2 }),
    ).toBe(1);

    const lines = output.stdout.trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.filter((line) => /^ok pass \d+\.\ds$/.test(line))).toHaveLength(1);
    expect(lines.filter((line) => /^FAIL fail \d+\.\ds$/.test(line))).toHaveLength(1);
    expect(lines.at(-1)).toBe("FAIL 1 of 2 suites");

    expect(output.stderr).toBe("failed stdout\nfailed stderr\n");

    const directories = await Promise.all(
      ["pass.path", "fail.path"].map(async (path) =>
        (await readFile(join(repo, path), "utf8")).trim(),
      ),
    );

    expect(new Set(directories).size).toBe(2);
    expect(directories.every((path) => !existsSync(path))).toBe(true);
  });

  test("success and empty runs use the final grammar and exit zero", async () => {
    const repo = await fixture();
    await writeFixture(repo, "pass.sh", "exit 0\n");
    const { output, options } = capture();

    expect(await runSuites(repo, [fakeSuite("pass")], options)).toBe(0);
    expect(output.stdout).toMatch(/^ok pass \d+\.\ds\nok 1 suites\n$/);
    output.stdout = "";

    expect(await runSuites(repo, [], options)).toBe(0);
    expect(output.stdout).toBe("ok 0 suites\n");
  });

  test("longest measured suites start first", async () => {
    const repo = await fixture();
    for (const name of ["short", "long", "medium"])
      await writeFixture(repo, `${name}.sh`, `printf '${name}\\n' >> order\n`);

    const { options } = capture();
    const suites = [
      fakeSuite("short", { seconds: 1 }),
      fakeSuite("long", { seconds: 3 }),
      fakeSuite("medium", { seconds: 2 }),
    ];

    expect(await runSuites(repo, suites, { ...options, jobs: 1 })).toBe(0);
    expect(await readFile(join(repo, "order"), "utf8")).toBe("long\nmedium\nshort\n");
  });

  test("removes read only temporary contents", async () => {
    const repo = await fixture();
    await writeFixture(
      repo,
      "readonly.sh",
      'printf "%s\\n" "$TMPDIR" > temporary\nmkdir "$TMPDIR/nested"\ntouch "$TMPDIR/nested/file"\nchmod 000 "$TMPDIR/nested/file" "$TMPDIR/nested" "$TMPDIR"\n',
    );

    const { options } = capture();

    expect(await runSuites(repo, [fakeSuite("readonly")], options)).toBe(0);
    expect(existsSync((await readFile(join(repo, "temporary"), "utf8")).trim())).toBe(false);
  });

  test("scrubs every GIT variable from suite environments", () => {
    expect(
      suiteEnvironment({
        PATH: "/bin",
        TMPDIR: "/tmp",
        GIT_DIR: "wrong",
        GIT_CONFIG_GLOBAL: "wrong",
        GIT_UNEXPECTED: "wrong",
      }),
    ).toEqual({ PATH: "/bin", TMPDIR: "/tmp" });
  });

  test("expiry fails, kills descendants and removes TMPDIR", async () => {
    const repo = await fixture();
    await writeFixture(
      repo,
      "deadline.sh",
      'sleep 30 &\nprintf "%s\\n" "$TMPDIR" > temporary\nprintf "%s\\n" "$!" > descendant.pid\nwait\n',
    );

    const { output, options } = capture();

    expect(await runSuites(repo, [fakeSuite("deadline", { timeout: 1 })], options)).toBe(1);
    expect(output.stdout).toMatch(/^FAIL deadline \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(output.stderr).toContain("deadline: timed out");
    expect(existsSync((await readFile(join(repo, "temporary"), "utf8")).trim())).toBe(false);
    await expectDescendantGone(repo, "descendant.pid");
  }, 10_000);

  test("expiry returns despite an escaped descendant holding pipes", async () => {
    const repo = await fixture();
    const started = performance.now();
    const result = await runCommand(["sh", "-c", 'perl -e "setpgrp(0,0); sleep 6" & sleep 30'], {
      cwd: repo,
      timeout: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(performance.now() - started).toBeLessThan(4000);
  }, 10_000);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    test(`${signal} kills running groups, removes TMPDIRs and exits 130`, async () => {
      const repo = await fixture();
      for (const name of ["first", "second"])
        await writeFixture(
          repo,
          `${name}.sh`,
          `sleep 30 &\nprintf '%s\\n' "$TMPDIR" > ${name}.path\nprintf '%s\\n' "$!" > ${name}.pid\nwait\n`,
        );

      const suites = [fakeSuite("first"), fakeSuite("second")];
      await writeFixture(
        repo,
        "entry.ts",
        `import { runSuites } from ${JSON.stringify(join(import.meta.dir, "runner.ts"))};\nprocess.exitCode = await runSuites(${JSON.stringify(repo)}, ${JSON.stringify(suites)}, { jobs: 2 });\n`,
      );

      const command = startCommand([process.execPath, "entry.ts"], { cwd: repo, timeout: 10_000 });
      try {
        await Promise.all(["first.pid", "second.pid"].map((path) => waitForFile(join(repo, path))));

        command.child.kill(signal);

        const result = await command.result;
        expect(result.code).toBe(130);
        expect(result.timedOut).toBe(false);

        for (const name of ["first", "second"]) {
          const directory = (await readFile(join(repo, `${name}.path`), "utf8")).trim();
          expect(existsSync(directory)).toBe(false);
          await expectDescendantGone(repo, `${name}.pid`);
        }
      } finally {
        command.child.kill("SIGTERM");
        await command.result;
      }
    }, 15_000);
});
