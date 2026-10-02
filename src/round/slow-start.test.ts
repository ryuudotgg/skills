import { afterEach, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readDeclarations } from "../reviewers/declaration.ts";
import { failure, fixture, repo, response, success } from "./fixtures.ts";
import { presence } from "./presence.ts";
import { runRound } from "./round.ts";
import { commentsQuery, readSnapshot, snapshotQuery } from "./snapshot.ts";
import type { CheckRun, Comment, PullRequest } from "./types.ts";

const temporary: string[] = [];
const opened = Date.parse("2026-10-02T02:33:54Z") / 1000;
const head = "a".repeat(40);

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function at(seconds: number): string {
  return new Date((opened + seconds) * 1000).toISOString().replace(".000Z", "Z");
}

function pullRequest(apps: readonly string[], comments: Comment[] = []): PullRequest {
  return {
    body: "",
    createdAt: at(0),
    timelineItems: { nodes: [] },
    userContentEdits: { nodes: [] },
    comments: { nodes: comments },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: head,
            committedDate: at(-7),
            checkSuites: { nodes: apps.map((slug) => ({ createdAt: at(-2), app: { slug } })) },
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        },
      ],
    },
  };
}

function greptileRun(started: number, completed: number | null): CheckRun {
  return {
    __typename: "CheckRun",
    name: "Greptile Review",
    status: completed === null ? "IN_PROGRESS" : "COMPLETED",
    conclusion: completed === null ? null : "SUCCESS",
    title: "",
    startedAt: at(started),
    completedAt: completed === null ? null : at(completed),
    checkSuite: { createdAt: at(-2) },
  };
}

function reviewed(pr: PullRequest, seconds: number): void {
  pr.reviews.nodes.push({
    author: { login: "greptile-apps" },
    body: "Confidence Score: 5/5",
    submittedAt: at(seconds),
    commit: { oid: head },
  });
}

function setup(names: string[], conf: string, start: number) {
  const value = fixture(names);
  temporary.push(value.temporary);
  writeFileSync(value.conf, `DELIVERY=prs\nWITH=${names.join(" ")}\n${conf}`);
  delete value.deps.env.REVIEW_NOW;
  value.deps.env.ROUND_POLL = "30";

  let clock = opened + start;
  value.deps.clock = () => clock;
  value.deps.sleep = async (seconds) => {
    clock += seconds;
  };

  value.deps.git = async (args) => (args.includes("--get-regexp") ? failure() : success("main"));
  return { ...value, elapsed: () => clock - opened };
}

for (const [label, conf, trigger, run] of [
  ["requested with auto off", "GREPTILE_AUTO=no\n", 180, 295],
  ["on its own", "", null, 100],
] as const)
  test(`Greptile whose run starts late after its suite reads its own verdict: ${label}`, async () => {
    const value = setup(["greptile"], conf, (trigger ?? 0) + 5);
    const passes: number[] = [];
    value.deps.gh = async () => {
      const now = value.elapsed();
      passes.push(now);
      const pr = pullRequest(["greptile-apps", "coderabbitai"]);
      if (trigger !== null)
        pr.comments.nodes.push({
          author: { login: "developer" },
          body: "@greptileai",
          createdAt: at(trigger),
        });

      const contexts = pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
      if (now >= run + 60) {
        contexts.push(greptileRun(run, run + 60));
        reviewed(pr, run + 60);
      } else if (now >= run) contexts.push(greptileRun(run, null));

      return success(response(pr));
    };

    const result = await runRound(["gate", "18", "--wait"], value.deps);

    expect(result).toEqual({ code: 0, stdout: "greptile triage scored\ntriage\n", stderr: "" });
    expect(passes.some((now) => now - (trigger ?? 0) > 60 && now < run)).toBe(true);
  });

test("a reviewer with no app suite on the head and no activity still reads absent", async () => {
  const value = setup(["greptile", "macroscope"], "", 0);
  value.deps.gh = async () => success(response(pullRequest(["greptile-apps"])));

  const result = await runRound(["gate", "18", "--wait"], value.deps);

  expect(result.stdout).toBe(
    "greptile unavailable no-start\nmacroscope absent\nhandback greptile unavailable no-start\n",
  );

  expect(value.elapsed()).toBe(180);
});

test("an installed reviewer that never starts steps aside after the start window", async () => {
  const value = setup(["coderabbit", "macroscope"], "", 0);
  const pr = pullRequest(["coderabbitai", "macroscopeapp"]);
  pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes.push({
    __typename: "StatusContext",
    context: "CodeRabbit",
    state: "SUCCESS",
    description: "Review completed",
    createdAt: at(20),
  });

  pr.reviews.nodes.push({
    author: { login: "coderabbitai" },
    state: "COMMENTED",
    body: "Reviewed this commit.",
    commit: { oid: head },
    submittedAt: at(20),
  });

  value.deps.gh = async () => success(response(pr));

  const result = await runRound(["gate", "18", "--wait"], value.deps);

  expect(result.stdout).toBe("coderabbit done clean\nmacroscope unavailable no-start\ndone\n");
  expect(value.elapsed()).toBe(180);
});

function comments(count: number, triggers: readonly number[] = []): Comment[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `IC_${index}`,
    author: { login: "developer" },
    body: triggers.includes(index) ? "@greptileai" : `note ${index}`,
    createdAt: at(index),
  }));
}

function pages(all: Comment[]) {
  return (args: readonly string[]) => {
    const cursor = args.find((arg) => arg.startsWith("cursor="))?.slice(7);
    const end = cursor === undefined ? all.length : Number(cursor.slice(3));
    const start = Math.max(0, end - 100);
    return {
      totalCount: all.length,
      pageInfo: { hasPreviousPage: start > 0, startCursor: `IC_${start}` },
      nodes: all.slice(start, end),
    };
  };
}

