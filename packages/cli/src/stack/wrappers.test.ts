import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { prListArgs } from "../plans/prs.ts";
import { fixRoundCase } from "../test/fix-round-fixture.ts";
import { prList } from "../test/fixtures.ts";
import { leaseCase, usage as leaseUsage } from "../test/lease-rebase-fixture.ts";
import { layerCase, usage as layerUsage } from "../test/restack-layer-fixture.ts";
import { stackCase } from "../test/stack-fixture.ts";
import {
  baseCase,
  belowCase,
  page,
  thread,
  threadArgs,
  verbCase,
} from "../test/stack-verbs-fixture.ts";
import { both, carriedBoth, root, within } from "../test/takeover-fixture.ts";

setDefaultTimeout(60_000);

const bin = resolve(import.meta.dir, "../../../../skills/playbook/bin/skills");

test.concurrent("chain wrapper", async () => {
  const fixture = await stackCase("skills-lease-rebase-wrapper-", { views: "deleted" });
  try {
    const { repo, state, git, command, stack, fixParent, expectClean, expectRebased, chainOutput } =
      await leaseCase(fixture, "chain-wrapper");

    await stack();
    await fixParent();

    const result = await command([bin, "lease-rebase", "a", state.oldA, "b", "c"], repo);
    expect([result.code, result.stderr]).toEqual([0, ""]);
    expect(result.stdout).toBe(await chainOutput());

    await expectRebased("b", state.oldB, "a", 1);
    await expectRebased("c", state.oldC, "b", 1);
    await expectClean();
    expect(await git(["rev-parse", "a"])).not.toBe(state.oldA);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("usage wrapper", async () => {
  const fixture = await stackCase("skills-lease-rebase-wrapper-", { views: "deleted" });
  try {
    const result = await fixture.command([bin, "lease-rebase"], fixture.temporary);
    expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${leaseUsage}\n`]);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("wrapper uses the case cwd and environment", async () => {
  const fixture = await stackCase("skills-restack-layer-wrapper-", {
    assertNoGhCalls: true,
    views: "deleted",
  });

  try {
    const { index, holderAt } = await layerCase(fixture, "wrapper");
    const holder = await holderAt("t3code-0000");
    await rm(index);

    const result = await fixture.command([bin, "restack-layer", "-P", "Proj"], holder);
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "restack-layer: no index.tsv for Proj\n",
    ]);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("usage wrapper", async () => {
  const fixture = await stackCase("skills-restack-layer-wrapper-", {
    assertNoGhCalls: true,
    views: "deleted",
  });

  try {
    const result = await fixture.command([bin, "restack-layer", "--bogus"], fixture.temporary);
    expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${layerUsage}\n`]);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("wrapper uses the case cwd and environment", async () => {
  const fixture = await stackCase("skills-fix-round-wrapper-", {
    assertNoGhCalls: true,
    views: "deleted",
  });

  try {
    const { index, holderAt } = await fixRoundCase(fixture, "wrapper");
    const holder = await holderAt("t3code-0000");
    await rm(index);

    const result = await fixture.command(
      [bin, "fix-round", "-P", "Proj", "-m", "fix: guard empty input", "round"],
      holder,
    );

    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "fix-round: no index.tsv for Proj\n",
    ]);
  } finally {
    await fixture.dispose();
  }
});

describe("fix-round legacy cases", () => {
  test.concurrent("getopts usage", async () => {
    const fixture = await stackCase("skills-fix-round-", {
      assertNoGhCalls: true,
      views: "deleted",
    });

    try {
      for (const args of [
        [],
        ["-P", "Proj", "round"],
        ["-P", "Proj", "-PProj", "-mfix: x", "round"],
        ["-PProj", "-mfix: x", "-mfix: y", "round"],
        ["-PProj", "-m"],
        ["--push"],
      ]) {
        const result = await fixture.command([bin, "fix-round", ...args], fixture.temporary);
        expect(result.code).toBe(2);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(
          'usage: skills fix-round [-P <Project>] -m "<message>" <file>...\n',
        );
      }
    } finally {
      await fixture.dispose();
    }
  });
});

test.concurrent("takeover carries a PR's commits keeping author line and message", () =>
  within("carries", undefined, async (c) => {
    const hooks = join(c.fixture.temporary, "hooks");
    await mkdir(hooks);

    for (const [hook, body] of [
      ["prepare-commit-msg", 'printf "[hook ran]\\n" >> "$1"'],
      ["commit-msg", "exit 1"],
    ] as const) {
      await writeFile(join(hooks, hook), `#!/bin/sh\n${body}\n`);
      await chmod(join(hooks, hook), 0o755);
    }

    await c.git(["config", "core.hooksPath", hooks], c.repo);

    const result = await c.fixture.command([bin, "--root", root, "takeover", "7"], c.repo);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(both(c));

    await carriedBoth(c);
    expect(await c.git(["rev-parse", "feat/theirs"], c.origin)).toBe(c.second);
    expect(await c.git(["show", "HEAD:c"], c.repo)).toBe("c");
  }));

describe("plans below", () => {
  test.concurrent("usage names both registered verbs", async () => {
    const testCase = await stackCase("skills-stack-verbs-", { views: "deleted" });
    try {
      const { root } = await verbCase(testCase);
      for (const [verb, usage] of [
        ["below", "skills plans below <Project> <base>"],
        ["stack-base", "skills plans stack-base [--cut] <Project> <id>"],
      ] as const) {
        const result = await testCase.command(
          [bin, "--root", root, "plans", verb],
          testCase.temporary,
        );

        expect([result.code, result.stdout, result.stderr]).toEqual([2, "", `usage: ${usage}\n`]);
      }
    } finally {
      await testCase.dispose();
    }
  });
});

test.concurrent("below wrapper uses the case environment and refusal exit code", async () => {
  const testCase = await stackCase("skills-stack-verbs-wrapper-", { views: "deleted" });
  try {
    const { root, command, fixture, threads, calls } = await belowCase(testCase);
    await fixture(prListArgs("feat/a"), prList([{ number: 1, state: "OPEN" }]));
    await threads("1", page([thread(11, false, "greptile-apps")]));

    const result = await command([bin, "--root", root, "plans", "below", "fixture", "feat/a"]);
    expect([result.code, result.stdout, result.stderr]).toEqual([
      1,
      "",
      "open\t1\tfeat/a\t1\thttps://github.com/o/r/pull/1#discussion_r11\nbelow: unresolved Greptile threads below the base\n",
    ]);

    expect(await calls()).toEqual(
      [prListArgs("feat/a"), threadArgs("1")].map((args) => args.join(" ")),
    );
  } finally {
    await testCase.dispose();
  }
});

test.concurrent("stack-base wrapper uses the case environment and success exit code", async () => {
  const testCase = await stackCase("skills-stack-verbs-wrapper-", { views: "deleted" });
  try {
    const { root, command, calls } = await baseCase(testCase);
    const result = await command([bin, "--root", root, "plans", "stack-base", "fixture", "111"]);
    expect([result.code, result.stdout, result.stderr]).toEqual([0, "feat/open\n", ""]);
    expect(await calls()).toEqual([prListArgs("feat/open").join(" ")]);
  } finally {
    await testCase.dispose();
  }
});
