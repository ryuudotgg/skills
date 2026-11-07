import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitFixture, createRepo, fixtureGit, writeFixture } from "../test/fixtures.ts";
import { history } from "./files.ts";

test("a rollback install still recognises the copy the failed release shipped", async () => {
  const repo = await createRepo();
  const installed = mkdtempSync(join(tmpdir(), "skills-installed-"));
  try {
    await writeFixture(repo, "agents/reviewer.md", "old\n");
    await commitFixture(repo);
    const old = (await fixtureGit(repo, ["rev-parse", "HEAD"])).trim();

    await writeFixture(repo, "agents/reviewer.md", "new\n");
    await commitFixture(repo);
    const failed = (await fixtureGit(repo, ["rev-parse", "HEAD"])).trim();

    await fixtureGit(repo, ["reset", "-q", "--hard", old]);
    writeFileSync(join(installed, "reviewer.md"), "new\n");

    const copy = join(installed, "reviewer.md");
    expect(await (await history(repo)).shipped("agents/reviewer.md", copy)).toBe(false);
    expect(await (await history(repo, failed)).shipped("agents/reviewer.md", copy)).toBe(true);
    expect(await (await history(repo, "not-a-sha")).shipped("agents/reviewer.md", copy)).toBe(
      false,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(installed, { recursive: true, force: true });
  }
});
