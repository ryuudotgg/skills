import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { fixture } from "./fixtures.ts";
import { runRound } from "./round.ts";

test("one round gate reads its config exactly once with an active reviewer", async () => {
  const value = fixture(["testbot"]);
  const reads = spyOn(fs, "readFileSync");
  try {
    const result = await runRound(["gate", "18"], value.deps);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("testbot done\ndone\n");
    expect(reads.mock.calls.filter(([path]) => path === value.deps.env.SKILLS_CONF)).toHaveLength(1);
  } finally {
    reads.mockRestore();
    fs.rmSync(value.temporary, { recursive: true, force: true });
  }
});
