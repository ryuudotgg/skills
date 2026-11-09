import { describe, expect, test } from "bun:test";
import type { SettingsSources } from "../reviewers/settings.ts";
import { outgoingSetting } from "./outgoing-keys.ts";

function sources(lines: string[], git: string[] = []): SettingsSources {
  return {
    conf: "/conf",
    lines,
    git: new Map(git.length ? [["skills.pr-body", git]] : []),
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
      expect(outgoingSetting("body", sources([...lines], [...git]))).toBe(expected);
    });
});
