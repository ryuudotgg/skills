import { expect, test } from "bun:test";
import {
  eventFrom,
  factsFrom,
  factsStale,
  recordOf,
  toolLine,
  trailOf,
  withCheckout,
  type Facts,
} from "skills-core";

const facts: Facts = {
  label: "Desk Mac",
  environment: null,
  os: { platform: "darwin", version: "26.1" },
  arch: "arm64",
  tools: {
    xcode: { version: "Xcode 26.1" },
    android: { absent: true, reason: "adb not found" },
    docker: { version: "28.1.1" },
    bun: { version: "1.4.4" },
    node: { version: "v24.0.0" },
    gh: { version: "gh version 2.83.0" },
  },
  checkouts: { Demo: { path: "/tmp/a/Demo", origin: "/tmp/origin.git" } },
  captured: "2026-11-07T12:00:00.000Z",
};

test("a machine draft is a stored event on project and plan -, never a trail line", () => {
  const record = recordOf({
    kind: "stored",
    type: "machine",
    at: Date.parse(facts.captured),
    project: "-",
    plan: "-",
    payload: facts,
  });

  const event = eventFrom({ ...record, wall: 1, counter: 0, machine: "m" });

  expect(event.kind).toBe("stored");
  expect(record).toMatchObject({ project: "-", plan: "-", type: "machine", legacy: false });
  expect(trailOf([event])).toEqual([]);
});

test("facts round trip and a malformed payload reads as no facts", () => {
  expect(factsFrom(JSON.parse(JSON.stringify(facts)))).toEqual(facts);

  for (const broken of [
    null,
    { ...facts, label: "" },
    { ...facts, captured: "yesterday" },
    { ...facts, tools: { ...facts.tools, gh: undefined } },
    { ...facts, tools: { ...facts.tools, gh: { absent: true } } },
    { ...facts, checkouts: { Demo: { path: "/tmp/a/Demo" } } },
    { ...facts, os: { platform: "darwin" } },
  ])
    expect(factsFrom(broken)).toBeUndefined();
});

test("a project named __proto__ keeps its checkout", () => {
  const payload = JSON.parse(JSON.stringify(facts).replace('"Demo":', '"__proto__":')) as unknown;
  expect(Object.keys(factsFrom(payload)!.checkouts)).toEqual(["__proto__"]);
});

test("facts go stale at 24 hours, when missing, and when captured in the future", () => {
  const captured = Date.parse(facts.captured);

  expect(factsStale(facts, captured + 23 * 3_600_000)).toBe(false);
  expect(factsStale(facts, captured + 24 * 3_600_000)).toBe(true);
  expect(factsStale(facts, captured - 1)).toBe(true);
  expect(factsStale(undefined, captured)).toBe(true);
});

test("a known checkout changes nothing and a new one keeps captured", () => {
  expect(withCheckout(facts, "Demo", { path: "/tmp/a/Demo", origin: "/tmp/origin.git" })).toBe(
    undefined,
  );

  expect(withCheckout(facts, "Demo", { path: "/tmp/b/Demo", origin: null })).toEqual({
    ...facts,
    checkouts: { Demo: { path: "/tmp/b/Demo", origin: null } },
  });
});

test("tool lines name the version or the reason", () => {
  expect(toolLine("xcode", facts.tools.xcode)).toBe("tool xcode Xcode 26.1");
  expect(toolLine("android", facts.tools.android)).toBe("tool android absent: adb not found");
});
