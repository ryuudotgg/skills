import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PLANS_DIR = join(tmpdir(), `skills-test-no-plans-${process.pid}`);

for (const name of Object.keys(process.env)) if (name.startsWith("GIT_")) delete process.env[name];
