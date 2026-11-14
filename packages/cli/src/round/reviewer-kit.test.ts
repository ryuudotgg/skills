import { expect, test } from "bun:test";
import { authorMatcher, openThreads, worst } from "./reviewer-kit.ts";

const rank = { minor: 0, critical: 1 };
const level = (line: string) => (line.includes("Minor") ? "minor" : "critical");
const seen = authorMatcher({ logins: ["reviewer[bot]"] });
const thread = () => ({
  isResolved: false,
  comments: {
    nodes: [{ author: { login: "Reviewer[bot]" }, body: "\n🟡 Minor: rename this" }],
  },
  latest: { nodes: [{ author: { login: "reviewer[bot]" } }] },
});

test("full thread page reads critical", () => {
  const full = openThreads({ nodes: Array.from({ length: 100 }, thread) }, seen, level);
  expect(worst(full.levels, rank)).toBe("critical");
  expect(worst(full.unanswered, rank)).toBe("critical");

  const partial = openThreads({ nodes: Array.from({ length: 99 }, thread) }, seen, level);
  expect(worst(partial.levels, rank)).toBe("minor");
  expect(worst(partial.unanswered, rank)).toBe("minor");
});
