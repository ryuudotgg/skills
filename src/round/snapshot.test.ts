import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { facts } from "../../skills/greptile/reviewer.ts";
import {
  acceptanceCases,
  failure,
  fixture,
  now,
  response,
  reviewerInput,
  success,
} from "./fixtures.ts";
import { presence } from "./presence.ts";
import { runRound } from "./round.ts";
import { commentsQuery, readSnapshot } from "./snapshot.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

test("all pages feed paid and since, newest page only feeds presence and scores", async () => {
  const pr = structuredClone(acceptanceCases.find((entry) => entry.name === "absent")!.pr);
  pr.comments.pageInfo = { hasPreviousPage: true, startCursor: "123" };
  const old = {
    author: { login: "greptile-apps" },
    body: "Confidence Score: 5/5",
    createdAt: now,
    updatedAt: now,
  };

  const earlier = {
    comments: {
      pageInfo: { hasPreviousPage: false, startCursor: "0" },
      nodes: [old, { author: null, body: " @greptileai ", createdAt: now }],
    },
  };

  const calls: { args: readonly string[]; deadline: number }[] = [];
  const snapshot = await readSnapshot("18", async (args, deadline) => {
    calls.push({ args, deadline });

    return success(
      JSON.stringify({ data: { repository: { pullRequest: calls.length === 1 ? pr : earlier } } }),
    );
  });

  const input = reviewerInput(pr, { now, snapshot });

  expect(facts(input)).toMatchObject({ paid: 1, score: null });
  expect(presence(snapshot, input.declaration, now).seen).toBe(false);
  expect(snapshot.pr.comments.nodes).toHaveLength(0);
  expect(snapshot.comments).toHaveLength(2);
  expect(calls).toHaveLength(2);
  expect(calls[1]!.args).toEqual([
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    "number=18",
    "-f",
    "cursor=123",
    "-f",
    `query=${commentsQuery}`,
  ]);

  expect(calls.map((entry) => entry.deadline)).toEqual([60_000, 60_000]);
});

test("score reader queried again; no pagination when newest comments are complete", async () => {
  let calls = 0;
  await readSnapshot("18", async () => {
    calls += 1;
    return success(response(acceptanceCases[0]!.pr));
  });

  expect(calls).toBe(1);
});

for (const broken of [
  failure("partial triggers"),
  success("invalid earlier page"),
  success('{"data":null}'),
])
  test(`earlier comment page refusal ${broken.stdout || broken.stderr}`, async () => {
    const value = fixture(["greptile", "thirdbot"], ["greptile", "thirdbot"]);
    temporary.push(value.temporary);
    const pr = structuredClone(acceptanceCases[0]!.pr);
    pr.comments.pageInfo = { hasPreviousPage: true, startCursor: "old" };

    let calls = 0;
    value.deps.gh = async () => (++calls === 1 ? success(response(pr)) : broken);
    const result = await runRound(["gate", "18"], value.deps);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe(
      "greptile handback refused\nthirdbot handback refused\nhandback greptile refused, thirdbot refused\n",
    );

    expect(result.stderr).toStartWith("round: ");
    expect(calls).toBe(2);
  });

for (const cursor of [null, "same"])
  test(`malformed or repeated pagination cursor ${cursor}`, async () => {
    const pr = structuredClone(acceptanceCases[0]!.pr);
    pr.comments.pageInfo = { hasPreviousPage: true, startCursor: cursor };

    await expect(readSnapshot("18", async () => success(response(pr)))).rejects.toThrow(
      "cannot parse earlier PR comments",
    );
  });

test("earlier triggers invalidate a newer-page score", async () => {
  const pr = structuredClone(acceptanceCases.find((entry) => entry.name === "seen-push")!.pr);
  const input = reviewerInput(pr, { now });
  input.snapshot.comments = [
    { author: null, body: "@greptileai", createdAt: now },
    ...pr.comments.nodes,
  ];

  expect(facts(input)).toMatchObject({ paid: 1, score: null });
});
