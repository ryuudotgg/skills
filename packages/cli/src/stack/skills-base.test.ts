import { expect, test } from "bun:test";
import { baseFrom, baseKey, parseBase } from "./skills-base.ts";

test("parseBase trims a configured base and treats blank values as absent", () => {
  expect(parseBase("feat/topic", 0, " origin/main\n")).toEqual({ ok: true, base: "origin/main" });
  expect(parseBase("feat/topic", 0, " \n")).toEqual({ ok: true, base: undefined });
});

test("parseBase treats exit one as absent even with output", () => {
  expect(parseBase("feat/topic", 1, "ignored")).toEqual({ ok: true, base: undefined });
});

test.each([2, -1])("parseBase refuses exit %i", (code) => {
  expect(parseBase("feat/topic", code, "ignored")).toEqual({
    ok: false,
    reason: `cannot read ${baseKey("feat/topic")} (git config exited ${code})`,
  });
});

test("baseFrom reports a transport failure with the config key", () => {
  expect(
    baseFrom("feat/topic", {
      ok: false,
      failure: { kind: "deadline", read: "git config --get", deadline: 5000 },
      stderr: "",
    }),
  ).toEqual({
    ok: false,
    reason: `cannot read ${baseKey("feat/topic")} (git config --get: no exit within 5 s)`,
  });
});

test("baseFrom parses a completed read", () => {
  expect(
    baseFrom("feat/topic", {
      ok: true,
      code: 0,
      stdout: "origin/main\n",
      bytes: new Uint8Array(),
      stderr: "",
    }),
  ).toEqual({ ok: true, base: "origin/main" });
});
