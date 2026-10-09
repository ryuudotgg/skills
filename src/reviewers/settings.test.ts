import { afterEach, expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDelivery } from "../delivery.ts";
import { failure, fixture, repo, success } from "../round/fixtures.ts";
import { dependencies } from "../round/round.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { runSettings } from "./settings.ts";

const temporary: string[] = [];
const defaults = "rereviews=2\nthreshold=4\ncritical-threshold=5\nauto=yes\n";

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function setup(active = "greptile") {
  const value = fixture(["greptile", "testbot", "coderabbit"], []);
  temporary.push(value.temporary);
  value.configure(active);
  cpSync(
    join(repo, "skills/coderabbit/reviewer.conf"),
    join(value.root, "coderabbit/reviewer.conf"),
  );

  let local = "";
  value.deps.git = async (args, deadline) => {
    value.calls.push({ command: "git", args, deadline });
    return local ? success(local) : failure();
  };

  return {
    ...value,
    local: (data: string) => {
      local = data;
    },
  };
}

test("base config wrote stderr; base delivery mode; real local repo, away and other defaults", async () => {
  const value = setup();
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=3\n");

  const env = {
    ...suiteEnvironment(),
    ...value.deps.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };

  const local = join(value.temporary, "repo");
  const other = join(value.temporary, "other");
  const away = join(value.temporary, "away");
  mkdirSync(away);

  for (const directory of [local, other]) {
    const result = await runCommand(["git", "init", "--quiet", "-b", "main", directory], {
      cwd: value.temporary,
      env,
    });

    expect(result.code).toBe(0);
  }

  const config = join(local, ".git/config");
  writeFileSync(config, readFileSync(config, "utf8") + '[skills "greptile"]\n\trereviews = 1\n');

  expect(await runSettings(["greptile"], dependencies(value.root, away, env))).toEqual({
    code: 0,
    stdout: defaults.replace("rereviews=2", "rereviews=3"),
    stderr: "",
  });

  expect(readDelivery(value.root, value.deps.env)).toMatchObject({
    mode: "prs",
    active: ["greptile"],
  });

  for (const [directory, rereviews] of [
    [local, "1"],
    [away, "3"],
    [other, "3"],
  ])
    expect(await runSettings(["greptile"], dependencies(value.root, directory!, env))).toEqual({
      code: 0,
      stdout: defaults.replace("rereviews=2", `rereviews=${rereviews}`),
      stderr: "",
    });
}, 30_000);

for (const [name, subsection, entries, expected, note] of [
  ["local value", "greptile", ["1"], "1", ""],
  [
    "newline value",
    "greptile",
    ["1\nthreshold=1"],
    "2",
    "skills.greptile.rereviews=1\nthreshold=1 is not valid, skipped",
  ],
  [
    "duplicate",
    "greptile",
    ["1", "3"],
    "2",
    "skills.greptile.rereviews is set more than once, skipped",
  ],
  ["valueless key", "greptile", [null], "2", "skills.greptile.rereviews= is not valid, skipped"],
  [
    "valueless duplicate",
    "greptile",
    [null, "1"],
    "2",
    "skills.greptile.rereviews is set more than once, skipped",
  ],
  ["mixed case reviewer subsection", "Greptile", ["1"], "2", ""],
] as const)
  test(`real git settings: ${name}`, async () => {
    const value = setup();
    const directory = join(value.temporary, "repo");
    const env = {
      ...suiteEnvironment(),
      ...value.deps.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    };

    const initialized = await runCommand(["git", "init", "--quiet", "-b", "main", directory], {
      cwd: value.temporary,
      env,
    });

    expect(initialized.code).toBe(0);

    const config = join(directory, ".git/config");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        `[skills "${subsection}"]\n${entries.map((entry) => `\trereviews${entry === null ? "" : ` = ${JSON.stringify(entry)}`}\n`).join("")}`,
    );

    const result = await runSettings(["greptile"], dependencies(value.root, directory, env));

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(defaults.replace("rereviews=2", `rereviews=${expected}`));
    expect(result.stdout.trim().split("\n")).toHaveLength(4);

    if (note) expect(result.stderr).toEndWith(`${note}\n`);
    else expect(result.stderr).toBe("");
  }, 30_000);

test("invalid setting changed delivery mode", async () => {
  const value = setup();
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=lots\n");
  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults);
  expect(result.stderr).toContain("GREPTILE_REREVIEWS=lots is not valid, skipped");
  expect(readDelivery(value.root, value.deps.env)).toMatchObject({
    mode: "prs",
    active: ["greptile"],
  });
});

