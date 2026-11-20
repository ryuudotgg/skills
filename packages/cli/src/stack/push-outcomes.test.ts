import { expect, setDefaultTimeout, test } from "bun:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  faultGit,
  stackCase,
  stackRepo,
  threeLayerStack,
  type StackCase,
  type StackVerb,
} from "../test/stack-fixture.ts";
import { fixRoundVerb } from "./fix-round.ts";
import { leaseRebaseVerb } from "./lease-rebase.ts";
import { restackLayerVerb } from "./restack-layer.ts";

setDefaultTimeout(60_000);

const root = resolve(import.meta.dir, "../../../../skills");
const restackLayer: StackVerb = (args, io) => restackLayerVerb(args, "restack-layer", root, io);
const leaseRebase: StackVerb = (args, io) => leaseRebaseVerb(args, "lease-rebase", root, io);
const fixRound: StackVerb = (args, io) => fixRoundVerb(args, "fix-round", root, io);
const pushB = "push --quiet --force-with-lease=refs/heads/feat/b:*";

type Repository = Awaited<ReturnType<typeof stackRepo>>;

async function repository(fixture: StackCase): Promise<Repository> {
  return stackRepo(fixture, threeLayerStack("pushes"));
}

async function tips(repo: Repository, branch: string): Promise<{ local: string; origin: string }> {
  return {
    local: await repo.git(["rev-parse", `refs/heads/${branch}`]),
    origin: await repo.git([`--git-dir=${repo.origin}`, "rev-parse", `refs/heads/${branch}`]),
  };
}

async function rebasedB(
  fixture: StackCase,
): Promise<{ repo: Repository; lease: string; next: string; trace: string }> {
  const repo = await repository(fixture);
  await repo.extend(
    [{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }],
    "feat/b",
  );

  const rebased = await repo.run(restackLayer, ["-P", "Proj"]);
  expect(rebased.code, rebased.stderr).toBe(0);

  await faultGit(fixture);
  const trace = join(fixture.temporary, "trace");
  await writeFile(trace, "");
  fixture.env.FAULT_TRACE = trace;

  return {
    repo,
    lease: repo.tips["feat/b"]!,
    next: await repo.git(["rev-parse", "refs/heads/feat/b"]),
    trace,
  };
}

function clearFaults(fixture: StackCase): void {
  delete fixture.env.FAULT_AFTER;
  delete fixture.env.FAULT_PATTERN;
}

