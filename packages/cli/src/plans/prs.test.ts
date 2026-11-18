import { expect, test } from "bun:test";
import { landing, type Merged, type Pr, type Reads } from "./prs.ts";

function merged(number: number, base: string, ended: number): Merged {
  return {
    number,
    state: "MERGED",
    base,
    sha: `sha${number}`,
    head: `head${number}`,
    title: "",
    ended,
    conflicting: false,
  };
}

function reads(
  branches: ReadonlyMap<string, Pr[]>,
  contains: Reads["contains"] = async () => true,
): Reads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    prs: async (branch) => {
      calls.push(branch);
      return branches.get(branch) ?? "no such branch";
    },
    contains: async (ancestor, head) => {
      calls.push(`${ancestor} ${head}`);
      return contains(ancestor, head);
    },
  };
}

test("landing walks converging stacked parents once per merge", async () => {
  const depth = 12;
  const width = 6;
  const branches = new Map<string, Pr[]>();
  for (let level = 0; level < depth; level++)
    branches.set(
      `feat/l${level}`,
      Array.from({ length: width }, (_, offset) =>
        merged(
          level * width + offset + 1,
          level === depth - 1 ? "main" : `feat/l${level + 1}`,
          level,
        ),
      ),
    );

  const walk = reads(branches);
  const found = await landing([merged(999, "feat/l0", 0)], "main", walk);

  expect(found.kind).toBe("landed");
  expect(walk.calls.length).toBeLessThanOrEqual(depth * width * (width + 1) + 2);
});

test("a parent PR whose head does not carry the merge below it is not followed", async () => {
  const walk = reads(
    new Map([["feat/z", [merged(12, "main", 2)]]]),
    async (ancestor, head) => !(ancestor === "sha11" && head === "head12"),
  );

  expect(await landing([merged(11, "feat/z", 1)], "main", walk)).toEqual({ kind: "stranded" });
});

test("a failed ancestry read is unreadable, never stranded", async () => {
  const walk = reads(
    new Map([["feat/z", [merged(12, "main", 2)]]]),
    async () => "gh api compare failed",
  );

  expect(await landing([merged(11, "feat/z", 1)], "main", walk)).toEqual({
    kind: "unreadable",
    reason: "cannot tell whether #12 carries #11: gh api compare failed",
  });
});
