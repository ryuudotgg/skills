import { expect, test } from "bun:test";
import { landing, type Merged, type Pr } from "./prs.ts";

function merged(number: number, base: string, ended: number): Merged {
  return {
    number,
    state: "MERGED",
    base,
    sha: number.toString(16).padStart(7, "0"),
    head: "",
    title: "",
    ended,
    conflicting: false,
  };
}

test("landing walks converging stacked parents once per parent and threshold", async () => {
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

  let reads = 0;
  const found = await landing([merged(999, "feat/l0", 0)], "main", async (branch) => {
    reads++;
    return branches.get(branch) ?? "no such branch";
  });

  expect(found.kind).toBe("landed");
  expect(reads).toBe(depth);
});
