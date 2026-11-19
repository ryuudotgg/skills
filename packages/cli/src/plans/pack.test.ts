import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PackRefusal, scratchFor } from "./pack.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "skills-pack-scratch-"));
  temporary.push(path);
  return path;
}

describe("scratch root", () => {
  test("puts a move scratch under PLANS_SCRATCH in a private parent", () => {
    const base = root();

    const scratch = scratchFor("001", { PLANS_SCRATCH: base });

    expect(dirname(scratch)).toBe(join(base, "plans-001"));
    expect(statSync(join(base, "plans-001")).mode & 0o777).toBe(0o700);
  });

  test("refuses a group writable parent under PLANS_SCRATCH", () => {
    const base = root();
    const parent = join(base, "plans-001");
    mkdirSync(parent);
    chmodSync(parent, 0o775);

    const asked = () => scratchFor("001", { PLANS_SCRATCH: base });

    expect(asked).toThrow(PackRefusal);
    expect(asked).toThrow(`${parent} is not a private directory of this user, remove it first`);
  });
});
