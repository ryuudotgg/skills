import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDelivery } from "../delivery.ts";
import { declarationText, fixture } from "../round/fixtures.ts";
import { matchesSetting, readDeclarations } from "./declaration.ts";
import { runReviewers } from "./command.ts";

const directories: string[] = [];

function shared() {
  const value = fixture(["greptile", "testbot", "thirdbot"], []);
  directories.push(value.temporary);
  value.configure("greptile testbot");

  return value;
}

function reviewers(value: ReturnType<typeof shared>, args: readonly string[]) {
  return runReviewers(args, value.root, value.deps.env);
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("test-reviewers: declaration case ledger, skills reviewers", () => {
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
      "greptile\trereviews\t2\t[0-9]\ngreptile\tthreshold\t4\t[1-5]\ngreptile\tcritical-threshold\t5\t[1-5]\ngreptile\tauto\tyes\tyes|no\nthirdbot\tbudget\t1\t[0-9]\n",
    );

    const results = await Promise.all([
      reviewers(value, ["NAME"]),
      reviewers(value, ["--active", "NAME"]),
      reviewers(value, ["--settings"]),
      reviewers(value, ["--active", "--settings"]),
      reviewers(value, ["UNDECLARED"]),
    ]);

    expect(results.map((result) => result.code)).toEqual([0, 0, 0, 0, 0]);
    expect(results.map((result) => result.stderr)).toEqual(["", "", "", "", ""]);
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
    test.concurrent(`test-reviewers: ${name}`, async () => {
      const value = shared();
      writeFileSync(
        join(value.root, "thirdbot/reviewer.conf"),
        change(declarationText("thirdbot")),
      );

      expect(() => readDeclarations(value.root)).toThrow(message);
      const results = await Promise.all([
        reviewers(value, ["NAME"]),
        reviewers(value, ["--active", "NAME"]),
      ]);

      for (const result of results) {
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toBe(`reviewers: ${join(value.root, "thirdbot/reviewer.conf")}: ${message}\n`);
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
      const result = reviewers(value, args);

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
    const result = reviewers(value, ["NAME"]);

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
    const result = reviewers(value, ["--active", "NAME"]);

    expect(delivery.mode === "prs" ? delivery.active : []).toEqual([]);
    expect(result.stdout).toBe("");
    expect(result.code).toBe(0);
  });

  test.concurrent("test-reviewers: usage bad-key", async () => {
    const value = shared();
    const result = reviewers(value, ["bad-key"]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("usage: skills reviewers [--active] <KEY|--settings>\n");
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
        const result = reviewers(value, args);

        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr).toContain(message);
      }
    });

  test.concurrent("JavaScript patterns accept digit classes and match whole values", () => {
    const value = shared();
    const path = join(value.root, "thirdbot/reviewer.conf");
    writeFileSync(path, declarationText("thirdbot").replace("1 [0-9]", "12 \\d+"));

    expect(readDeclarations(value.root).at(-1)!.settings[0]!.pattern).toBe("\\d+");
    expect(matchesSetting("\\d+", "12")).toBe(true);
    expect(matchesSetting("\\d+", "x12")).toBe(false);
    expect(matchesSetting("\\d+", "12\n")).toBe(false);

    writeFileSync(path, declarationText("thirdbot").replace("1 [0-9]", "a a|b"));

    expect(readDeclarations(value.root).at(-1)!.settings[0]!.pattern).toBe("a|b");
    expect(reviewers(value, ["SETTING"]).code).toBe(0);

    writeFileSync(path, declarationText("thirdbot").replace("1 [0-9]", "ab a|b"));

    expect(() => readDeclarations(value.root)).toThrow("default ab does not match a|b");
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

  test.concurrent("arbitrary keys preserve raw fields after the first equals sign", () => {
    const value = shared();
    writeFileSync(join(value.root, "thirdbot/reviewer.conf"), `${declarationText("thirdbot")}CUSTOM=  value=with\ttabs  \nEMPTY=\nFINAL=last`);

    expect(reviewers(value, ["CUSTOM"])).toEqual({ code: 0, stdout: "thirdbot\t  value=with\ttabs  \n", stderr: "" });
    expect(reviewers(value, ["EMPTY"])).toEqual({ code: 0, stdout: "thirdbot\t\n", stderr: "" });
    expect(reviewers(value, ["FINAL"])).toEqual({ code: 0, stdout: "thirdbot\tlast\n", stderr: "" });
    expect(reviewers(value, ["--active", "CUSTOM"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  test.concurrent("usage rejects extra arguments, missing keys and invalid keys", () => {
    const value = shared();
    for (const args of [[], ["--active"], ["NAME", "CHECK"], ["--settings", "NAME"], ["--active", "--active", "NAME"], ["_KEY"], ["1KEY"], ["name"], ["--unknown"]])
      expect(reviewers(value, args)).toEqual({ code: 2, stdout: "", stderr: "usage: skills reviewers [--active] <KEY|--settings>\n" });
  });

  test.concurrent("inactive declarations still refuse before delivery filtering", () => {
    const value = shared();
    writeFileSync(value.conf, "DELIVERY=hands-off\n");
    writeFileSync(join(value.root, "thirdbot/reviewer.conf"), declarationText("thirdbot").replace(/^TRIGGER=.*\n/m, ""));

    expect(reviewers(value, ["--active", "NAME"])).toEqual({ code: 1, stdout: "", stderr: `reviewers: ${join(value.root, "thirdbot/reviewer.conf")}: missing TRIGGER\n` });
  });

  test.concurrent("no declarations prints no trailing newline", () => {
    const value = shared();
    for (const name of ["greptile", "testbot", "thirdbot"])
      rmSync(join(value.root, name, "reviewer.conf"));

    for (const args of [["NAME"], ["--settings"], ["--active", "NAME"], ["--active", "--settings"]])
      expect(reviewers(value, args)).toEqual({ code: 0, stdout: "", stderr: "" });
  });
});
