import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeTemporary, runCommand, suiteEnvironment } from "../test/process.ts";
import { commitBaseline } from "./baseline.ts";

const adopted = resolve(import.meta.dir, "../../../../evals/cases/plans-do-adopted");
const temporary: string[] = [];

afterEach(async () => {
  for (const directory of temporary.splice(0)) await removeTemporary(directory);
});

async function baselineIn(env: NodeJS.ProcessEnv): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "eval-baseline-"));
  temporary.push(dir);
  mkdirSync(join(dir, "hooks"));

  return commitBaseline(join(adopted, "fixture"), join(dir, "Demo"), join(dir, "hooks"), env);
}

test("the baseline sha ignores the author, clock and git config of the run", async () => {
  const first = await baselineIn({ ...suiteEnvironment(), GIT_AUTHOR_NAME: "someone" });
  const second = await baselineIn({ ...suiteEnvironment(), GIT_COMMITTER_DATE: "2020-01-01" });

  const config = join(mkdtempSync(join(tmpdir(), "eval-config-")), "gitconfig");
  temporary.push(dirname(config));
  writeFileSync(config, "[i18n]\n\tcommitEncoding = ISO-8859-1\n");
  const third = await baselineIn({ ...suiteEnvironment(), GIT_CONFIG_GLOBAL: config });

  expect(second).toBe(first);
  expect(third).toBe(first);
});

test("the plans-do-adopted pack names the baseline its fixture commits", async () => {
  const listed = await runCommand(["tar", "-xOf", join(adopted, "plans/pack.tar"), "pack.json"], {
    cwd: adopted,
    env: suiteEnvironment(),
  });

  const manifest = JSON.parse(listed.stdout) as { base: { ref: string; sha: string } };

  expect(manifest.base).toEqual({
    ref: "origin/main",
    sha: await baselineIn(suiteEnvironment()),
  });
});
