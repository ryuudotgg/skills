import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDelivery } from "../delivery.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { declarationText, fixture, repo } from "../round/fixtures.ts";
import { readDeclarations } from "./declaration.ts";

const directories: string[] = [];

function shared() {
  const value = fixture(["greptile", "testbot", "thirdbot"], []);
  directories.push(value.temporary);
  mkdirSync(join(value.root, "playbook/scripts"), { recursive: true });

  for (const name of ["reviewers.sh", "delivery-mode.sh", "extension-verdict.sh"])
    copyFileSync(
      join(repo, "skills/playbook/scripts", name),
      join(value.root, "playbook/scripts", name),
    );

  value.configure("greptile testbot");

  return value;
}

async function shell(value: ReturnType<typeof shared>, args: readonly string[]) {
  return runCommand(["sh", join(value.root, "playbook/scripts/reviewers.sh"), ...args], {
    cwd: value.temporary,
    env: { ...suiteEnvironment(), SKILLS_CONF: value.conf },
  });
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("test-reviewers.sh declaration case ledger, TS and shell", () => {
  test.concurrent("installed names, active names, settings, active settings, unknown key printed stdout", async () => {
    const value = shared();
    const declarations = readDeclarations(value.root);
    const delivery = readDelivery(value.root, value.deps.env);
    const active = declarations.filter(
      (entry) => delivery.mode === "prs" && delivery.active.includes(entry.name),
    );

    const names = (entries: typeof declarations) =>
      entries.map((entry) => `${entry.name}\t${entry.displayName}\n`).join("");

    const settings = (entries: typeof declarations) =>
      entries
        .flatMap((entry) =>
          entry.settings.map(
            (setting) =>
              `${entry.name}\t${setting.name}\t${setting.defaultValue}\t${setting.pattern}\n`,
          ),
        )
        .join("");

    expect(names(declarations)).toBe("greptile\tGreptile\ntestbot\tTestBot\nthirdbot\tThirdBot\n");
    expect(names(active)).toBe("greptile\tGreptile\ntestbot\tTestBot\n");
    expect(settings(declarations)).toBe(
      "greptile\trereviews\t2\t[0-9]\ngreptile\tthreshold\t4\t[1-5]\ngreptile\tcritical-threshold\t5\t[1-5]\nthirdbot\tbudget\t1\t[0-9]\n",
    );

    const results = await Promise.all([
      shell(value, ["NAME"]),
      shell(value, ["--active", "NAME"]),
      shell(value, ["--settings"]),
      shell(value, ["--active", "--settings"]),
      shell(value, ["UNDECLARED"]),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0, 0]);
    expect(results.map((result) => result.stdout)).toEqual([
      names(declarations),
      names(active),
      settings(declarations),
      settings(active),
      "",
    ]);
  });

  const defects = [
    ["missing", (text: string) => text.replace(/^TRIGGER=.*\n/m, ""), "missing TRIGGER"],
    ["duplicate", (text: string) => text + text, "duplicate NAME"],
    [
      "login",
      (text: string) => text.replace(/^LOGINS=.*/m, "LOGINS=thirdbot-fan!"),
      "invalid login: thirdbot-fan!",
    ],
    [
      "twin",
      (text: string) => text.replace(/^LOGINS=.*/m, "LOGINS=ryuu"),
      "login ryuu needs both ryuu and ryuu[bot]",
    ],
    [
      "botonly",
      (text: string) => text.replace(/^LOGINS=.*/m, "LOGINS=thirdbot[bot]"),
      "login thirdbot[bot] needs both thirdbot and thirdbot[bot]",
    ],
    [
      "trigger",
      (text: string) => text.replace(/^TRIGGER=.*/m, "TRIGGER=LGTM, merging now"),
      "TRIGGER does not start with one of its HANDLES",
    ],
    ["malformed", () => "bad line\n", "malformed line"],
    [
      "setting-key",
      (text: string) => text.replace("SETTING_BUDGET=", "SETTING_bad="),
      "malformed line",
    ],
    [
      "setting-default",
      (text: string) => text.replace(/^SETTING_BUDGET=.*/m, "SETTING_BUDGET=wrong [0-9]"),
      "default wrong does not match [0-9]",
    ],
    [
      "setting-regex",
      (text: string) => text.replace(/^SETTING_BUDGET=.*/m, "SETTING_BUDGET=1 ["),
      "invalid regex: [",
    ],
  ] as const;

  for (const [name, change, message] of defects)
    test.concurrent(`reviewers: ${name}`, async () => {
      const value = shared();
      writeFileSync(
        join(value.root, "thirdbot/reviewer.conf"),
        change(declarationText("thirdbot")),
      );

      expect(() => readDeclarations(value.root)).toThrow(message);
      const results = await Promise.all([
        shell(value, ["NAME"]),
        shell(value, ["--active", "NAME"]),
      ]);

      for (const result of results) {
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(message);
      }
    });

  test.concurrent("setting collision did not collide", async () => {
    const value = shared();
    writeFileSync(
      join(value.root, "testbot/reviewer.conf"),
      declarationText("testbot") + "SETTING_X_BUDGET=1 [0-9]\n",
    );

    mkdirSync(join(value.root, "testbot-x"));
    copyFileSync(
      join(value.root, "thirdbot/reviewer.conf"),
      join(value.root, "testbot-x/reviewer.conf"),
    );

    expect(() => readDeclarations(value.root)).toThrow(
      "setting key TESTBOT_X_BUDGET is claimed twice",
    );

    for (const args of [["NAME"], ["--active", "NAME"]]) {
      const result = await shell(value, args);

      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("setting key TESTBOT_X_BUDGET is claimed twice");
    }
  });

  test.concurrent("CRLF declarations differ", async () => {
    const value = shared();
    writeFileSync(
      join(value.root, "thirdbot/reviewer.conf"),
      "# ignored\r\n\r\n" + declarationText("thirdbot").replaceAll("\n", "\r\n"),
    );

    const declarations = readDeclarations(value.root);
    const result = await shell(value, ["NAME"]);

    expect(declarations.map((entry) => entry.displayName)).toEqual([
      "Greptile",
      "TestBot",
      "ThirdBot",
    ]);

    expect(result.stdout).toBe("greptile\tGreptile\ntestbot\tTestBot\nthirdbot\tThirdBot\n");
  });

  test.concurrent("hands-off reviewers active", async () => {
    const value = shared();
    writeFileSync(value.conf, "DELIVERY=hands-off\nWITH=greptile testbot\n");
    const delivery = readDelivery(value.root, value.deps.env);
    const result = await shell(value, ["--active", "NAME"]);

    expect(delivery.mode === "prs" ? delivery.active : []).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  test.concurrent("usage: reviewers.sh bad-key", async () => {
    const value = shared();
    const result = await shell(value, ["bad-key"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("usage: reviewers.sh");
    expect(readDeclarations(value.root)).toHaveLength(3);
  });

  for (const [name, declaration, message] of [
    ["empty CHECK", "CHECK=", "empty CHECK"],
    ["invalid handle", "HANDLES=thirdbot", "invalid handle: thirdbot"],
    ["invalid setting key", "SETTING_=1 [0-9]", "invalid setting key: SETTING_"],
    ["invalid setting value", "SETTING_BUDGET=1", "invalid setting value: 1"],
  ] as const)
    test.concurrent(name, async () => {
      const value = shared();
      const field = declaration.split("=", 1)[0]!;
      writeFileSync(
        join(value.root, "thirdbot/reviewer.conf"),
        declarationText("thirdbot")
          .split("\n")
          .filter((line) => !line.startsWith(`${field}=`))
          .join("\n") +
          declaration +
          "\n",
      );

      expect(() => readDeclarations(value.root)).toThrow(message);

      for (const args of [["NAME"], ["--active", "NAME"]]) {
        const result = await shell(value, args);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(message);
      }
    });

  test.concurrent("shared pattern rejects (?:a|b) and accepts a|b as whole values", async () => {
    const value = shared();
    const path = join(value.root, "thirdbot/reviewer.conf");
    writeFileSync(path, declarationText("thirdbot").replace("1 [0-9]", "a (?:a|b)"));

    expect(() => readDeclarations(value.root)).toThrow("shared JavaScript RegExp and POSIX ERE subset");

    writeFileSync(path, declarationText("thirdbot").replace("1 [0-9]", "a a|b"));

    expect(readDeclarations(value.root).at(-1)!.settings[0]!.pattern).toBe("a|b");
    expect((await shell(value, ["SETTING"])).code).toBe(0);

    writeFileSync(path, declarationText("thirdbot").replace("1 [0-9]", "ab a|b"));

    expect(() => readDeclarations(value.root)).toThrow("default ab does not match a|b");
  });

  for (const pattern of ["(?=a)a", "\\d", "\\w", "(a)\\1", "[[:digit:]]", "a{,2}", "a*?", "a+?", "a??", "a{1}?", "a*+", "a++"])
    test.concurrent(`pattern dialect refuses ${pattern}`, () => {
      const value = shared();
      writeFileSync(join(value.root, "thirdbot/reviewer.conf"), declarationText("thirdbot").replace("1 [0-9]", `a ${pattern}`));
      expect(() => readDeclarations(value.root)).toThrow(/invalid regex|shared JavaScript RegExp and POSIX ERE subset/);
    });

  test.concurrent("declaration symlinks follow regular files and dangling ones refuse", () => {
    const value = shared();
    const path = join(value.root, "thirdbot/reviewer.conf");
    const saved = join(value.temporary, "saved.conf");

    copyFileSync(path, saved);
    rmSync(path);
    symlinkSync(saved, path);

    expect(readDeclarations(value.root).at(-1)!.name).toBe("thirdbot");

    rmSync(saved);

    expect(() => readDeclarations(value.root)).toThrow("not a readable regular file");
  });
});
