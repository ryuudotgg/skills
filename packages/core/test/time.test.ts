import { expect, test } from "bun:test";
import { instantText, parseTime } from "skills-core";

test("parseTime reads instants and whole UTC days", () => {
  expect(parseTime("2026-10-31T15:25:31Z")).toBe(Date.parse("2026-10-31T15:25:31Z"));
  expect(parseTime("2026-10-31T15:25:31.250Z")).toBe(Date.parse("2026-10-31T15:25:31.250Z"));
  expect(parseTime("2026-10-31")).toBe(Date.parse("2026-10-31T23:59:59.999Z"));

  expect(parseTime("2026-02-30")).toBeUndefined();
  expect(parseTime("2026-02-30T00:00:00Z")).toBeUndefined();
  expect(parseTime("2026-10-31T24:00:00Z")).toBeUndefined();
  expect(parseTime("2026-10-31T15:25:31+01:00")).toBeUndefined();
  expect(parseTime("yesterday")).toBeUndefined();
});

test("instantText writes milliseconds only when the instant has them", () => {
  expect(instantText(Date.parse("2026-11-03T12:00:00Z"))).toBe("2026-11-03T12:00:00Z");
  expect(instantText(Date.parse("2026-11-03T23:59:59.999Z"))).toBe("2026-11-03T23:59:59.999Z");
  expect(parseTime(instantText(Date.parse("2026-11-03T12:00:00.250Z")))).toBe(
    Date.parse("2026-11-03T12:00:00.250Z"),
  );
});