async function pushesOf(trace: string, branch: string): Promise<number> {
  return (await readFile(trace, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("push ") && line.endsWith(`:refs/heads/${branch}`)).length;
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
      fixture.env.FAULT_PATTERN = landed
        ? "ls-remote origin refs/heads/feat/b"
        : `${pushB}\nls-remote origin refs/heads/feat/b`;

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
    await repo.extend(
      [{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }],
      "main",
    );

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
    await repo.extend(
      [{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }],
      "main",
    );

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

const atomicPush = "push --quiet --atomic *";
const readBC = "ls-remote origin refs/heads/feat/b refs/heads/feat/c";

async function pushedRefs(trace: string, branch: string): Promise<number> {
  return (await readFile(trace, "utf8"))
    .split("\n")
    .filter((line) => line.startsWith("push "))
    .flatMap((line) => line.split(" "))
    .filter((word) => word.endsWith(`:refs/heads/${branch}`)).length;
}

async function records(repo: Repository): Promise<string> {
  return (await repo.command(["git", "config", "--get-regexp", "skills-restack"])).stdout;
}

async function branches(repo: Repository): Promise<string> {
  return repo.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads"]);
}

async function unfinished(
  repo: Repository,
  layers: readonly string[],
): Promise<Record<string, string>> {
  const next: Record<string, string> = {};
  for (const branch of layers) {
    const { local, origin } = await tips(repo, branch);
    expect(local, branch).toBe(repo.tips[branch]!);
    expect(origin, branch).not.toBe(local);
    next[branch] = origin;
  }

  return next;
}

async function traced(fixture: StackCase): Promise<string> {
  await faultGit(fixture);
  const trace = join(fixture.temporary, "trace");
  await writeFile(trace, "");
  fixture.env.FAULT_TRACE = trace;
  return trace;
}

async function leaseRebaseStack(
  fixture: StackCase,
): Promise<{ repo: Repository; args: string[]; trace: string }> {
  const repo = await repository(fixture);
  const oldA = repo.tips["feat/a"]!;
  await repo.extend([{ branch: "feat/a", message: "fix: a", files: { a: "a\nfixed\n" } }], "main");

  return { repo, args: ["feat/a", oldA, "feat/b", "feat/c"], trace: await traced(fixture) };
}

test.concurrent("lease-rebase finishes an unfinished restack on a rerun", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const { repo, args, trace } = await leaseRebaseStack(fixture);
    fixture.env.FAULT_AFTER = atomicPush;
    fixture.env.FAULT_PATTERN = readBC;
    const first = await repo.run(leaseRebase, args);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    const next = await unfinished(repo, ["feat/b", "feat/c"]);

    const rerun = await repo.run(leaseRebase, args);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe(
      `feat/b ${repo.tips["feat/b"]} ${next["feat/b"]}\nfeat/c ${repo.tips["feat/c"]} ${next["feat/c"]}\n`,
    );

    for (const branch of ["feat/b", "feat/c"]) expect(await pushedRefs(trace, branch)).toBe(1);
    await expectFinished(repo);
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("fix-round finishes an unfinished restack on a rerun", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    await appendFile(join(repo.repo, "round"), "fixed\n");
    const trace = await traced(fixture);
    const args = ["-P", "Proj", "-m", "fix: round", "round"];

    fixture.env.FAULT_AFTER = atomicPush;
    fixture.env.FAULT_PATTERN = readBC;
    const first = await repo.run(fixRound, args);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    await unfinished(repo, ["feat/b", "feat/c"]);

    const rerun = await repo.run(fixRound, args);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe("rebased feat/b and pushed\nrebased feat/c and pushed\n");

    for (const branch of ["feat/a", "feat/b", "feat/c"])
      expect(await pushedRefs(trace, branch), branch).toBe(1);

    await expectFinished(repo);
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("restack-layer --push finishes an unfinished restack on a rerun", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const { repo, trace } = await rebasedB(fixture);
    fixture.env.FAULT_AFTER = atomicPush;
    fixture.env.FAULT_PATTERN = "ls-remote origin refs/heads/feat/c";

    const first = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    await unfinished(repo, ["feat/c"]);

    const rerun = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe("rebased feat/c and pushed\n");

    for (const branch of ["feat/b", "feat/c"])
      expect(await pushedRefs(trace, branch), branch).toBe(1);

    await expectFinished(repo);
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("lease-rebase restacks again when its push never landed on a layer ahead of origin", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const { repo, args } = await leaseRebaseStack(fixture);
    await repo.git(["checkout", "--quiet", "feat/c"]);
    await writeFile(join(repo.repo, "c"), "c\nahead\n");
    await repo.git(["commit", "--quiet", "-am", "fix: c ahead"]);
    await repo.git(["checkout", "--quiet", "main"]);

    const ahead = await tips(repo, "feat/c");
    expect(ahead.local).not.toBe(ahead.origin);

    fixture.env.FAULT_PATTERN = `${atomicPush}\n${readBC}`;
    const first = await repo.run(leaseRebase, args);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    expect(await tips(repo, "feat/c")).toEqual(ahead);
    expect(await records(repo)).toMatch(new RegExp(`${ahead.origin} [0-9a-f]+ ${ahead.local} `));

    const rerun = await repo.run(leaseRebase, args);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toMatch(/^feat\/b \S+ \S+\nfeat\/c \S+ \S+\n$/);

    for (const branch of ["feat/b", "feat/c"]) {
      const { local, origin } = await tips(repo, branch);
      expect(origin, branch).toBe(local);
    }

    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("restack-layer --push restacks again when its layer push never landed", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const { repo, trace } = await rebasedB(fixture);
    fixture.env.FAULT_PATTERN = `${atomicPush}\nls-remote origin refs/heads/feat/c`;

    const first = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    expect(await tips(repo, "feat/c")).toEqual({
      local: repo.tips["feat/c"]!,
      origin: repo.tips["feat/c"]!,
    });

    const rerun = await repo.run(restackLayer, ["-P", "Proj", "--push"]);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe("rebased feat/c and pushed\n");
    expect(await pushedRefs(trace, "feat/c")).toBe(2);

    await expectFinished(repo);
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("fix-round restacks again when its layer push never landed", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    await appendFile(join(repo.repo, "round"), "fixed\n");
    await traced(fixture);
    const args = ["-P", "Proj", "-m", "fix: round", "round"];

    fixture.env.FAULT_PATTERN = `${atomicPush}\n${readBC}`;
    const first = await repo.run(fixRound, args);
    clearFaults(fixture);

    expect(first.code).toBe(1);

    for (const branch of ["feat/b", "feat/c"])
      expect((await tips(repo, branch)).origin, branch).toBe(repo.tips[branch]!);

    const rerun = await repo.run(fixRound, args);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe("rebased feat/b and pushed\nrebased feat/c and pushed\n");
    await expectFinished(repo);
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("fix-round restacks again when an unpublished layer sits below a published one", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    await repo.git(["push", "--quiet", "origin", "--delete", "feat/b"]);
    await appendFile(join(repo.repo, "round"), "fixed\n");
    await traced(fixture);
    const args = ["-P", "Proj", "-m", "fix: round", "round"];

    fixture.env.FAULT_PATTERN = `${atomicPush}\nls-remote origin refs/heads/feat/c`;
    const first = await repo.run(fixRound, args);
    clearFaults(fixture);

    expect(first.code).toBe(1);

    const rerun = await repo.run(fixRound, args);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe(
      "rebased feat/b (not on origin, not pushed)\nrebased feat/c and pushed\n",
    );

    expect(await repo.git(["rev-parse", "feat/b~1"])).toBe(await repo.git(["rev-parse", "feat/a"]));
    expect(await repo.git(["rev-parse", "feat/c~1"])).toBe(await repo.git(["rev-parse", "feat/b"]));
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

test.concurrent("fix-round finishes an unfinished restack after a round that deleted its file", async () => {
  const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
  try {
    const repo = await repository(fixture);
    await repo.git(["rm", "--quiet", "round"]);
    await traced(fixture);
    const args = ["-P", "Proj", "-m", "fix: drop round", "round"];

    fixture.env.FAULT_AFTER = atomicPush;
    fixture.env.FAULT_PATTERN = readBC;
    const first = await repo.run(fixRound, args);
    clearFaults(fixture);

    expect(first.code).toBe(1);
    await unfinished(repo, ["feat/b", "feat/c"]);

    const rerun = await repo.run(fixRound, args);
    expect(rerun.code, rerun.stderr).toBe(0);
    expect(rerun.stdout).toBe("rebased feat/b and pushed\nrebased feat/c and pushed\n");
    await expectFinished(repo);
    expect(await records(repo)).toBe("");
  } finally {
    await fixture.dispose();
  }
});

for (const moved of ["origin", "holder"] as const)
  test.concurrent(`lease-rebase keeps a record that does not match its rerun when ${moved === "origin" ? "origin/feat/c moved on" : "a holder of feat/c has a tracked change"}`, async () => {
    const fixture = await stackCase("skills-push-outcomes-", { assertNoGhCalls: true });
    try {
      const { repo, args } = await leaseRebaseStack(fixture);
      fixture.env.FAULT_AFTER = atomicPush;
      fixture.env.FAULT_PATTERN = readBC;
      const first = await repo.run(leaseRebase, args);
      clearFaults(fixture);

      expect(first.code).toBe(1);
      const next = await unfinished(repo, ["feat/b", "feat/c"]);
      const recorded = await records(repo);
      expect(recorded).toContain(`${repo.tips["feat/c"]} ${next["feat/c"]}`);

      if (moved === "origin") {
        const other = await fixture.clone(repo.origin, "other");
        await repo.git(["checkout", "--quiet", "feat/c"], other);
        await writeFile(join(other, "c"), "c\nelsewhere\n");
        await repo.git(["commit", "--quiet", "-am", "fix: c elsewhere"], other);
        await repo.git(["push", "--quiet", "origin", "feat/c"], other);
      } else {
        const holder = await repo.holderAt("held-c", "feat/c");
        await writeFile(join(holder, "c"), "c\nedited\n");
      }

      const before = await branches(repo);

      const rerun = await repo.run(leaseRebase, args);

      expect(rerun.code).toBe(1);
      expect(rerun.stdout).toBe("");

      const refusal = rerun.stderr.trimEnd().split("\n").at(-1) ?? "";
      if (moved === "origin") {
        expect(refusal).toContain("feat/c");
        expect(refusal).toContain(repo.tips["feat/c"]!);
        expect(refusal).toContain(next["feat/c"]!);
      } else expect(refusal).toContain("feat/c is held by");

      expect(await branches(repo)).toBe(before);

      expect(await records(repo)).toBe(recorded);
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
        expect(result.stderr.trimEnd().split("\n").at(-1)).toContain(
          `origin/feat/a is either ${before} or ${head}`,
        );

        return;
      }

      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(
        "pushed feat/a\nrebased feat/b and pushed\nrebased feat/c and pushed\n",
      );

      for (const [branch, parent] of [
        ["feat/b", "feat/a"],
        ["feat/c", "feat/b"],
      ] as const) {
        const { local, origin } = await tips(repo, branch);
        expect(origin, branch).toBe(local);
        expect(await repo.git(["rev-parse", `${branch}~1`])).toBe(
          await repo.git(["rev-parse", parent]),
        );
      }
    } finally {
      await fixture.dispose();
    }
  });
