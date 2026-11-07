import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.PLANS_DIR = join(tmpdir(), `skills-test-no-plans-${process.pid}`);
