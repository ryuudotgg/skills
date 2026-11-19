import { describe, expect, test } from "bun:test";
import type { SettingsSources } from "../reviewers/settings.ts";
import { outgoingSetting } from "./outgoing-keys.ts";

function sources(lines: string[], git: string[] = [], key = "skills.pr-body"): SettingsSources {
  return {
    conf: "/conf",
    lines,
    git: new Map(git.length ? [[key, git]] : []),
    unknown: [],
  };
}

describe("outgoing settings", () => {
  for (const [name, lines, git, expected] of [
    ["unset reads as off", [], [], "off"],
    ["skills.conf sets it", ["PR_BODY=agent"], [], "agent"],
    ["git config sets it", [], ["agent"], "agent"],
    ["git config wins over skills.conf", ["PR_BODY=agent"], ["off"], "off"],
    ["an invalid git value keeps skills.conf", ["PR_BODY=agent"], ["on"], "agent"],
    ["an invalid skills.conf value reads as off", ["PR_BODY=yes"], [], "off"],
    ["a key set twice is skipped", ["PR_BODY=agent", "PR_BODY=agent"], [], "off"],
    ["a similar key is not the body key", ["PR_BODY_X=agent"], [], "off"],
  ] as const)
    test(name, () => {
      expect(outgoingSetting("body", sources([...lines], [...git])).value).toBe(expected);
    });

  test("the disclosure key reads skills.conf, then git config", () => {
    const layers = (lines: string[], git: string[]) =>
      outgoingSetting("disclosure", sources(lines, git, "skills.agent-disclosure")).value;

    expect(layers([], [])).toBe("off");
    expect(layers(["AGENT_DISCLOSURE=on"], [])).toBe("on");
    expect(layers([], ["on"])).toBe("on");
    expect(layers(["AGENT_DISCLOSURE=on"], ["off"])).toBe("off");
    expect(layers(["AGENT_DISCLOSURE=yes"], [])).toBe("off");
  });

  test("valid values give no notes", () => {
    expect(outgoingSetting("body", sources(["PR_BODY=agent"], ["off"])).notes).toEqual([]);
  });

  test("invalid outgoing value: a doubled skills.conf line is noted and skipped", () => {
    expect(outgoingSetting("body", sources(["PR_BODY=agent", "PR_BODY=agent"]))).toEqual({
      value: "off",
      notes: ["/conf: PR_BODY is set more than once, skipped"],
    });
  });

  test("invalid outgoing value: an invalid git config value is noted and skipped", () => {
    expect(outgoingSetting("disclosure", sources([], ["yes"], "skills.agent-disclosure"))).toEqual({
      value: "off",
      notes: ["git config skills.agent-disclosure=yes is not valid, skipped"],
    });
  });

  test("invalid outgoing value: an invalid git value keeps skills.conf and notes git", () => {
    expect(outgoingSetting("body", sources(["PR_BODY=agent"], ["on"]))).toEqual({
      value: "agent",
      notes: ["git config skills.pr-body=on is not valid, skipped"],
    });
  });
});
