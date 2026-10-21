import { expect, test } from "bun:test";
import { colorEnabled, painter, tilde, wrap } from "./terminal.ts";

test("color stays on unless NO_COLOR is set or the terminal is dumb", () => {
  expect(colorEnabled({})).toBe(true);
  expect(colorEnabled({ NO_COLOR: "" })).toBe(true);
  expect(colorEnabled({ NO_COLOR: "1" })).toBe(false);
  expect(colorEnabled({ TERM: "dumb" })).toBe(false);
});

test("a painter that is off returns the text untouched", () => {
  expect(painter(false).red("FAIL")).toBe("FAIL");
  expect(painter(true).red("FAIL")).toBe("\u001b[31mFAIL\u001b[39m");
  expect(painter(true).red("")).toBe("");
});

test("wrap breaks between words only", () => {
  expect(wrap("one two three four", 9)).toEqual(["one two", "three", "four"]);
  expect(wrap("unbreakable", 4)).toEqual(["unbreakable"]);
});

test("tilde shortens a home path where a path starts, and leaves / alone", () => {
  expect(tilde("/home/me")("/home/me/skills and /mnt/home/me/x")).toBe(
    "~/skills and /mnt/home/me/x",
  );

  expect(tilde("/home/a.b")("/home/axb/x /home/a.b/x")).toBe("/home/axb/x ~/x");
  expect(tilde("/")("/etc/hosts")).toBe("/etc/hosts");
  expect(tilde("")("/etc/hosts")).toBe("/etc/hosts");
});