test("newline forged a setting", async () => {
  const value = setup();
  value.local("skills.greptile.rereviews\n1\nthreshold=1\0");
  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults);
  expect(result.stdout.trim().split("\n")).toHaveLength(4);
  expect(result.stderr).toContain("1\nthreshold=1 is not valid, skipped");
});

test("local rereviews is set more than once, skipped", async () => {
  const value = setup();
  value.local("skills.greptile.rereviews\n1\0skills.greptile.rereviews\n3\0");
  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults);
  expect(result.stderr).toContain("is set more than once, skipped");
});

test("GREPTILE_REREVIEWS ignored, greptile is not active", async () => {
  const value = setup("");
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=\nGREPTILE_REREVIEWS=3\n");
  value.local("skills.greptile.rereviews\n1\0skills.greptile.rereviews\n3\0");
  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults);
  expect(result.stderr.match(/ignored, greptile is not active/g)).toHaveLength(2);
});

for (const key of ["GREPTILE_REREVIEW", "GREPTILE_GRACE_MINUTES", "CODERABBIT_ROLE"])
  test(`${key} is no installed reviewer's setting`, async () => {
    const value = setup("greptile coderabbit");
    writeFileSync(
      value.conf,
      `DELIVERY=prs\nWITH=greptile coderabbit\n${key}=${key === "CODERABBIT_ROLE" ? "advisory" : key === "GREPTILE_GRACE_MINUTES" ? "6" : "3"}\n`,
    );

    const result = await runSettings(
      [key === "CODERABBIT_ROLE" ? "coderabbit" : "greptile"],
      value.deps,
    );

    expect(result.stdout).toBe(
      key === "CODERABBIT_ROLE"
        ? "rereviews=3\nthreshold=major\ncritical-threshold=minor\n"
        : defaults,
    );

    expect(result.stderr).toContain(`${key} is no installed reviewer's setting`);
  });

test("GREPTILE_REREVIEWS is set more than once, skipped", async () => {
  const value = setup();
  writeFileSync(
    value.conf,
    "DELIVERY=prs\nWITH=greptile\nGREPTILE_REREVIEWS=3\nGREPTILE_REREVIEWS=1\n",
  );

  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults);
  expect(result.stderr).toContain("GREPTILE_REREVIEWS is set more than once, skipped");
});

test("CRLF wrote stderr", async () => {
  const value = setup();
  writeFileSync(value.conf, "DELIVERY=prs\r\nWITH=greptile\r\nGREPTILE_REREVIEWS=3\r\n");

  expect(await runSettings(["greptile"], value.deps)).toEqual({
    code: 0,
    stdout: defaults.replace("rereviews=2", "rereviews=3"),
    stderr: "",
  });
});

test("relative config was read", async () => {
  const value = setup();
  value.deps.env.SKILLS_CONF = "skills.conf";

  expect(await runSettings(["greptile"], value.deps)).toEqual({
    code: 0,
    stdout: defaults,
    stderr: "",
  });
});

test("unknown reviewer status or stdout", async () => {
  const value = setup();

  expect(await runSettings(["missing"], value.deps)).toEqual({
    code: 1,
    stdout: "",
    stderr: "settings: missing is not an installed reviewer\n",
  });
});

test("bad argument status or stdout", async () => {
  const value = setup();
  for (const args of [[], ["Bad"], ["greptile", "extra"]])
    expect(await runSettings(args, value.deps)).toEqual({
      code: 2,
      stdout: "",
      stderr: "usage: skills settings <reviewer>\n",
    });
});

test("defective declaration status or stdout", async () => {
  const value = setup();
  writeFileSync(join(value.root, "testbot/reviewer.conf"), "SETTING_BAD=3 [\n");
  const result = await runSettings(["greptile"], value.deps);

  expect(result.code).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("settings: cannot read reviewer declarations");
});

test("settings reads included skills keys once and preserves subsection case", async () => {
  const value = setup();
  value.local("skills.Greptile.rereviews\n1\0skills.greptile.threshold\n3\0");
  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults.replace("threshold=4", "threshold=3"));
  expect(value.calls).toHaveLength(1);
  expect(value.calls[0]).toMatchObject({ command: "git", deadline: 10_000 });
  expect(value.calls[0]!.args).toContain("--get-regexp");
  expect(value.calls[0]!.args).toContain("--includes");
});

test("fast mode keys are no reviewer's to claim", async () => {
  const value = setup();
  writeFileSync(
    value.conf,
    "DELIVERY=prs\nWITH=greptile\nCODEX_FAST_MODE=yes\nCLAUDE_FAST_MODE=no\n",
  );

  const result = await runSettings(["greptile"], value.deps);

  expect(result.stdout).toBe(defaults);
  expect(result.stderr).toBe("");
});
