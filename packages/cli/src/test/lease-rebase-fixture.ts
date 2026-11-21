import { expect } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { leaseRebaseVerb } from "../stack/lease-rebase.ts";
import type { CommandResult } from "./process.ts";
import { snapshots, stackRepo, type StackCase, type StackVerb } from "./stack-fixture.ts";

const root = resolve(import.meta.dir, "../../../../skills");
export const usage = "skills lease-rebase <parent> <parent-old-tip> <branch>...";
export const leaseRebase: StackVerb = (args, io) => leaseRebaseVerb(args, usage, root, io);

export async function leaseCase(fixture: StackCase, name: string, shared = "base") {
  const { temporary, env, executable } = fixture;
  const repository = await stackRepo(fixture, {
    name,
    commits: [
      { branch: "main", message: "chore: initial files", files: { shared: shared + "\n" } },
      { branch: "a", message: "feat: a", files: { a: "a\n" } },
    ],
    checkout: "a",
  });

  const { repo, origin, git, command, commit } = repository;
  const state = { original: "main", oldA: repository.tips.a!, oldB: "", oldC: "" };

  async function succeed(argv: readonly string[], cwd = repo): Promise<string> {
    const result = await command(argv, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trimEnd();
  }

  async function stack(): Promise<void> {
    await repository.extend(
      [
        { branch: "b", message: "feat: b", files: { shared: "b\n" } },
        { branch: "c", message: "feat: c", files: { c: "c\n" } },
      ],
      state.original,
    );

    state.oldB = repository.tips.b!;
    state.oldC = repository.tips.c!;
  }

  async function fixParent(): Promise<void> {
    await git(["checkout", "--quiet", "a"]);
    await appendFile(join(repo, "a"), "fix\n");
    await commit("a", "fix: a", ["a"]);

    await git(["checkout", "--quiet", state.original]);
  }

  async function expectRestored(): Promise<void> {
    expect(await git(["symbolic-ref", "--quiet", "--short", "HEAD"])).toBe(state.original);

    for (const state of ["rebase-merge", "rebase-apply"]) {
      const path = await git(["rev-parse", "--git-path", state]);
      expect(existsSync(resolve(repo, path))).toBe(false);
    }
  }

  async function expectClean(): Promise<void> {
    await expectRestored();
    expect(await git(["status", "--porcelain"])).toBe("");
  }

  async function expectTip(branch: string, local: string, remote: string): Promise<void> {
    expect(await git(["rev-parse", `refs/heads/${branch}`])).toBe(local);
    expect(await git([`--git-dir=${origin}`, "rev-parse", `refs/heads/${branch}`])).toBe(remote);
  }

  async function expectRebased(
    branch: string,
    old: string,
    parent: string,
    count: number,
  ): Promise<void> {
    const tip = await git(["rev-parse", `refs/heads/${branch}`]);
    expect(tip).not.toBe(old);

    await expectTip(branch, tip, tip);
    expect(await git(["rev-parse", `${branch}~${count}`])).toBe(await git(["rev-parse", parent]));
  }

  async function rebaseStack(...args: string[]): Promise<CommandResult> {
    const result = await repository.run(leaseRebase, args);
    expect(result.code, result.stderr).toBe(0);

    await expectClean();

    return result;
  }

  async function refusal(reason: string, ...args: string[]): Promise<CommandResult> {
    const result = await repository.run(leaseRebase, args);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr.split("\n")).toContain(`lease-rebase: ${reason}`);

    await expectRestored();

    return result;
  }

  async function expectRefusal(reason: string, ...args: string[]): Promise<void> {
    const refs = ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"];
    const localBefore = await git(refs);
    const remoteBefore = await git([`--git-dir=${origin}`, ...refs]);
    const treeBefore = await git(["status", "--porcelain"]);

    const result = await refusal(reason, ...args);
    expect(result.stdout).toBe("");

    expect(await git(refs)).toBe(localBefore);
    expect(await git([`--git-dir=${origin}`, ...refs])).toBe(remoteBefore);
    expect(await git(["status", "--porcelain"])).toBe(treeBefore);
  }

  const snapshotHolder = snapshots(fixture, repository).holderState;

  async function expectHolderUnchanged(
    holder: string,
    before: { head: string; tree: string },
  ): Promise<void> {
    expect(await git(["rev-parse", "HEAD"], holder)).toBe(before.head);
    expect(await git(["status", "--porcelain"], holder)).toBe(before.tree);
  }

  async function holderAt(name: string): Promise<string> {
    return repository.holderAt(name, "c");
  }

  async function chainOutput(): Promise<string> {
    const newB = await git(["rev-parse", "b"]);
    const newC = await git(["rev-parse", "c"]);
    return `b ${state.oldB} ${newB}\nc ${state.oldC} ${newC}\n`;
  }

  async function signingKey(): Promise<void> {
    const key = join(temporary, "signing-key");
    await succeed(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", key]);

    const publicKey = (await readFile(`${key}.pub`, "utf8")).trimEnd();
    await writeFile(join(temporary, "allowed-signers"), `test@example.com ${publicKey}\n`);

    await git(["config", "gpg.format", "ssh"]);
    await git(["config", "user.signingkey", key]);
    await git(["config", "commit.gpgsign", "true"]);
  }

  return {
    temporary,
    env,
    repo,
    origin,
    state,
    git,
    command,
    succeed,
    commit,
    stack,
    fixParent,
    expectRestored,
    expectClean,
    expectTip,
    expectRebased,
    rebaseStack,
    refusal,
    expectRefusal,
    snapshotHolder,
    expectHolderUnchanged,
    holderAt,
    executable,
    run: repository.run,
    chainOutput,
    signingKey,
  };
}
