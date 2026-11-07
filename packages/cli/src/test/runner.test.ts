import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Suite } from "../registry.ts";
import { createRepo, fakeSuite, writeFixture } from "./fixtures.ts";
import { removeTemporary, runCommand, startCommand, suiteEnvironment } from "./process.ts";
import { runSuites } from "./runner.ts";

const hide = "\u001b[?25l";
const show = "\u001b[?25h";

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

async function until(ready: () => boolean, what: string): Promise<void> {
  const deadline = performance.now() + 5000;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await delay(10);
  }
}

async function waitForFile(path: string): Promise<void> {
  await until(() => existsSync(path), `fixture output ${path}`);
}

async function writeEntry(repo: string, suites: readonly Suite[], jobs: number): Promise<void> {
  await writeFixture(
    repo,
    "entry.ts",
    `import { runSuites } from ${JSON.stringify(join(import.meta.dir, "runner.ts"))};\nprocess.exitCode = await runSuites(${JSON.stringify(repo)}, ${JSON.stringify(suites)}, { jobs: ${jobs} });\n`,
  );
}

function colorEnvironment(): NodeJS.ProcessEnv {
  const { NO_COLOR: _, ...env } = suiteEnvironment();
  return { ...env, TERM: "xterm-256color", FORCE_COLOR: "1", COLUMNS: "100" };
}

function terminal(repo: string) {
  const decoder = new TextDecoder();
  let output = "";
  const pty = new Bun.Terminal({
    cols: 100,
    rows: 30,
    data(_term, bytes) {
      output += decoder.decode(bytes, { stream: true });
    },
  });

  const child = Bun.spawn([process.execPath, "entry.ts"], {
    cwd: repo,
    env: colorEnvironment(),
    terminal: pty,
  });

  const exited = (async () => {
    const code = await child.exited;
    await delay(50);
    return code;
  })();

  return {
    exited,
    interrupt: () => child.kill("SIGINT"),
    output: () => output.replaceAll("\r\n", "\n"),
    text: () => Bun.stripANSI(output),
    close() {
      child.kill("SIGKILL");
      pty.close();
    },
  };
}

function lastFrame(output: string): string {
  return Bun.stripANSI(output.slice(output.lastIndexOf("\u001b[J")));
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

  test("piped stdout keeps the plain grammar even when the environment asks for color", async () => {
    const repo = await fixture();
    await writeFixture(repo, "pass.sh", 'printf "hidden success\\n"\n');
    await writeFixture(
      repo,
      "fail.sh",
      'printf "failed stdout\\n"\nprintf "failed stderr\\n" >&2\nexit 7\n',
    );

    await writeEntry(
      repo,
      [fakeSuite("pass", { seconds: 2 }), fakeSuite("fail", { seconds: 1 })],
      1,
    );

    const result = await runCommand([process.execPath, "entry.ts"], {
      cwd: repo,
      env: colorEnvironment(),
      timeout: 10_000,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).toMatch(/^ok pass \d+\.\ds\nFAIL fail \d+\.\ds\nFAIL 1 of 2 suites\n$/);
    expect(result.stderr).toBe("failed stdout\nfailed stderr\n");
  });

  test("a live run redraws one region in place, then prints failures and the summary", async () => {
    const repo = await fixture();
    await writeFixture(repo, "pass.sh", "exit 0\n");
    await writeFixture(
      repo,
      "fail.sh",
      'printf "failed stdout\\n"\nprintf "failed stderr\\n" >&2\nexit 7\n',
    );

    const { output, options } = capture();
    const live = { color: false, home: "", columns: () => 1000 };
    const suites = [fakeSuite("fail", { seconds: 1 }), fakeSuite("pass", { seconds: 2 })];

    expect(await runSuites(repo, suites, { ...options, jobs: 1, live })).toBe(1);
    expect(output.stderr).toBe("");

    const written = output.stdout.replaceAll(/\d+\.\ds/g, "N.Ns");
    expect(written.startsWith(`${hide}\nskills test · ${repo}\n\n  pass  queued\n`)).toBe(true);
    expect(written.split(hide)).toHaveLength(2);
    expect(written).toContain("\u001b[5A\r\u001b[J");
    expect(written.replaceAll("\u001b[5A", "")).not.toMatch(/\[\d+A/);
    expect(written.slice(written.lastIndexOf("\u001b[J") + 3)).toBe(
      [
        "",
        `skills test · ${repo}`,
        "",
        "  pass  ok       N.Ns",
        "  fail  FAIL     N.Ns",
        `${show}`,
        "FAIL fail N.Ns",
        "",
        "failed stdout",
        "failed stderr",
        "",
        "1 of 2 suites failed in N.Ns: fail",
        "",
      ].join("\n"),
    );
  });

  test("PTY shows the live view before a slow suite finishes", async () => {
    const repo = await fixture();
    await writeFixture(repo, "fast.sh", "exit 0\n");
    await writeFixture(repo, "slow.sh", "while [ ! -f release ]; do sleep 0.05; done\n");
    await writeEntry(
      repo,
      [fakeSuite("slow", { seconds: 30 }), fakeSuite("fast", { seconds: 1 })],
      2,
    );

    const run = terminal(repo);
    try {
      await until(
        () =>
          /slow +running +\d+s of ~30s/.test(run.text()) && /fast +ok +\d+\.\ds/.test(run.text()),
        "the live view",
      );

      expect(run.text()).not.toMatch(/slow +ok/);
      await writeFixture(repo, "release");

      expect(await run.exited).toBe(0);

      const output = run.output();
      expect(output.indexOf(hide)).toBeLessThan(output.indexOf("running"));
      expect(output.lastIndexOf(show)).toBeGreaterThan(output.lastIndexOf(hide));
      expect(lastFrame(output)).toMatch(
        /slow +ok +\d+\.\ds\n +fast +ok +\d+\.\ds\n\n2 suites passed in \d+\.\ds\n$/,
      );
    } finally {
      run.close();
    }
  }, 15_000);

  test("PTY SIGINT settles the view, shows the cursor and exits 130", async () => {
    const repo = await fixture();
    await writeFixture(repo, "fast.sh", "exit 0\n");
    await writeFixture(repo, "slow.sh", "sleep 30\n");
    await writeEntry(
      repo,
      [fakeSuite("slow", { seconds: 30 }), fakeSuite("fast", { seconds: 1 })],
      2,
    );

    const run = terminal(repo);
    try {
      await until(
        () => /slow +running/.test(run.text()) && /fast +ok/.test(run.text()),
        "the live view",
      );

      run.interrupt();

      expect(await run.exited).toBe(130);

      const output = run.output();
      expect(output.lastIndexOf(show)).toBeGreaterThan(output.lastIndexOf(hide));
      expect(lastFrame(output)).toMatch(
        /slow +stopped\n +fast +ok +\d+\.\ds\n\nStopped after \d+\.\ds with 1 of 2 suites finished\n$/,
      );
    } finally {
      run.close();
    }
  }, 15_000);

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    test(`${signal} kills running groups, removes TMPDIRs and exits 130`, async () => {
      const repo = await fixture();
      for (const name of ["first", "second"])
        await writeFixture(
          repo,
          `${name}.sh`,
          `sleep 30 &\nprintf '%s\\n' "$TMPDIR" > ${name}.path\nprintf '%s\\n' "$!" > ${name}.pid\nwait\n`,
        );

      await writeEntry(repo, [fakeSuite("first"), fakeSuite("second")], 2);

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
