import { expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  faultGit,
  stackCase,
  stackRepo,
  type StackCase,
  type StackVerb,
} from "../test/stack-fixture.ts";
import { fixRoundVerb } from "./fix-round.ts";
import { leaseRebaseVerb } from "./lease-rebase.ts";
import { restackLayers } from "./layers.ts";
import { restackLayerVerb } from "./restack-layer.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "../../skills");
const restackLayer: StackVerb = (args, io) => restackLayerVerb(args, "restack-layer", root, io);
const fixRound: StackVerb = (args, io) => fixRoundVerb(args, "fix-round", root, io);
const leaseRebase: StackVerb = (args, io) => leaseRebaseVerb(args, "lease-rebase", root, io);

type Fault = {
  pattern: string;
  read: string;
  signing?: boolean;
  signal?: boolean;
  unwrapped?: boolean;
};

type Repository = Awaited<ReturnType<typeof stackRepo>>;

async function repository(fixture: StackCase): Promise<Repository> {
  return stackRepo(fixture, {
    name: "reads",
    directory: "Proj",
    commits: [
      { branch: "main", message: "chore: initial", files: { round: "base\n" } },
      { branch: "feat/a", base: "origin/main", message: "feat: a", files: { a: "a\n" } },
      { branch: "feat/b", base: "feat/a", message: "feat: b", files: { b: "b\n" } },
      { branch: "feat/c", base: "feat/b", message: "feat: c", files: { c: "c\n" } },
    ],
    checkout: "feat/a",
    index: {
      project: "Proj",
      text: "id\ta\tstatus\tc\td\te\tf\tbranch\n1\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\n2\t-\tREVIEW\t-\t-\t-\t-\tfeat/b\n3\t-\tREVIEW\t-\t-\t-\t-\tfeat/c\n",
    },
  });
}

async function refs(
  repo: Repository,
): Promise<{ local: string; origin: string; status: string; config: string }> {
  const args = ["for-each-ref", "--format=%(refname) %(objectname)"];
  const local = await repo.command(["git", ...args]);
  const origin = await repo.command(["git", `--git-dir=${repo.origin}`, ...args]);
  const status = await repo.command(["git", "status", "--porcelain"]);
  for (const result of [local, origin, status]) expect(result.code, result.stderr).toBe(0);

  return {
    local: local.stdout,
    origin: origin.stdout,
    status: status.stdout,
    config: await readFile(join(repo.repo, ".git/config"), "utf8"),
  };
}

async function faults(
  fixture: StackCase,
  repo: Repository,
  verb: StackVerb,
  args: readonly string[],
  cases: readonly Fault[],
): Promise<void> {
  await faultGit(fixture);

  for (const fault of cases) {
    if (fault.signing !== undefined)
      await repo.git(["config", "commit.gpgsign", String(fault.signing)]);

    const before = await refs(repo);
    fixture.env.FAULT_PATTERN = fault.pattern;
    if (fault.signal) fixture.env.FAULT_SIGNAL = "1";

    const result = await repo.run(verb, args);
    delete fixture.env.FAULT_PATTERN;
    delete fixture.env.FAULT_SIGNAL;

    expect(result.code, fault.pattern + "\n" + result.stderr).toBe(1);
    const refusal = result.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect(refusal, fault.pattern).toContain(fault.read);

    if (!fault.unwrapped)
      expect(refusal, fault.pattern).toMatch(
        fault.signal ? /(did not finish|died on SIGTERM)\)/ : /exited 128\)/,
      );

    expect(result.stdout, fault.pattern).toBe("");
    expect(await refs(repo), fault.pattern).toEqual(before);
  }
}

