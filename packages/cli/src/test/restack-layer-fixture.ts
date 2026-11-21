import { expect } from "bun:test";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { restackLayerVerb } from "../stack/restack-layer.ts";
import { writeFixture } from "./fixtures.ts";
import type { CommandResult } from "./process.ts";
import {
  roundStack,
  snapshots,
  stackRepo,
  type StackCase,
  type StackVerb,
} from "./stack-fixture.ts";

export const root = resolve(import.meta.dir, "../../../../skills");
export const usage =
  "skills restack-layer [-P <Project>] [--push] [--onto <parent> <old parent tip>]";

export const restackLayer: StackVerb = (args, io) => restackLayerVerb(args, usage, root, io);

export async function layerCase(fixture: StackCase, name: string) {
  const { temporary, env, executable } = fixture;
  const repository = await stackRepo(fixture, roundStack(name));

  const index = repository.index!;
  const state = { repo: repository.repo, origin: repository.origin, oldB: "", oldC: "" };
  async function git(args: readonly string[], cwd = state.repo): Promise<string> {
    return fixture.git(args, cwd);
  }

  async function command(argv: readonly string[], cwd = state.repo): Promise<CommandResult> {
    return fixture.command(argv, cwd);
  }

  async function run(
    verb: StackVerb,
    args: readonly string[],
    cwd = state.repo,
  ): Promise<CommandResult> {
    return fixture.run(verb, args, cwd);
  }

  async function succeed(argv: readonly string[], cwd = state.repo): Promise<CommandResult> {
    const result = await command(argv, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result;
  }

  async function commit(
    branch: string,
    message: string,
    files: string[],
    cwd = state.repo,
  ): Promise<void> {
    await repository.commit(branch, message, files, cwd);
  }

  async function holderAt(name: string, branch = "feat/c"): Promise<string> {
    return fixture.holderAt(name, branch, state.repo);
  }

  const { branches, tip, holderState } = snapshots(fixture, state);

  async function layer(...args: string[]): Promise<CommandResult> {
    return run(restackLayer, ["-P", "Proj", ...args]);
  }

  async function layerSuccess(output: string, ...args: string[]): Promise<void> {
    const result = await layer(...args);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${output}\n`);
  }

  async function refusal(reason: string, ...args: string[]): Promise<CommandResult> {
    const result = await layer(...args);
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(`restack-layer: ${reason}`);
    expect(result.stdout).toBe("");
    return result;
  }

  async function config(key: string): Promise<string> {
    return (await command(["git", "config", key])).stdout.trimEnd();
  }

  async function staleB(conflict = false): Promise<void> {
    if (conflict) {
      await git(["checkout", "--quiet", "feat/b"]);
      await writeFixture(state.repo, "round", "b change\n");
      await commit("feat/b", "feat: b edits round", ["round"]);
    }

    await git(["checkout", "--quiet", "feat/a"]);
    await writeFixture(state.repo, "round", "a change\n");
    await commit("feat/a", "fix: a edits round", ["round"]);

    state.oldB = await git(["rev-parse", "feat/b"]);
    state.oldC = await git(["rev-parse", "feat/c"]);
    await git(["checkout", "--quiet", "feat/b"]);
  }

  async function unchanged(): Promise<void> {
    await tip("feat/b", state.oldB);
    await tip("feat/c", state.oldC);
  }

  async function conflict(
    branch = "feat/b",
    base = "feat/a",
    lease = state.oldB,
    ...args: string[]
  ): Promise<void> {
    await refusal(
      `conflict rebasing ${branch} onto ${base}, resolve it here, git add, GIT_EDITOR=true git rebase --continue, run the standing checks, then skills restack-layer --push`,
      ...args,
    );

    const admin = await git(["rev-parse", "--absolute-git-dir"]);
    expect(existsSync(join(admin, "rebase-merge")) || existsSync(join(admin, "rebase-apply"))).toBe(
      true,
    );

    expect(await config(`branch.${branch}.skills-restack-lease`)).toBe(lease);
  }

  async function resolveRound(content = "resolved"): Promise<void> {
    await writeFixture(state.repo, "round", `${content}\n`);
    await git(["add", "--", "round"]);
    await succeed(["git", "rebase", "--continue"]);
  }

  async function pushed(): Promise<void> {
    const newB = await git(["rev-parse", "feat/b"]);
    const newC = await git(["rev-parse", "feat/c"]);
    expect(newB).not.toBe(state.oldB);

    expect(newC).not.toBe(state.oldC);
    await tip("feat/b", newB);
    await tip("feat/c", newC);

    await git(["merge-base", "--is-ancestor", "feat/a", "feat/b"]);
    await git(["merge-base", "--is-ancestor", "feat/b", "feat/c"]);
    expect(await config("branch.feat/b.skills-restack-lease")).toBe("");
  }

  async function race(
    racerName: string,
    files: string[] = [],
    message = "fix: raced b",
  ): Promise<string> {
    const racer = await fixture.clone(state.origin, racerName);
    await git(["checkout", "--quiet", "feat/b"], racer);

    for (const file of files) await writeFixture(racer, file, `${file}\n`);

    return repository.commit("feat/b", message, files, racer);
  }

  return {
    temporary,
    env,
    state,
    index,
    executable,
    git,
    command,
    run,
    succeed,
    commit,
    holderAt,
    holderState,
    branches,
    tip,
    layer,
    layerSuccess,
    refusal,
    config,
    staleB,
    unchanged,
    conflict,
    resolveRound,
    pushed,
    race,
  };
}
