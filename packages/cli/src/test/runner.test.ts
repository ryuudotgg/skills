import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, readFile, rm } from "node:fs/promises";
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

  for (const [code, verdict, summary] of [
    [0, "ok", "ok 1 suites"],
    [7, "FAIL", "FAIL 1 of 1 suites"],
  ] as const)
    test(`a suite exiting ${code} has its leftover children ended before TMPDIR goes`, async () => {
      const repo = await fixture();
      await writeFixture(
        repo,
        "leftover.sh",
        `sleep 30 &\nprintf "%s\\n" "$!" > descendant.pid\nprintf "%s\\n" "$TMPDIR" > temporary\nexit ${code}\n`,
      );

      const { output, options } = capture();
      const started = performance.now();

      expect(await runSuites(repo, [fakeSuite("leftover")], options)).toBe(code === 0 ? 0 : 1);
      expect(performance.now() - started).toBeLessThan(2000);
      expect(output.stdout).toMatch(
        new RegExp(`^${verdict} leftover \\d+\\.\\ds\\n${summary}\\n$`),
      );

      await expectDescendantGone(repo, "descendant.pid");
      expect(existsSync((await readFile(join(repo, "temporary"), "utf8")).trim())).toBe(false);
    }, 10_000);

  test("a command with closed pipes settles with its background child gone", async () => {
    const repo = await fixture();
    const result = await runCommand(["sh", "-c", "sleep 30 >/dev/null 2>&1 & echo $!"], {
      cwd: repo,
    });

    expect(result.code).toBe(0);
    expect(result.timedOut).toBe(false);
    const pid = Number(result.stdout.trim());
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
  }, 10_000);

  test("a clean exit settles without waiting for an escaped descendant", async () => {
    const repo = await fixture();
    const started = performance.now();
    const result = await runCommand(
      [
        "sh",
        "-c",
        'perl -e "setpgrp(0,0); open(my \\$f, q(>escaped)); close(\\$f); sleep 6" & while [ ! -f escaped ]; do sleep 0.01; done; echo $!',
      ],
      { cwd: repo },
    );

    const pid = Number(result.stdout.trim());
    try {
      expect(result.code).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(performance.now() - started).toBeLessThan(4000);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
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

const fakeBun = `#!/bin/sh
report=
for arg in "$@"; do
  case "$arg" in
    --reporter-outfile=*) report=\${arg#--reporter-outfile=} ;;
  esac
done

before=0
[ -f calls ] && before=$(wc -l < calls)
printf '%s|%s|%s\\n' "$*" "$TMPDIR" "$(ls slow.done 2>/dev/null)" >> calls

suite() {
  printf '<testsuite name="%s" file="%s"><testcase name="one" file="%s">%s</testcase></testsuite>' "$1" "$1" "$1" "$2"
}

suites() {
  for name in \${FILES:-a b}; do suite "$name.test.ts" "$1"; done
}

write() {
  [ -n "$report" ] || return 0
  printf '<testsuites>%s</testsuites>' "$(suites "$1")" > "$report"
}

fail() {
  write '<failure />'
  set -- \${FILES:-a b}
  printf 'first output\\n %s fail\\n' "$#" >&2
}

case "\${MODE:-named}" in
  silent) ;;
  clean) write '' ;;
  unnamed) write '<failure />'; printf ' 3 fail\\n 1 error\\n' >&2 ;;
  hang) fail; sleep 30 ;;
  named) fail ;;
  flaky) [ "$before" -eq 0 ] && fail || { write ''; exit 0; } ;;
  slow) fail; [ "$before" -eq 0 ] || { touch sleeping; sleep 30; } ;;
esac

exit 1
`;

async function fakeBunSuite(
  repo: string,
  name: string,
  mode: string,
  fields: Partial<Suite> = {},
): Promise<Suite> {
  await writeFixture(repo, "bin/bun", fakeBun);
  await chmod(join(repo, "bin/bun"), 0o755);

  const argv = ["env", `MODE=${mode}`, "FILES=a b", join(repo, "bin/bun"), "test", "--isolate"];
  return fakeSuite(name, { argv, ...fields });
}

async function calls(repo: string): Promise<string[]> {
  return (await readFile(join(repo, "calls"), "utf8")).trim().split("\n");
}

const cases = {
  pass: (name: string) => `test(${name}, () => {});`,
  fail: (name: string) => `test(${name}, () => { throw new Error("always"); });`,
  flaky: (name: string) => `test(${name}, () => { if (first) throw new Error("busy"); });`,
  late: (name: string) => `test(${name}, () => { if (!first) throw new Error("rerun only"); });`,
  once: (name: string) => `if (first) test(${name}, () => { throw new Error("once"); });`,
  moved: (name: string) =>
    `if (first) test(${name}, () => { throw new Error("once"); });\nelse test(${name}, () => {});`,
};

type Cases = Record<string, keyof typeof cases>;

async function bunSuite(
  repo: string,
  name: string,
  files: Record<string, Cases>,
  flag = "--isolate",
): Promise<Suite> {
  for (const [file, tests] of Object.entries(files))
    await writeFixture(
      repo,
      `${name}/${file}.test.ts`,
      [
        'import { describe, test } from "bun:test";',
        'import { appendFileSync, existsSync } from "node:fs";',
        'const runs = import.meta.path + ".runs";',
        "const first = !existsSync(runs);",
        'appendFileSync(runs, process.env.TMPDIR + "\\n");',
        'describe("group", () => {',
        ...Object.entries(tests).map(([test, kind]) => cases[kind](JSON.stringify(test))),
        "});",
        "",
      ].join("\n"),
    );

  return fakeSuite(name, { cwd: name, argv: [process.execPath, "test", flag] });
}

async function runs(repo: string, name: string, file = name): Promise<string[]> {
  return (await readFile(join(repo, name, `${file}.test.ts.runs`), "utf8")).trim().split("\n");
}

describe("rerun", () => {
  test("a flaky test passes its suite and is named after the suite's line", async () => {
    const repo = await fixture();
    const suite = await bunSuite(repo, "busy", {
      busy: { steady: "pass", "waits on the machine": "flaky" },
    });

    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(0);
    expect(output.stdout).toMatch(
      /^ok busy \d+\.\ds\nflaky busy\/busy\.test\.ts: group > waits on the machine\nok 1 suites, 1 flaky\n$/,
    );

    expect(output.stderr).toBe("");

    const directories = await runs(repo, "busy");
    expect(directories).toHaveLength(2);
    expect(new Set(directories).size).toBe(2);
    expect(directories.every((path) => !existsSync(path))).toBe(true);
  });

  test("a parallel suite reruns only the file that failed and names its flaky test", async () => {
    const repo = await fixture();
    const files: Record<string, Cases> = {
      wide: { steady: "pass", "waits on the machine": "flaky" },
      calm: { steady: "pass" },
    };

    const suite = await bunSuite(repo, "wide", files, "--parallel");
    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(0);
    expect(output.stdout).toMatch(
      /^ok wide \d+\.\ds\nflaky wide\/wide\.test\.ts: group > waits on the machine\nok 1 suites, 1 flaky\n$/,
    );

    expect(await runs(repo, "wide")).toHaveLength(2);
    expect(await runs(repo, "wide", "calm")).toHaveLength(1);
  });

  test("flaky naming leaves a test that fails twice failing, with the output of both runs", async () => {
    const repo = await fixture();
    const suite = await bunSuite(repo, "broken", {
      broken: { steady: "pass", "never works": "fail" },
    });

    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(1);
    expect(output.stdout).toMatch(/^FAIL broken \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(await runs(repo, "broken")).toHaveLength(2);

    const [first, again] = output.stderr.split("broken: rerun broken/broken.test.ts\n");
    expect(Bun.stripANSI(first ?? "")).toContain("error: always");
    expect(Bun.stripANSI(again ?? "")).toContain("error: always");
  });

  test("a suite with one flaky and one failing test fails and still names the flaky one", async () => {
    const repo = await fixture();
    const suite = await bunSuite(repo, "mixed", {
      mixed: {
        "never works": "fail",
        "waits on the machine": "flaky",
      },
    });

    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(1);
    expect(output.stdout).toMatch(
      /^FAIL mixed \d+\.\ds\nflaky mixed\/mixed\.test\.ts: group > waits on the machine\nFAIL 1 of 1 suites\n$/,
    );
  });

  test("no rerun counts when a first run failure is missing from its report", async () => {
    const repo = await fixture();
    const suite = await bunSuite(repo, "gone", {
      gone: {
        steady: "pass",
        "fails once then hides": "once",
        "comes back on another line": "moved",
      },
    });

    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(1);
    expect(output.stdout).toMatch(/^FAIL gone \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(await runs(repo, "gone")).toHaveLength(2);

    const [first, again] = output.stderr.split("gone: rerun gone/gone.test.ts\n");
    expect(Bun.stripANSI(first ?? "")).toContain("error: once");
    expect(Bun.stripANSI(again ?? "")).toMatch(/^ 2 pass\n 0 fail$/m);
  });

  test("no rerun counts when a test that passed first fails in it", async () => {
    const repo = await fixture();
    const suite = await bunSuite(repo, "late", {
      late: {
        "waits on the machine": "flaky",
        "breaks alone": "late",
      },
    });

    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(1);
    expect(output.stdout).toMatch(
      /^FAIL late \d+\.\ds\nflaky late\/late\.test\.ts: group > waits on the machine\nFAIL 1 of 1 suites\n$/,
    );

    const [, again] = output.stderr.split("late: rerun late/late.test.ts\n");
    expect(Bun.stripANSI(again ?? "")).toContain("error: rerun only");
  });

  test("no rerun for a suite that reached its cap", async () => {
    const repo = await fixture();
    const suite = await fakeBunSuite(repo, "capped", "hang", { timeout: 1 });
    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(1);
    expect(output.stdout).toMatch(/^FAIL capped \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(output.stderr).toBe("first output\n 2 fail\ncapped: timed out\n");
    expect(await calls(repo)).toHaveLength(1);
  }, 10_000);

  for (const [mode, why] of [
    ["silent", "that left no report"],
    ["clean", "whose report names no failing test"],
    ["unnamed", "where bun counted a failure its report does not name"],
  ] as const)
    test(`no rerun for a failed suite ${why}`, async () => {
      const repo = await fixture();
      const suite = await fakeBunSuite(repo, "failed", mode);
      const { output, options } = capture();

      expect(await runSuites(repo, [suite], options)).toBe(1);
      expect(output.stdout).toMatch(/^FAIL failed \d+\.\ds\nFAIL 1 of 1 suites\n$/);
      expect(output.stderr).not.toContain("rerun");
      expect(await calls(repo)).toHaveLength(1);
    });

  test("no rerun for a command that is not bun test, or that shares one global across its files", async () => {
    const repo = await fixture();
    const named = await fakeBunSuite(repo, "named", "named");
    const { output, options } = capture();
    for (const argv of [
      ["sh", "bin/bun", "test", "--isolate"],
      ["env", "MODE=named", join(repo, "bin/bun"), "test"],
      ["env", "MODE=named", join(repo, "bin/bun"), "test", "--isolate", "--bail"],
    ]) {
      expect(await runSuites(repo, [{ ...named, argv }], options)).toBe(1);
      expect(output.stdout).toMatch(/^FAIL named \d+\.\ds\nFAIL 1 of 1 suites\n$/);
      expect(output.stderr).not.toContain("rerun");
      expect(await calls(repo)).toHaveLength(1);

      await rm(join(repo, "calls"));
      output.stdout = "";
      output.stderr = "";
    }

    expect(await runSuites(repo, [named], options)).toBe(1);
    expect(output.stdout).toMatch(/^FAIL named \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(output.stderr).toBe(
      [
        "first output\n 2 fail\n",
        "named: rerun a.test.ts\nfirst output\n 2 fail\n",
        "named: rerun b.test.ts\nfirst output\n 2 fail\n",
      ].join(""),
    );

    expect(await calls(repo)).toHaveLength(3);
  });

  test("no rerun when more files failed than a busy machine explains", async () => {
    const repo = await fixture();
    const suite = await fakeBunSuite(repo, "broad", "named");
    const { output, options } = capture();
    const files = (names: string) => suite.argv.map((arg) => (arg === "FILES=a b" ? names : arg));

    expect(await runSuites(repo, [{ ...suite, argv: files("FILES=a b c d e f") }], options)).toBe(
      1,
    );

    expect(output.stdout).toMatch(/^FAIL broad \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(output.stderr).toBe("first output\n 6 fail\n");
    expect(await calls(repo)).toHaveLength(1);

    await rm(join(repo, "calls"));

    expect(await runSuites(repo, [{ ...suite, argv: files("FILES=a b c d e") }], options)).toBe(1);
    expect(await calls(repo)).toHaveLength(6);
  });

  test("the rerun waits for every other suite, then runs each failing file alone in its own TMPDIR", async () => {
    const repo = await fixture();
    await writeFixture(
      repo,
      "slow.sh",
      "while [ ! -f calls ]; do sleep 0.01; done\ntouch slow.done\n",
    );

    const flaky = await fakeBunSuite(repo, "flaky", "flaky", { seconds: 2 });
    const { output, options } = capture();

    expect(
      await runSuites(repo, [fakeSuite("slow", { seconds: 1 }), flaky], { ...options, jobs: 2 }),
    ).toBe(0);

    expect(output.stdout).toMatch(
      /^ok slow \d+\.\ds\nok flaky \d+\.\ds\nflaky a\.test\.ts: one\nflaky b\.test\.ts: one\nok 2 suites, 2 flaky\n$/,
    );

    const [first, ...reruns] = (await calls(repo)).map((line) => line.split("|"));
    expect(first?.[2]).toBe("");
    expect(reruns.map(([args, , done]) => [args?.split(" ").at(-1), done])).toEqual([
      [join(repo, "a.test.ts"), "slow.done"],
      [join(repo, "b.test.ts"), "slow.done"],
    ]);

    const directories = [first, ...reruns].map((call) => call?.[1] ?? "");
    expect(new Set(directories).size).toBe(3);
    expect(directories.every((path) => path !== "" && !existsSync(path))).toBe(true);
  });

  test("a rerun gets what is left of the suite cap, and a file with none left is not started", async () => {
    const repo = await fixture();
    const suite = await fakeBunSuite(repo, "slow", "slow", { timeout: 1 });
    const { output, options } = capture();

    expect(await runSuites(repo, [suite], options)).toBe(1);
    expect(output.stdout).toMatch(/^FAIL slow \d+\.\ds\nFAIL 1 of 1 suites\n$/);
    expect(output.stderr).toBe(
      [
        "first output\n 2 fail\n",
        "slow: rerun a.test.ts\nfirst output\n 2 fail\nslow: timed out\n",
        "slow: no time left to rerun b.test.ts\n",
      ].join(""),
    );

    expect(await calls(repo)).toHaveLength(2);
  }, 10_000);

  test("a live run marks the suite for rerun, then lists its flaky tests above the summary", async () => {
    const repo = await fixture();
    const suite = await fakeBunSuite(repo, "bun", "flaky");
    const { output, options } = capture();
    const live = { color: false, home: "", columns: () => 1000 };

    expect(await runSuites(repo, [suite], { ...options, live })).toBe(0);

    const written = output.stdout.replaceAll(/\d+\.\ds/g, "N.Ns");
    expect(written).toContain("  bun  rerun    failed in N.Ns\n");
    expect(written.slice(written.lastIndexOf("\u001b[J") + 3)).toBe(
      [
        "",
        `skills test · ${repo}`,
        "",
        "  bun  ok       N.Ns",
        `${show}`,
        "flaky a.test.ts: one",
        "flaky b.test.ts: one",
        "",
        "1 suite passed in N.Ns, 2 flaky",
        "",
      ].join("\n"),
    );
  });

  test("an interrupt during a rerun keeps what both runs printed and starts no other file", async () => {
    const repo = await fixture();
    const suite = await fakeBunSuite(repo, "held", "slow");
    const { output, options } = capture();
    const controller = new AbortController();
    const run = runSuites(repo, [suite], { ...options, signal: controller.signal });

    await waitForFile(join(repo, "sleeping"));
    controller.abort();

    expect(await run).toBe(130);
    expect(output.stdout).toMatch(/^FAIL held \d+\.\ds\n$/);
    expect(output.stderr).toBe(
      "first output\n 2 fail\nheld: rerun a.test.ts\nfirst output\n 2 fail\n",
    );

    expect(await calls(repo)).toHaveLength(2);
  });

  test("an interrupt while a suite waits for its rerun still shows its failure", async () => {
    const repo = await fixture();
    await writeFixture(repo, "blocker.sh", "sleep 30\n");

    const held = await fakeBunSuite(repo, "held", "named", { seconds: 2 });
    const { output, options } = capture();
    const live = { color: false, home: "", columns: () => 1000 };
    const controller = new AbortController();
    const run = runSuites(repo, [held, fakeSuite("blocker", { seconds: 1 })], {
      ...options,
      jobs: 2,
      live,
      signal: controller.signal,
    });

    await until(() => output.stdout.includes("  held     rerun"), "the held suite");
    controller.abort();

    expect(await run).toBe(130);
    expect(await calls(repo)).toHaveLength(1);

    const end = output.stdout.slice(output.stdout.lastIndexOf(show));
    expect(end).toMatch(
      /FAIL held \d+\.\ds\n\nfirst output\n 2 fail\n\nStopped after \d+\.\ds with 1 of 2 suites finished, 1 failed: held\n$/,
    );
  });
});