test.concurrent("restack-layer refuses read faults before its push", async () => {
  const fixture = await stackCase("skills-read-faults-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    await repo.extend(
      [{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }],
      "feat/b",
    );

    const rebased = await repo.run(restackLayer, ["-P", "Proj"]);
    expect(rebased.code, rebased.stderr).toBe(0);

    await repo.holderAt("held-c", "feat/c");
    await faults(
      fixture,
      repo,
      restackLayer,
      ["-P", "Proj", "--push"],
      [
        { pattern: "rev-list --merges*", read: "git rev-list" },
        { pattern: "diff --text*", read: "git diff" },
        { pattern: "diff --text*", read: "the diff of feat/b", signal: true },
        { pattern: "for-each-ref*", read: "git for-each-ref" },
        { pattern: "symbolic-ref --quiet --short HEAD", read: "cannot read HEAD" },
        { pattern: "symbolic-ref --quiet --short HEAD", read: "cannot read HEAD", signal: true },
        { pattern: "--git-dir=* symbolic-ref -q HEAD", read: "symbolic-ref" },
        { pattern: "config*skills-base*", read: "skills-base" },
        { pattern: "config branch.feat/b.skills-restack-lease", read: "skills-restack-lease" },
        { pattern: "config branch.feat/b.skills-restack-onto", read: "skills-restack-onto" },
        { pattern: "config --bool core.bare", read: "core.bare" },
        { pattern: "rev-parse --absolute-git-dir", read: "git rev-parse" },
        { pattern: "rev-parse --path-format=absolute --git-common-dir", read: "git rev-parse" },
        { pattern: "rev-parse --verify*", read: "git rev-parse" },
        { pattern: "rev-parse refs/heads/feat/c", read: "feat/c" },
        { pattern: "rev-parse refs/remotes/origin/feat/b", read: "origin/feat/b" },
        { pattern: "status --porcelain --untracked-files=no", read: "git status" },
        { pattern: "merge-base --is-ancestor*", read: "git merge-base" },
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("fix-round refuses read faults before its branch push", async () => {
  const fixture = await stackCase("skills-read-faults-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    await repo.holderAt("held-c", "feat/c");
    await appendFile(join(repo.repo, "round"), "fixed\n");

    await faults(
      fixture,
      repo,
      fixRound,
      ["-P", "Proj", "-m", "fix: round", "round"],
      [
        { pattern: "for-each-ref*", read: "git for-each-ref" },
        { pattern: "config*skills-base*", read: "skills-base" },
        { pattern: "symbolic-ref --quiet --short HEAD", read: "cannot read HEAD" },
        { pattern: "--git-dir=* symbolic-ref -q HEAD", read: "symbolic-ref" },
        {
          pattern: "diff --cached --no-renames --name-only -z*",
          read: "cannot read staged changes",
          unwrapped: true,
        },
        { pattern: "rev-parse refs/heads/feat/a", read: "feat/a" },
        { pattern: "rev-parse refs/remotes/origin/feat/a", read: "origin/feat/a" },
        { pattern: "rev-parse refs/heads/feat/c", read: "feat/c" },
        { pattern: "rev-parse refs/remotes/origin/feat/c", read: "origin/feat/c" },
        { pattern: "merge-base --is-ancestor*", read: "git merge-base" },
      ],
    );
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("lease-rebase refuses read faults before any layer push", async () => {
  const fixture = await stackCase("skills-read-faults-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    const oldA = repo.tips["feat/a"]!;
    await repo.extend(
      [{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }],
      "main",
    );

    await repo.holderAt("held-c", "feat/c");

    await faults(
      fixture,
      repo,
      leaseRebase,
      ["feat/a", oldA, "feat/b", "feat/c"],
      [
        { pattern: "rev-list --merges*", read: "git rev-list", signing: true },
        { pattern: "rev-list --merges*", read: "the replayed commits of feat/b", signal: true },
        {
          pattern: "diff -z --no-renames --name-only --diff-filter=A*",
          read: "git diff",
          signing: false,
        },
        { pattern: "symbolic-ref --quiet --short HEAD", read: "cannot read HEAD" },
        { pattern: "--git-dir=* symbolic-ref -q HEAD", read: "symbolic-ref" },
        { pattern: "config --bool commit.gpgsign", read: "commit.gpgsign" },
        { pattern: "config core.logAllRefUpdates", read: "core.logAllRefUpdates" },
        { pattern: "reflog exists refs/heads/feat/c", read: "git reflog" },
        { pattern: "rev-parse --verify*", read: "git rev-parse" },
        { pattern: "rev-parse refs/heads/feat/b", read: "feat/b" },
        { pattern: "rev-parse refs/remotes/origin/feat/b", read: "origin/feat/b" },
        { pattern: "status --porcelain", read: "git status" },
        { pattern: "merge-base --is-ancestor*", read: "git merge-base" },
      ],
    );

    const layers = ["feat/b", "feat/c"];
    const leases = new Map(layers.map((branch) => [branch, repo.tips[branch]!]));
    const restack: StackVerb = (args, io) =>
      restackLayers(
        { ...io, indexes: [repo.index!], ownRows: new Set() },
        "feat/a",
        oldA,
        args,
        leases,
        "restack-layer",
        [],
      );

    const before = await refs(repo);
    const admin = await repo.git(
      ["rev-parse", "--absolute-git-dir"],
      join(fixture.temporary, "held-c"),
    );

    fixture.env.FAULT_PATTERN = `--git-dir=${admin} symbolic-ref -q HEAD`;
    const result = await repo.run(restack, layers);
    delete fixture.env.FAULT_PATTERN;

    expect(result.code, result.stderr).toBe(1);
    expect(result.stderr).toContain("symbolic-ref");
    expect(result.stderr).toContain(`cannot read HEAD of ${admin}`);
    expect(result.stderr).toContain("every layer above it is untouched");
    expect(await refs(repo)).toEqual(before);

    await repo.git(["config", "core.logAllRefUpdates", "always"]);
    const always = await repo.run(leaseRebase, ["feat/a", oldA, "feat/b", "feat/c"]);
    expect(always.code, always.stderr).toBe(0);
  } finally {
    await fixture.dispose();
  }
});
