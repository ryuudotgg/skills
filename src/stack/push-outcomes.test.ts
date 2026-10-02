import { expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { faultGit, stackCase, stackRepo, type StackCase, type StackVerb } from "../test/stack-fixture.ts";
import { fixRoundVerb } from "./fix-round.ts";
import { leaseRebaseVerb } from "./lease-rebase.ts";
import { restackLayerVerb } from "./restack-layer.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "../../skills");
const restackLayer: StackVerb = (args, io) => restackLayerVerb(args, "restack-layer", root, io);
const leaseRebase: StackVerb = (args, io) => leaseRebaseVerb(args, "lease-rebase", root, io);
const fixRound: StackVerb = (args, io) => fixRoundVerb(args, "fix-round", root, io);
const pushB = "push --quiet --force-with-lease=refs/heads/feat/b:*";

type Repository = Awaited<ReturnType<typeof stackRepo>>;

async function repository(fixture: StackCase): Promise<Repository> {
  return stackRepo(fixture, {
    name: "pushes",
    directory: "Proj",
    commits: [
      { branch: "main", message: "chore: initial", files: { round: "base\n" } },
      { branch: "feat/a", base: "origin/main", message: "feat: a", files: { a: "a\n" } },
      { branch: "feat/b", base: "feat/a", message: "feat: b", files: { b: "b\n" } },
      { branch: "feat/c", base: "feat/b", message: "feat: c", files: { c: "c\n" } },
    ],
    checkout: "feat/a",
    index: { project: "Proj", text: "id\ta\tstatus\tc\td\te\tf\tbranch\n1\t-\tREVIEW\t-\t-\t-\t-\tfeat/a\n2\t-\tREVIEW\t-\t-\t-\t-\tfeat/b\n3\t-\tREVIEW\t-\t-\t-\t-\tfeat/c\n" },
  });
}

async function tips(repo: Repository, branch: string): Promise<{ local: string; origin: string }> {
  return {
    local: await repo.git(["rev-parse", `refs/heads/${branch}`]),
    origin: await repo.git([`--git-dir=${repo.origin}`, "rev-parse", `refs/heads/${branch}`]),
  };
}

async function rebasedB(fixture: StackCase): Promise<{ repo: Repository; lease: string; next: string; trace: string }> {
  const repo = await repository(fixture);
  await repo.extend([{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }], "feat/b");

  const rebased = await repo.run(restackLayer, ["-P", "Proj"]);
  expect(rebased.code, rebased.stderr).toBe(0);

  await faultGit(fixture);
  const trace = join(fixture.temporary, "trace");
  await writeFile(trace, "");
  fixture.env.FAULT_TRACE = trace;

  return { repo, lease: repo.tips["feat/b"]!, next: await repo.git(["rev-parse", "refs/heads/feat/b"]), trace };
}

function clearFaults(fixture: StackCase): void {
  delete fixture.env.FAULT_AFTER;
  delete fixture.env.FAULT_PATTERN;
}

async function pushesOf(trace: string, branch: string): Promise<number> {
  return (await readFile(trace, "utf8")).split("\n").filter((line) => line.startsWith("push ") && line.endsWith(`:refs/heads/${branch}`)).length;
}

async function expectFinished(repo: Repository): Promise<void> {
  const b = await tips(repo, "feat/b");
  const c = await tips(repo, "feat/c");

  expect(b.origin).toBe(b.local);
  expect(c.origin).toBe(c.local);
  expect(await repo.git(["rev-parse", "feat/b~1"])).toBe(await repo.git(["rev-parse", "feat/a"]));
  expect(await repo.git(["rev-parse", "feat/c~1"])).toBe(b.local);

  const lease = await repo.command(["git", "config", "branch.feat/b.skills-restack-lease"]);
  expect(lease.code).toBe(1);
}

test.concurrent("restack-layer reads origin after a push that landed and exited 128", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const { repo, trace } = await rebasedB(fixture);
    fixture.env.FAULT_AFTER = pushB;

    const pushed = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
    clearFaults(fixture);

    expect(pushed.code, pushed.stderr).toBe(0);
    expect(pushed.stdout).toBe("pushed feat/b\nrebased feat/c and pushed\n");
    expect(await pushesOf(trace, "feat/b")).toBe(1);
    await expectFinished(repo);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("restack-layer reruns a landed push without pushing it again", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const { repo, next, trace } = await rebasedB(fixture);
    fixture.env.FAULT_AFTER = pushB;
    fixture.env.FAULT_PATTERN = "config --unset branch.feat/b.skills-restack-lease";

    const first = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    expect(first.stderr).toContain("feat/b is pushed");
    expect(first.stderr).not.toContain("nothing pushed");
    expect((await tips(repo, "feat/b")).origin).toBe(next);

    const rerun = await repo.run(restackLayer, ["-P", "Proj", "--push"]);

    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stderr).not.toContain("moved since the rebase began");
    expect(rerun.stdout).toBe("pushed feat/b\nrebased feat/c and pushed\n");
    expect(await pushesOf(trace, "feat/b")).toBe(1);
    await expectFinished(repo);
  } finally {
    await fixture.dispose();
  }
});

