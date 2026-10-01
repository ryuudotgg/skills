import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, rmSync, symlinkSync } from "node:fs";
import { chmod, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Context, Port } from "../registry.ts";
import { commitFixture, createRepo, fixtureGit, writeFixture } from "./fixtures.ts";
import { runParity, type ParityTree, type Stub } from "./parity.ts";
import { shellQuote } from "../shell.ts";
import { removeTemporary, runCommand, suiteEnvironment } from "./process.ts";

const repositories: string[] = [];
const checkout = resolve(import.meta.dir, "../..");

async function fixture(): Promise<Context> {
  const repo = await createRepo();
  repositories.push(repo);
  await writeFixture(repo, "skills/demo/scripts/tool.sh", "#!/bin/sh\nprintf 'tool %s\\n' \"$*\"\n");
  await writeFixture(
    repo,
    "skills/demo/scripts/test-tool.sh",
    '#!/bin/sh\nset -eu\nscript_dir=$(CDPATH= cd "$(dirname "$0")" && pwd)\n[ "$(sh "$script_dir/tool.sh" a b)" = "tool a b" ]\necho ok\n',
  );

  for (const name of ["round.sh", "settings.sh"])
    await writeFixture(repo, `skills/playbook/scripts/${name}`, "#!/bin/sh\nexit 0\n");

  await commitFixture(repo);
  await fixtureGit(repo, ["config", "branch.main.skills-base", "main"]);

  return {
    root: join(repo, "skills"),
    repo,
    bin: join(checkout, "skills/playbook/bin/skills"),
    suites: [],
    ports: [],
  };
}

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeTemporary));
});

