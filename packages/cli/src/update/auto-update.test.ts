import { expect, test } from "bun:test";
import { autoUpdateChange, autoUpdateNote, readAutoUpdate, setAutoUpdate } from "./auto-update.ts";

test.each([
  ["", { kind: "unset" }],
  ["AUTO_UPDATE=on\n", { kind: "set", value: "on" }],
  ["AUTO_UPDATE=sometimes\nAUTO_UPDATE=on\n", { kind: "set", value: "on" }],
  ["AUTO_UPDATE=on\nAUTO_UPDATE=sometimes\n", { kind: "invalid", value: "sometimes" }],
  ["AUTO_UPDATE=\n", { kind: "invalid", value: "" }],
] as const)("the last AUTO_UPDATE line counts: %j", (content, reading) => {
  expect(readAutoUpdate(content)).toEqual(reading);
});

test("the note names an invalid value from the last line", () => {
  expect(
    autoUpdateNote({ content: "AUTO_UPDATE=on\nAUTO_UPDATE=sometimes\n", invalid: false }),
  ).toStartWith("AUTO_UPDATE=sometimes is not off, notify or on");

  expect(
    autoUpdateNote({ content: "AUTO_UPDATE=sometimes\nAUTO_UPDATE=on\n", invalid: false }),
  ).toBeUndefined();

  expect(autoUpdateNote({ content: "", invalid: true })).toBeUndefined();
});

test("a saved value keeps one line where the first one stood", () => {
  expect(setAutoUpdate("AUTO_UPDATE=off\nWITH=\nAUTO_UPDATE=notify\n", "on")).toBe(
    "AUTO_UPDATE=on\nWITH=\n",
  );

  expect(autoUpdateChange("AUTO_UPDATE=on\n", "on")).toBeUndefined();
  expect(autoUpdateChange("AUTO_UPDATE=off\nAUTO_UPDATE=on\n", "on")).toEqual(["AUTO_UPDATE=on"]);
});
