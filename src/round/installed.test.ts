import { expect, test } from "bun:test";
import { Glob } from "bun";
import { join, resolve } from "node:path";

const skills = resolve(import.meta.dir, "../../skills");

test("every installed reviewer.ts exports callable facts and decide", async () => {
  const paths = [...new Glob("*/reviewer.ts").scanSync(skills)];
  expect(paths.length).toBeGreaterThan(0);

  for (const path of paths) {
    const reviewer = await import(join(skills, path));

    expect([path, typeof reviewer.facts, typeof reviewer.decide]).toEqual([
      path,
      "function",
      "function",
    ]);
  }
});