test("a waiting gate reads earlier comment pages once, then one page per pass", async () => {
  const value = setup(["greptile"], "", 20);
  const reads: string[] = [];
  value.deps.gh = async (args) => {
    const now = value.elapsed();
    const all = comments(now >= 80 ? 251 : 250);
    const page = pages(all)(args);
    reads.push(args.some((arg) => arg.startsWith("cursor=")) ? "earlier" : "snapshot");

    const pr = pullRequest(["greptile-apps"]);
    pr.comments = page;
    const contexts = pr.commits.nodes[0]!.commit.statusCheckRollup!.contexts.nodes;
    if (now >= 110) {
      contexts.push(greptileRun(10, 100));
      reviewed(pr, 100);
    } else contexts.push(greptileRun(10, null));

    return success(response(pr));
  };

  const result = await runRound(["gate", "18", "--wait"], value.deps);

  expect(result).toEqual({ code: 0, stdout: "greptile triage scored\ntriage\n", stderr: "" });
  expect(reads).toEqual(["snapshot", "earlier", "earlier", "snapshot", "snapshot", "snapshot"]);
});

async function read(all: Comment[], cached: Comment[] = []) {
  const page = pages(all);
  let calls = 0;
  const snapshot = await readSnapshot(
    "18",
    async (args) => {
      calls += 1;
      const pr = pullRequest([]);
      pr.comments = page(args);
      return success(response(pr));
    },
    () => {},
    [],
    cached,
  );

  return { comments: snapshot.comments, calls };
}

test("cached earlier pages give the same comments as a fresh read, each once", async () => {
  const fresh = await read(comments(250, [10, 120]));
  const after = comments(251, [10, 120, 200]);
  const cached = await read(after, fresh.comments);

  expect(fresh.calls).toBe(3);
  expect(cached.calls).toBe(1);
  expect(cached.comments.map((comment) => comment.id)).toEqual(after.map((comment) => comment.id));
  expect(cached.comments.filter((comment) => comment.body === "@greptileai")).toHaveLength(3);
});

test("a deleted earlier comment makes the reader page back again", async () => {
  const fresh = await read(comments(250, [10, 120]));
  const after = comments(251, [10, 120]).filter((comment) => comment.id !== "IC_10");
  const cached = await read(after, fresh.comments);

  expect(cached.calls).toBe(3);
  expect(cached.comments.map((comment) => comment.id)).toEqual(after.map((comment) => comment.id));
  expect(cached.comments.filter((comment) => comment.body === "@greptileai")).toHaveLength(1);
});

test("the snapshot asks for each suite's app and each comment's id and count", () => {
  const query = snapshotQuery.replace(/\s+/g, " ");

  expect(query).toContain("checkSuites(first: 100) { nodes { createdAt app { slug } } }");
  expect(query).toContain("comments(last: 100) { totalCount pageInfo");
  expect(query).toContain("nodes { id author { login } body createdAt updatedAt }");
  expect(commentsQuery).toContain("nodes { id author { login } body createdAt updatedAt }");
});

function gate(
  apps: readonly string[],
  seenAt: number | null,
  triggerAt: number | null,
  pushAt: number,
  now: number,
) {
  const pr = pullRequest(apps);
  const commit = pr.commits.nodes[0]!.commit;
  commit.checkSuites.nodes = apps.map((slug) => ({ createdAt: at(pushAt), app: { slug } }));
  if (seenAt !== null)
    pr.comments.nodes.push({
      author: { login: "macroscopeapp[bot]" },
      body: "Reviewed.",
      createdAt: at(seenAt),
    });

  if (triggerAt !== null)
    pr.comments.nodes.push({
      author: { login: "developer" },
      body: "@macroscope-app review",
      createdAt: at(triggerAt),
    });

  const declaration = readDeclarations(join(repo, "skills")).find(
    (entry) => entry.name === "macroscope",
  )!;

  return presence({ pr, comments: pr.comments.nodes, headChecks: {} }, declaration, at(now)).gate;
}

test("the start window covers only an installed reviewer never seen, or one asked by a trigger", () => {
  const installed = ["macroscopeapp"];

  expect(gate([], null, null, 0, 61)).toBe("absent");
  expect(gate(installed, null, null, 0, 179)).toBe("appear");
  expect(gate(installed, null, null, 0, 180)).toBe("no-start");
  expect(gate(installed, null, null, 1000, 1061)).toBe("no-start");
  expect(gate(installed, 20, null, 1000, 1059)).toBe("appear");
  expect(gate(installed, 20, null, 1000, 1061)).toBe("decide");
  expect(gate(installed, 20, 1000, 0, 1179)).toBe("appear");
  expect(gate(installed, 20, 1000, 0, 1180)).toBe("no-review");
  expect(gate(installed, null, 1000, 0, 1180)).toBe("no-review");
  expect(gate([], null, 1000, 0, 1061)).toBe("absent");
});

test("a full page of comments does not cut an installed reviewer's start window short", () => {
  const filler = comments(100);
  const installed = ["macroscopeapp"];
  const declaration = readDeclarations(join(repo, "skills")).find(
    (entry) => entry.name === "macroscope",
  )!;

  const read = (now: number) => {
    const pr = pullRequest(installed, filler);
    return presence({ pr, comments: filler, headChecks: {} }, declaration, at(now));
  };

  expect(read(120)).toMatchObject({ seen: true, gate: "appear" });
  expect(read(180)).toMatchObject({ seen: true, gate: "decide" });
});