describe("parity", () => {
  test.each([
    ["base", "file"],
    ["base", "parent"],
    ["tree", "file"],
    ["tree", "parent"],
  ] as const)("refuses a symlinked %s %s without changing its outside file", async (side, component) => {
    const ctx = await fixture();
    const outside = await createRepo();
    repositories.push(outside);

    const legacy = "legacy/tool.sh";
    const source = "#!/bin/sh\nexit 0\n";

    await writeFixture(outside, "tool.sh", source);
    await writeFixture(ctx.repo, legacy, source);
    await writeFixture(ctx.repo, "test-safe.sh", source);
    const linked = component === "file" ? legacy : "legacy";
    const destination = component === "file" ? join(outside, "tool.sh") : outside;
    if (side === "base") {
      await rm(join(ctx.repo, linked), { recursive: true });
      await symlink(destination, join(ctx.repo, linked));
    }

    await commitFixture(ctx.repo);

    await expect(
      runParity(ctx, "test-safe.sh", {
        stubs: (paths) => {
          if (side === "tree") {
            rmSync(join(paths.tree, linked), { recursive: true });
            symlinkSync(destination, join(paths.tree, linked));
          }

          return [{ legacy, command: "false" }];
        },
      }),
    ).rejects.toThrow(`parity: symlinked path: ${legacy}`);

    expect(await readFile(join(outside, "tool.sh"), "utf8")).toBe(source);
  });

  test("a tool passes with the base implementation and fails with false", async () => {
    const ctx = await fixture();
    let stdout = "";
    let stderr = "";
    let extracted: ParityTree | undefined;
    const capture = {
      stdout: (text: string) => {
        stdout += text;
      },
      stderr: (text: string) => {
        stderr += text;
      },
    };

    const stubs = (paths: ParityTree): Stub[] => {
      extracted = paths;

      return [
        {
          legacy: "skills/demo/scripts/tool.sh",
          command: `bash ${shellQuote(join(paths.base, "skills/demo/scripts/tool.sh"))}`,
        },
      ];
    };

    expect(
      await runParity(ctx, "skills/demo/scripts/test-tool.sh", { ...capture, stubs }),
    ).toBe(0);

    expect(stdout).toMatch(/^ok test-tool \d+\.\ds\nok 1 suites\n$/);
    expect(stderr).toBe("");

    expect(extracted).toBeDefined();
    expect(existsSync(extracted?.base ?? "")).toBe(false);
    expect(existsSync(extracted?.tree ?? "")).toBe(false);
    stdout = "";

    expect(
      await runParity(ctx, "skills/demo/scripts/test-tool.sh", {
        ...capture,
        stubs: () => [{ legacy: "skills/demo/scripts/tool.sh", command: "false" }],
      }),
    ).toBe(1);

    expect(stdout).toMatch(/^FAIL test-tool \d+\.\ds\nFAIL 1 of 1 suites\n$/);
  }, 20_000);

  test("CLI expands the literal base path in custom stubs", async () => {
    const ctx = await fixture();
    const temporary = join(ctx.repo, "space and ' quote");
    await mkdir(temporary);
    const argv = [
      ctx.bin,
      "--root",
      ctx.root,
      "test",
      "--parity",
      "skills/demo/scripts/test-tool.sh",
      "--stub",
      "skills/demo/scripts/tool.sh=bash <base>/skills/demo/scripts/tool.sh",
    ];

    const pass = await runCommand(argv, {
      cwd: ctx.repo,
      env: { ...suiteEnvironment(), TMPDIR: temporary },
    });

    expect(pass.code).toBe(0);
    expect(pass.stdout).toMatch(/^ok test-tool \d+\.\ds\nok 1 suites\n$/);
    const fail = await runCommand(
      [...argv.slice(0, -1), "skills/demo/scripts/tool.sh=false"],
      { cwd: ctx.repo },
    );

    expect(fail.code).toBe(1);
    expect(fail.stdout).toMatch(/^FAIL test-tool \d+\.\ds\nFAIL 1 of 1 suites\n$/);
  }, 20_000);

  test("refuses zero stubs, missing suites, missing ports and sourced libraries", async () => {
    const ctx = await fixture();
    await writeFixture(ctx.repo, "skills/demo/scripts/library.sh", "return 0\n");
    await commitFixture(ctx.repo);

    await expect(runParity(ctx, "skills/demo/scripts/test-tool.sh")).rejects.toThrow(
      "parity: nothing to stub",
    );

    await expect(
      runParity(ctx, "skills/demo/scripts/missing.sh", {
        stubs: () => [{ legacy: "skills/demo/scripts/tool.sh", command: "false" }],
      }),
    ).rejects.toThrow("parity: missing suite at base");

    await expect(
      runParity(
        { ...ctx, ports: [{ legacy: "missing.sh", verb: ["missing"] }] },
        "skills/demo/scripts/test-tool.sh",
      ),
    ).rejects.toThrow("parity: missing legacy file at base: missing.sh");

    await expect(
      runParity(ctx, "skills/demo/scripts/test-tool.sh", {
        stubs: () => [{ legacy: "skills/demo/scripts/library.sh", command: "false" }],
      }),
    ).rejects.toThrow("parity: legacy file has no shebang");
  }, 20_000);

  test("uses the merge base rather than the current base ref", async () => {
    const ctx = await fixture();
    const suite = "skills/demo/scripts/test-merge-base.sh";

    await writeFixture(ctx.repo, suite, "#!/bin/sh\nexit 0\n");
    await commitFixture(ctx.repo);
    await fixtureGit(ctx.repo, ["branch", "base"]);
    await fixtureGit(ctx.repo, ["checkout", "-q", "-b", "task"]);

    await rm(join(ctx.repo, suite));
    await writeFixture(ctx.repo, "task-only");

    await commitFixture(ctx.repo);

    await fixtureGit(ctx.repo, ["checkout", "-q", "base"]);
    await rm(join(ctx.repo, suite));
    await writeFixture(ctx.repo, "base-only");

    await commitFixture(ctx.repo);
    await fixtureGit(ctx.repo, ["checkout", "-q", "task"]);
    await fixtureGit(ctx.repo, ["config", "branch.task.skills-base", "base"]);

    expect(
      await runParity(ctx, suite, {
        stdout: () => {},
        stderr: () => {},
        stubs: () => [{ legacy: "skills/demo/scripts/tool.sh", command: "false" }],
      }),
    ).toBe(0);
  });

  test("bash shebangs and python suites run with their required interpreters", async () => {
    const ctx = await fixture();
    await writeFixture(
      ctx.repo,
      "test-bash.sh",
      '#!/bin/bash\nitems=(ok)\n[[ "${items[0]}" = ok ]]\n',
    );

    await writeFixture(
      ctx.repo,
      "test_python.py",
      "#!/usr/bin/env python3\nimport sys\nassert sys.dont_write_bytecode\n",
    );

    await commitFixture(ctx.repo);
    const options = {
      stdout: () => {},
      stderr: () => {},
      stubs: () => [{ legacy: "skills/demo/scripts/tool.sh", command: "false" }],
    };

    expect(await runParity(ctx, "test-bash.sh", options)).toBe(0);
    expect(await runParity(ctx, "test_python.py", options)).toBe(0);
  });

  test("registry stubs derive root after being copied into a fake skills tree", async () => {
    const ctx = await fixture();
    const bin = join(ctx.repo, "fake cli");
    await writeFixture(
      ctx.repo,
      "fake cli",
      '#!/bin/sh\n[ "$1" = --root ] && [ "$3" = plans ] && [ "$4" = frontier ] && [ "$5" = argument ]\n[ "$2" = "$EXPECTED_ROOT" ]\n',
    );

    await writeFixture(
      ctx.repo,
      "skills/demo/scripts/test-copy.sh",
      '#!/bin/sh\nset -eu\ngit rev-parse --verify HEAD > /dev/null\ngit diff --quiet HEAD -- "fake cli"\nmkdir -p "$TMPDIR/fake skills/demo/scripts"\ncp skills/demo/scripts/tool.sh "$TMPDIR/fake skills/demo/scripts/tool.sh"\nexport EXPECTED_ROOT="$TMPDIR/fake skills"\nsh "$TMPDIR/fake skills/demo/scripts/tool.sh" argument\n',
    );

    await fixtureGit(ctx.repo, ["add", "-A"]);
    await fixtureGit(ctx.repo, ["update-index", "--chmod=+x", "fake cli"]);
    await fixtureGit(ctx.repo, ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "fixture"]);
    await chmod(bin, 0o755);
    const ports: Port[] = [
      { legacy: "skills/demo/scripts/tool.sh", verb: ["plans", "frontier"] },
    ];

    let stderr = "";

    expect(
      await runParity({ ...ctx, bin, ports }, "skills/demo/scripts/test-copy.sh", {
        stdout: () => {},
        stderr: (text) => {
          stderr += text;
        },
      }),
    ).toBe(0);

    expect(stderr).toBe("");
    expect(
      await readFile(join(ctx.repo, "skills/demo/scripts/tool.sh"), "utf8"),
    ).not.toContain("exec");
  });
});