for (const landed of [false, true])
  test.concurrent(`restack-layer names both tips when origin cannot be read after a push that ${landed ? "landed" : "failed"}`, async () => {
    const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
    try {
      const { repo, lease, next, trace } = await rebasedB(fixture);
      if (landed) fixture.env.FAULT_AFTER = pushB;
      fixture.env.FAULT_PATTERN = landed ? "ls-remote origin refs/heads/feat/b" : `${pushB}\nls-remote origin refs/heads/feat/b`;

      const failed = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
      clearFaults(fixture);

      expect(failed.code).toBe(1);

      const refusal = failed.stderr.trimEnd().split("\n").at(-1) ?? "";
      expect(refusal).toContain(lease);
      expect(refusal).toContain(next);
      expect(refusal).not.toContain("nothing pushed");
      expect((await tips(repo, "feat/b")).origin).toBe(landed ? next : lease);

      const rerun = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
      expect(rerun.code, rerun.stderr).toBe(0);
      expect(rerun.stdout).toBe("pushed feat/b\nrebased feat/c and pushed\n");
      expect(await pushesOf(trace, "feat/b")).toBe(landed ? 1 : 2);
      await expectFinished(repo);
    } finally {
      await fixture.dispose();
    }
  });

test.concurrent("lease-rebase leaves local and origin together when a moved layer cannot be read", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    const oldA = repo.tips["feat/a"]!;
    await repo.extend([{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }], "main");
    await repo.holderAt("held-c", "feat/c");

    await faultGit(fixture);
    fixture.env.FAULT_PATTERN = "rev-parse *refs/heads/feat/c@{1}";
    const result = await repo.run(leaseRebase, ["feat/a", oldA, "feat/b", "feat/c"]);
    clearFaults(fixture);

    expect(result.code).toBe(1);

    for (const branch of ["feat/b", "feat/c"]) {
      const { local, origin } = await tips(repo, branch);
      expect(origin, branch).toBe(local);
      expect(local, branch).not.toBe(repo.tips[branch]);
    }

    const c = await tips(repo, "feat/c");
    expect(result.stderr).toContain(c.local);
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("lease-rebase names both tips of every layer when origin cannot be read after its push", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    const oldA = repo.tips["feat/a"]!;
    await repo.extend([{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }], "main");

    await faultGit(fixture);
    fixture.env.FAULT_AFTER = "push --quiet --atomic *";
    fixture.env.FAULT_PATTERN = "ls-remote origin refs/heads/feat/b refs/heads/feat/c";
    const result = await repo.run(leaseRebase, ["feat/a", oldA, "feat/b", "feat/c"]);
    clearFaults(fixture);

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");

    const refusal = result.stderr.trimEnd().split("\n").at(-1) ?? "";
    expect(refusal).not.toContain("no layer moved");
    expect(refusal).not.toContain("rerun");

    for (const branch of ["feat/b", "feat/c"]) {
      const { local, origin } = await tips(repo, branch);
      expect(local, branch).toBe(repo.tips[branch]!);
      expect(refusal).toContain(`origin/${branch} is either ${local} or ${origin}`);
    }
  } finally {
    await fixture.dispose();
  }
});

for (const readable of [true, false])
  test.concurrent(`fix-round ${readable ? "restacks after a push that landed and exited 128" : "names both tips when origin cannot be read after its push"}`, async () => {
    const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
    try {
      const repo = await repository(fixture);
      const before = repo.tips["feat/a"]!;
      await appendFile(join(repo.repo, "round"), "fixed\n");

      await faultGit(fixture);
      fixture.env.FAULT_AFTER = "push --quiet origin *:refs/heads/feat/a";
      if (!readable) fixture.env.FAULT_PATTERN = "ls-remote origin refs/heads/feat/a";
      const result = await repo.run(fixRound, ["-P", "Proj", "-m", "fix: round", "round"]);
      clearFaults(fixture);

      const head = await repo.git(["rev-parse", "refs/heads/feat/a"]);
      expect((await tips(repo, "feat/a")).origin).toBe(head);

      if (!readable) {
        expect(result.code).toBe(1);
        expect(result.stdout).toBe("");
        expect(result.stderr.trimEnd().split("\n").at(-1)).toContain(`origin/feat/a is either ${before} or ${head}`);
        return;
      }

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("pushed feat/a\nrebased feat/b and pushed\nrebased feat/c and pushed\n");

      for (const [branch, parent] of [["feat/b", "feat/a"], ["feat/c", "feat/b"]] as const) {
        const { local, origin } = await tips(repo, branch);
        expect(origin, branch).toBe(local);
        expect(await repo.git(["rev-parse", `${branch}~1`])).toBe(await repo.git(["rev-parse", parent]));
      }
    } finally {
      await fixture.dispose();
    }
  });
