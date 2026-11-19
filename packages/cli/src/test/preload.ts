import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PLANS_DIR = join(tmpdir(), `skills-test-no-plans-${process.pid}`);

const scratch = mkdtempSync(join(tmpdir(), "skills-test-scratch-"));
process.env.PLANS_SCRATCH = scratch;
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
