import { expect } from "bun:test";
import { resolve } from "node:path";
import { fixRoundVerb } from "../stack/fix-round.ts";
import { editView } from "./plans-views.ts";
import type { CommandResult } from "./process.ts";
import {
  roundStack,
  snapshots,
  stackRepo,
  type StackCase,
  type StackVerb,
} from "./stack-fixture.ts";

const root = resolve(import.meta.dir, "../../../../skills");
const usage = 'skills fix-round [-P <Project>] -m "<message>" <file>...';
export const fixRound: StackVerb = (args, io) => fixRoundVerb(args, usage, root, io);

export async function fixRoundCase(fixture: StackCase, name: string) {
  const { temporary, env, executable } = fixture;
  const repository = await stackRepo(fixture, roundStack(name));
  const { repo, origin, git, command, run, commit } = repository;
  const index = repository.index!;

  async function succeed(argv: readonly string[], cwd = repo): Promise<CommandResult> {
    const result = await command(argv, cwd);
    expect(result.code, result.stderr).toBe(0);
    return result;
  }

  async function round(...files: string[]): Promise<CommandResult> {
    return run(fixRound, [
      "-P",
      "Proj",
      "-m",
      "fix: guard empty input",
      ...(files.length ? files : ["round"]),
    ]);
  }

  async function refusal(
    reason: string,
    args?: readonly string[],
    cwd = repo,
  ): Promise<CommandResult> {
    const result = args ? await run(fixRound, args, cwd) : await round();
    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain(reason);
    expect(result.stdout).toBe("");
    return result;
  }

  const { branches, tip, holderState } = snapshots(fixture, repository);

  async function holderAt(name: string, branch = "feat/c"): Promise<string> {
    return repository.holderAt(name, branch);
  }

  async function upperUnchanged(oldB: string, oldC: string): Promise<void> {
    await tip("feat/b", oldB);
    await tip("feat/c", oldC);
    await tip("feat/a", await git(["rev-parse", "feat/a"]));
    expect(await git(["branch", "--show-current"])).toBe("feat/a");
  }

  async function doing(): Promise<void> {
    await editView(env, index, (text) => text.replace("3\t-\t-\t-", "3\t-\tDOING\t-"));
  }

  return {
    temporary,
    env,
    repo,
    origin,
    index,
    git,
    command,
    run,
    commit,
    succeed,
    round,
    refusal,
    branches,
    holderAt,
    holderState,
    tip,
    upperUnchanged,
    executable,
    doing,
    branch: repository.branch,
  };
}
