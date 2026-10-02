import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { areas, suites } from "../cli.ts";
import type { CommandOutput, ReadResult } from "../round/types.ts";
import { checkManifest } from "../test/manifest.ts";
import { runCommand, suiteEnvironment } from "../test/process.ts";
import { readUsage, runRead } from "./read.ts";
import { replyUsage, runReply } from "./reply.ts";
import { resolveUsage, runResolve } from "./resolve.ts";
import {
  bodiesQuery,
  commentsQuery,
  readThreadBodies,
  readThreadComments,
  readThreads,
  replyMutation,
  resolveMutation,
  threadsQuery,
  threadSelection,
  type Dependencies,
} from "./threads.ts";

type Comment = { url: string; author: { login: string } | null; body: string };
type Thread = { id: string; isResolved: boolean; comments: Comment[] };
const repo = resolve(import.meta.dir, "../..");
const pull = "https://github.com/owner/repo/pull/18#discussion_r";
const bot = "greptile-apps";
const temporary: string[] = [];
const success = (stdout = ""): ReadResult => ({ code: 0, stdout, stderr: "" });
const failure = (stderr = ""): ReadResult => ({ code: 1, stdout: "", stderr });

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function comment(id: number, login: string | null = bot, body = ""): Comment {
  return { url: `${pull}${id}`, author: login === null ? null : { login }, body };
}

function thread(id: string, isResolved: boolean, comments: Comment[]): Thread {
  return { id, isResolved, comments };
}

function connection<Node>(
  nodes: Node[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

function threadResponse(
  threads: Thread[],
  hasNextPage = false,
  endCursor: string | null = null,
) {
  return {
    data: {
      viewer: { login: "operator" },
      repository: {
        pullRequest: {
          reviewThreads: connection(
            threads.map((entry) => ({
              id: entry.id,
              isResolved: entry.isResolved,
              comments: connection(entry.comments.map(({ url, author }) => ({ url, author }))),
            })),
            hasNextPage,
            endCursor,
          ),
        },
      },
    },
  };
}

function nodeResponse(
  comments: Comment[],
  hasNextPage = false,
  endCursor: string | null = null,
  isResolved = false,
) {
  return { data: { node: { isResolved, comments: connection(comments, hasNextPage, endCursor) } } };
}

function threadsArgs(number = "18", after?: string): string[] {
  return [
    "api",
    "graphql",
    "-F",
    "owner={owner}",
    "-F",
    "repo={repo}",
    "-F",
    `number=${number}`,
    "-F",
    "starter=false",
    ...(after ? ["-f", `after=${after}`] : []),
    "-f",
    `query=${threadsQuery}`,
  ];
}

function nodeArgs(query: string, id = "T1", cursor?: string): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `id=${id}`,
    ...(cursor ? ["-f", `cursor=${cursor}`] : []),
    "-f",
    `query=${query}`,
  ];
}

function resolveArgs(id = "T1"): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${resolveMutation}`,
    "-f",
    `id=${id}`,
    "--jq",
    ".data.resolveReviewThread.thread.isResolved",
  ];
}

function replyArgs(id = "T1"): string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${replyMutation}`,
    "-f",
    `id=${id}`,
    "-F",
    "body=@-",
    "--jq",
    ".data.addPullRequestReviewThreadReply.comment.url",
  ];
}

function fixture(names = ["greptile"]) {
  const directory = mkdtempSync(join(tmpdir(), "skills-review-"));
  temporary.push(directory);

  const root = join(directory, "skills");
  const conf = join(directory, "skills.conf");
  const body = join(directory, "body");
  mkdirSync(root);
  writeFileSync(body, "The guard runs before the write, see abc1234.\n");

  for (const name of names) {
    const path = join(root, name);
    mkdirSync(path);
    writeFileSync(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: Reviewer extension.\noptional: true\nrequires: prs\n---\n`,
    );

    const display = name === "testbot" ? "TestBot" : "ThirdBot";
    writeFileSync(
      join(path, "reviewer.conf"),
      ["greptile", "coderabbit", "macroscope"].includes(name)
        ? readFileSync(join(repo, "skills", name, "reviewer.conf"), "utf8")
        : `NAME=${display}\nLOGINS=${name} ${name}[bot]\nHANDLES=@${name}\nTRIGGER=@${name} ${name === "thirdbot" ? "go" : "review"}\nCHECK=${display}\n${name === "thirdbot" ? "SETTING_BUDGET=1 [0-9]\n" : ""}`,
    );
  }

  writeFileSync(conf, `DELIVERY=prs\nWITH=${names.join(" ")}\n`);

  const calls: { args: readonly string[]; deadline: number | undefined }[] = [];
  const inputs: (string | undefined)[] = [];
  const responses = new Map<string, ReadResult>();
  const fallback: Dependencies = {
    root,
    env: { SKILLS_CONF: conf },
    gh: async (): Promise<ReadResult> => failure("unexpected gh call\n"),
  };

  const value = {
    directory,
    root,
    conf,
    body,
    calls,
    inputs,
    responses,
    threads: [
      thread("T1", false, [comment(10), comment(11)]),
      thread("T2", true, [comment(20)]),
      thread("T3", false, [comment(30), comment(31, "developer")]),
      thread("T4", false, [comment(40, "developer"), comment(41)]),
      thread("T5", false, [comment(50), comment(51, null)]),
    ],
    posted: success(`${pull}12`),
    resolved: success("true"),
    emitted: "",
    deps: fallback,
  };

  const deps: Dependencies = {
    root,
    env: { SKILLS_CONF: conf },
    stderr: (text) => {
      value.emitted += text;
    },
    gh: async (args, deadline, input) => {
      calls.push({ args, deadline });
      inputs.push(input);

      const response = responses.get(JSON.stringify(args));
      if (response) return response;
      if (args.includes(`query=${threadsQuery}`))
        return success(JSON.stringify(threadResponse(value.threads)));

      if (args.includes(`query=${bodiesQuery}`) || args.includes(`query=${commentsQuery}`)) {
        const id = args.find((arg) => arg.startsWith("id="))?.slice(3);
        const target = value.threads.find((entry) => entry.id === id);
        return success(
          JSON.stringify(
            nodeResponse(target?.comments ?? [], false, null, target?.isResolved ?? false),
          ),
        );
      }

      if (args.includes(`query=${replyMutation}`)) return value.posted;
      if (args.includes(`query=${resolveMutation}`)) return value.resolved;

      return failure("unexpected gh call\n");
    },
  };

  value.deps = deps;

  return value;
}

function refusal(result: CommandOutput, message: string, code = 1) {
  expect(result).toEqual({ code, stdout: "", stderr: `${message}\n` });
}

function writes(value: ReturnType<typeof fixture>) {
  return value.calls.filter((call) =>
    call.args.some(
      (arg) => arg === `query=${replyMutation}` || arg === `query=${resolveMutation}`,
    ),
  );
}

function mixedFixture() {
  const value = fixture(["greptile", "testbot", "thirdbot"]);
  writeFileSync(value.conf, "DELIVERY=prs\nWITH=greptile testbot\n");
  writeFileSync(value.body, "Fixed the lookup.\n");
  value.threads = [
    thread("T1", false, [comment(10, "testbot"), comment(11)]),
    thread("T2", false, [comment(20, "testbot"), comment(21, "developer")]),
    thread("T3", false, [comment(30, "thirdbot")]),
    thread("T4", false, [comment(40, "TESTBOT[bot]"), comment(41, "Greptile-Apps[bot]")]),
    thread("T5", false, [comment(50, "testbot"), comment(51, null)]),
    thread("T6", false, [comment(60, "testbot-fan")]),
    thread("T7", false, [comment(70, "testbot"), comment(71, "testbot-fan")]),
  ];

  return value;
}

test("test-review-threads: resolve failed; resolve: output; resolve calls differ", async () => {
  const value = fixture();
  const result = await runResolve(
    ["18", ...[10, 11, 20, 30, 50].map((id) => `${pull}${id}`)],
    value.deps,
  );

  expect(result).toEqual({
    code: 0,
    stdout: `resolved ${pull}10\nresolved ${pull}11\nalready-resolved ${pull}20\nleft-open ${pull}30 reply-from=developer\nleft-open ${pull}50 reply-from=ghost\n`,
    stderr: "",
  });

  expect(value.calls).toEqual([
    { args: threadsArgs(), deadline: 60_000 },
    { args: nodeArgs(commentsQuery), deadline: 60_000 },
    { args: resolveArgs(), deadline: undefined },
  ]);
});

for (const change of ["human reply", "resolved"] as const)
  test(`resolve rechecks a thread after a concurrent ${change}`, async () => {
    const value = fixture();
    const original = value.deps.gh;
    value.deps.gh = async (args, deadline, input) => {
      const response = await original(args, deadline, input);

      if (args.includes(`query=${threadsQuery}`))
        if (change === "resolved") value.threads[0]!.isResolved = true;
        else value.threads[0]!.comments.push(comment(12, "developer"));

      return response;
    };

    expect(await runResolve(["18", `${pull}10`, `${pull}11`], value.deps)).toEqual({
      code: 0,
      stdout: [10, 11].map((id) => change === "resolved"
        ? `already-resolved ${pull}${id}\n`
        : `left-open ${pull}${id} reply-from=developer\n`).join(""),
      stderr: "",
    });

    expect(value.calls).toEqual([
      { args: threadsArgs(), deadline: 60_000 },
      { args: nodeArgs(commentsQuery), deadline: 60_000 },
    ]);

    expect(writes(value)).toEqual([]);
  });

test("concurrent reply processes post exactly one reply under the thread lock", async () => {
  const value = fixture();
  const statePath = join(value.directory, "state.json");
  const logPath = join(value.directory, "calls.jsonl");
  const executable = join(value.directory, "gh");

  writeFileSync(statePath, JSON.stringify({ threads: [value.threads[0]], next: 12 }));
  writeFileSync(logPath, "");
  writeFileSync(executable, `#!${process.execPath}
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const queries = ${JSON.stringify({ threadsQuery, commentsQuery, bodiesQuery, replyMutation, resolveMutation })};
const statePath = ${JSON.stringify(statePath)};
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(args) + "\\n");
const state = JSON.parse(readFileSync(statePath, "utf8"));
const id = args.find((arg) => arg.startsWith("id="))?.slice(3);
const thread = state.threads.find((entry) => entry.id === id);
const connection = (nodes) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

if (args.includes("query=" + queries.threadsQuery)) {
  console.log(JSON.stringify({ data: {
    viewer: { login: "operator" },
    repository: { pullRequest: { reviewThreads: connection(state.threads.map((entry) => ({
      id: entry.id,
      isResolved: entry.isResolved,
      comments: connection(entry.comments.map(({ url, author }) => ({ url, author }))),
    }))) } },
  } }));
} else if (args.includes("query=" + queries.bodiesQuery) || args.includes("query=" + queries.commentsQuery)) {
  if (args.includes("query=" + queries.bodiesQuery)) await Bun.sleep(300);

  console.log(JSON.stringify({ data: { node: {
    isResolved: thread.isResolved,
    comments: connection(thread.comments),
  } } }));
} else if (args.includes("query=" + queries.replyMutation)) {
  const body = await Bun.stdin.text();
  const current = JSON.parse(readFileSync(statePath, "utf8"));
  const target = current.threads.find((entry) => entry.id === id);
  const url = ${JSON.stringify(pull)} + current.next++;
  target.comments.push({ url, body, author: { login: "operator" } });
  writeFileSync(statePath, JSON.stringify(current));
  console.log(url);
} else if (args.includes("query=" + queries.resolveMutation)) {
  thread.isResolved = true;
  writeFileSync(statePath, JSON.stringify(state));
  console.log("true");
} else {
  process.exit(1);
}
`, { mode: 0o755 });

  const env = {
    ...suiteEnvironment(),
    PATH: `${value.directory}:${process.env.PATH}`,
    SKILLS_CONF: value.conf,
    TMPDIR: value.directory,
  };

  const argv = [join(repo, "skills/playbook/bin/skills"), "review", "reply", "18", `${pull}10`, value.body];
  const results = await Promise.all([runCommand(argv, { cwd: repo, env }), runCommand(argv, { cwd: repo, env })]);
  for (const result of results)
    expect(result).toEqual({
      code: 0,
      stdout: `replied ${pull}12\nresolved ${pull}10\n`,
      stderr: "",
      timedOut: false,
    });

  const calls: string[][] = readFileSync(logPath, "utf8").trimEnd().split("\n").map((line) => JSON.parse(line));
  expect(calls.filter((args) => args.includes(`query=${replyMutation}`))).toHaveLength(1);
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  expect(state.threads[0].comments).toHaveLength(3);
  expect(state.threads[0].isResolved).toBe(true);
});

for (const [id, reason] of [
  [41, `resolve: ${pull}41 is in a thread Greptile did not start`],
  [99, `resolve: ${pull}99 is not in a review thread on PR 18`],
] as const)
  test(`test-review-threads: ${reason}; resolve wrote before refusing`, async () => {
    const value = fixture();
    refusal(await runResolve(["18", `${pull}10`, `${pull}${id}`], value.deps), reason);
    expect(writes(value)).toEqual([]);
  });

for (const [response, reason] of [
  [success("false"), `resolve: ${pull}10 did not resolve`],
  [failure(), `resolve: gh failed resolving ${pull}10`],
] as const)
  test(`test-review-threads: ${reason}`, async () => {
    const value = fixture();
    value.resolved = response;
    refusal(await runResolve(["18", `${pull}10`], value.deps), reason);
  });

for (const [response, reason] of [
  [success('{"data": null}'), "resolve: cannot read review threads"],
  [{ ...failure(), stdout: "partial response" }, "resolve: gh failed reading review threads"],
] as const)
  test(`test-review-threads: ${reason}`, async () => {
    const value = fixture();
    value.responses.set(JSON.stringify(threadsArgs()), response);
    refusal(await runResolve(["18", `${pull}10`], value.deps), reason);
    expect(writes(value)).toEqual([]);
  });

test("test-review-threads: reply failed; reply: output; reply calls differ", async () => {
  const value = fixture();
  value.threads.pop();

  expect(await runReply(["18", `${pull}11`, value.body], value.deps)).toEqual({
    code: 0,
    stdout: `replied ${pull}12\nresolved ${pull}11\n`,
    stderr: "",
  });

  expect(value.calls).toEqual([
    { args: threadsArgs(), deadline: 60_000 },
    { args: nodeArgs(bodiesQuery), deadline: 60_000 },
    { args: replyArgs(), deadline: undefined },
    { args: resolveArgs(), deadline: undefined },
  ]);

  expect(value.inputs[2]).toBe(readFileSync(value.body, "utf8"));
});

test("reply posts the body it validated, not the file as it reads later", async () => {
  const value = fixture();
  const validated = readFileSync(value.body, "utf8");
  const original = value.deps.gh;
  value.deps.gh = async (args, deadline, input) => {
    if (args.includes(`query=${threadsQuery}`))
      writeFileSync(value.body, "Fixed, @greptileai take another look.\n");

    return original(args, deadline, input);
  };

  expect((await runReply(["18", `${pull}10`, value.body], value.deps)).code).toBe(0);

  const post = value.calls.findIndex((call) => call.args.includes(`query=${replyMutation}`));
  expect(value.inputs[post]).toBe(validated);
});

for (const change of ["resolved", "human reply", "prior reply"] as const)
  test(`reply decides from its fresh read after a concurrent ${change}`, async () => {
    const value = fixture();
    const original = value.deps.gh;
    value.deps.gh = async (args, deadline, input) => {
      const result = await original(args, deadline, input);

      if (args.includes(`query=${threadsQuery}`))
        if (change === "resolved") value.threads[0]!.isResolved = true;
        else value.threads[0]!.comments.push(change === "human reply"
          ? comment(12, "developer")
          : comment(12, "operator", readFileSync(value.body, "utf8")));

      return result;
    };

    const result = await runReply(["18", `${pull}10`, value.body], value.deps);
    if (change === "prior reply") {
      expect(result).toEqual({ code: 0, stdout: `replied ${pull}12\nresolved ${pull}10\n`, stderr: "" });
      expect(writes(value).map((call) => call.args)).toEqual([resolveArgs()]);
    } else {
      refusal(result, change === "resolved"
        ? `reply: ${pull}10 is in a resolved thread`
        : `reply: ${pull}10 is not in a thread only Greptile has written in`);

      expect(writes(value)).toEqual([]);
    }

    expect(value.calls[1]).toEqual({ args: nodeArgs(bodiesQuery), deadline: 60_000 });
  });

for (const [id, reason] of [
  [20, `reply: ${pull}20 is in a resolved thread`],
  [30, `reply: ${pull}30 is not in a thread only Greptile has written in`],
  [41, `reply: ${pull}41 is not in a thread only Greptile has written in`],
  [99, `reply: ${pull}99 is not in a review thread on PR 18`],
] as const)
  test(`test-review-threads: ${reason}; reply wrote before refusing`, async () => {
    const value = fixture();
    value.threads.pop();
    refusal(await runReply(["18", `${pull}${id}`, value.body], value.deps), reason);
    expect(writes(value)).toEqual([]);
  });

for (const [body, reason] of [
  [
    "Fixed, @GreptileAI take another look.\n",
    "reply: the reply body mentions @greptile, which summons Greptile and may cost a review",
  ],
  [" \n\n", "reply: the reply body is empty"],
] as const)
  test(`test-review-threads: ${reason}; reply called gh on a bad body or usage`, async () => {
    const value = fixture();
    writeFileSync(value.body, body);
    refusal(await runReply(["18", `${pull}10`, value.body], value.deps), reason);
    expect(value.calls).toEqual([]);
  });

for (const variant of ["missing file", "missing body", "wrong PR", "non numeric PR"])
  test(`test-review-threads: usage: skills review reply (${variant}); reply called gh on a bad body or usage`, async () => {
    const value = fixture();
    const args =
      variant === "missing file"
        ? ["18", `${pull}10`, join(value.directory, "missing")]
        : variant === "missing body"
          ? ["18", `${pull}10`]
          : variant === "wrong PR"
            ? ["18", "https://github.com/owner/repo/pull/19#discussion_r10", value.body]
            : ["x", `${pull}10`, value.body];

    refusal(await runReply(args, value.deps), replyUsage, 2);
    expect(value.calls).toEqual([]);
  });

test("test-review-threads: reply: gh failed replying", async () => {
  const value = fixture();
  value.posted = failure();
  refusal(
    await runReply(["18", `${pull}10`, value.body], value.deps),
    `reply: gh failed replying to ${pull}10`,
  );

  expect(writes(value)).toHaveLength(1);
});

test("test-review-threads: reply hid a failed resolve", async () => {
  const value = fixture();
  value.resolved = success("false");
  expect(await runReply(["18", `${pull}10`, value.body], value.deps)).toEqual({
    code: 1,
    stdout: `replied ${pull}12\n`,
    stderr: `reply: ${pull}10 did not resolve\n`,
  });
});

for (const config of ["DELIVERY=prs\n", "DELIVERY=hands-off\nWITH=greptile\n"])
  test(`test-review-threads: resolve: greptile is not active in prs mode (${config.trim()}); resolve or reply called gh without greptile active`, async () => {
    const value = fixture();
    writeFileSync(value.conf, config);
    refusal(
      await runResolve(["18", `${pull}10`], value.deps),
      "resolve: greptile is not active in prs mode",
    );

    if (config.includes("hands-off"))
      refusal(
        await runReply(["18", `${pull}10`, value.body], value.deps),
        "reply: greptile is not active in prs mode",
      );

    expect(value.calls).toEqual([]);
  });

for (const args of [
  ["18"],
  ["x", `${pull}10`],
  ["18", "https://github.com/owner/repo/pull/19#discussion_r10"],
  ["18", `${pull}1x`],
  ["18", pull],
])
  test(`test-review-threads: usage: skills review resolve (${args.join(" ")}); resolve or reply called gh without greptile active`, async () => {
    const value = fixture();
    writeFileSync(value.conf, "DELIVERY=hands-off\nWITH=greptile\n");
    refusal(await runResolve(args, value.deps), resolveUsage, 2);
    expect(value.calls).toEqual([]);
  });

test("test-reviewers: mixed reviewer reply failed; reply: output", async () => {
  const value = mixedFixture();
  expect(await runReply(["18", `${pull}10`, value.body], value.deps)).toEqual({
    code: 0,
    stdout: `replied ${pull}12\nresolved ${pull}10\n`,
    stderr: "",
  });
});

for (const id of [20, 30, 50, 60, 70])
  test(`test-reviewers: ${pull}${id} is not in a thread only Greptile or TestBot has written in; reply wrote before refusing`, async () => {
    const value = mixedFixture();
    refusal(
      await runReply(["18", `${pull}${id}`, value.body], value.deps),
      `reply: ${pull}${id} is not in a thread only Greptile or TestBot has written in`,
    );

    expect(writes(value)).toEqual([]);
  });

for (const body of [
  "This lands in the Hooks batch (plan 090).",
  "See plan#29.",
  "Plans 89 and 90 cover it.",
  "It lands in the batch plan\n090 covers.",
])
  test(`test-reviewers: names a plan id (${JSON.stringify(body)}); plan id called gh`, async () => {
    const value = mixedFixture();
    writeFileSync(value.body, `${body}\n`);
    refusal(
      await runReply(["18", `${pull}10`, value.body], value.deps),
      "reply: the reply body names a plan id, which exists only on this machine",
    );

    expect(value.calls).toEqual([]);
  });

test("test-reviewers: mentions @thirdbot, which summons ThirdBot; mention called gh", async () => {
  const value = mixedFixture();
  writeFileSync(value.body, "Fixed, @ThirdBot take a look.\n");
  refusal(
    await runReply(["18", `${pull}10`, value.body], value.deps),
    "reply: the reply body mentions @thirdbot, which summons ThirdBot and may cost a review",
  );

  expect(value.calls).toEqual([]);
});

test("test-reviewers: resolve failed; resolve: output; resolve closed a human thread", async () => {
  const value = mixedFixture();
  expect(
    await runResolve(["18", ...[10, 20, 40, 50, 70].map((id) => `${pull}${id}`)], value.deps),
  ).toEqual({
    code: 0,
    stdout: `resolved ${pull}10\nleft-open ${pull}20 reply-from=developer\nresolved ${pull}40\nleft-open ${pull}50 reply-from=ghost\nleft-open ${pull}70 reply-from=testbot-fan\n`,
    stderr: "",
  });

  expect(writes(value).map((call) => call.args)).toEqual([resolveArgs(), resolveArgs("T4")]);
});

for (const id of [30, 60])
  test(`test-reviewers: Greptile or TestBot did not start (${id}); resolve wrote before refusing`, async () => {
    const value = mixedFixture();
    refusal(
      await runResolve(["18", `${pull}${id}`], value.deps),
      `resolve: ${pull}${id} is in a thread Greptile or TestBot did not start`,
    );

    expect(writes(value)).toEqual([]);
  });

for (const verb of ["reply", "resolve"] as const) {
  const run = verb === "reply" ? runReply : runResolve;
  test(`test-reviewers: ${verb}: cannot read reviewer declarations; unreadable declarations called gh`, async () => {
    const value = mixedFixture();
    const path = join(value.root, "thirdbot/reviewer.conf");
    writeFileSync(path, readFileSync(path, "utf8").replace(/^TRIGGER=.*\n/m, ""));
    const result = await run(
      ["18", `${pull}10`, ...(verb === "reply" ? [value.body] : [])],
      value.deps,
    );

    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(
      `reviewers: ${path}: missing TRIGGER\n${verb}: cannot read reviewer declarations\n`,
    );

    expect(value.emitted).toBe(result.stderr);
    expect(value.calls).toEqual([]);
  });

  test(`test-reviewers: ${verb}: greptile is not active in prs mode; missing inactive reviewer: testbot; missing inactive reviewer: thirdbot; inactive reviewers called gh`, async () => {
    const value = mixedFixture();
    writeFileSync(value.conf, "DELIVERY=hands-off\nWITH=greptile testbot\n");
    refusal(
      await run(["18", `${pull}10`, ...(verb === "reply" ? [value.body] : [])], value.deps),
      `${verb}: greptile is not active in prs mode\n${verb}: testbot is not active in prs mode\n${verb}: thirdbot is not active in prs mode`,
    );

    expect(value.calls).toEqual([]);
  });

  test(`test-reviewers: ${verb}: no reviewer is installed; missing reviewers called gh`, async () => {
    const value = mixedFixture();
    for (const name of ["greptile", "testbot", "thirdbot"])
      rmSync(join(value.root, name, "reviewer.conf"));

    refusal(
      await run(["18", `${pull}10`, ...(verb === "reply" ? [value.body] : [])], value.deps),
      `${verb}: no reviewer is installed`,
    );

    expect(value.calls).toEqual([]);
  });
}

test("test-reviewers: coderabbit reply failed; coderabbit reply: output; coderabbit reply did not post; coderabbit reply did not resolve", async () => {
  const value = fixture(["coderabbit"]);
  writeFileSync(value.body, "Fixed the lookup.\n");
  value.threads = [
    thread("T1", false, [comment(10, "coderabbitai"), comment(11, "coderabbitai[bot]")]),
    thread("T2", false, [comment(20, "coderabbitai"), comment(21, "developer")]),
  ];

  expect(await runReply(["18", `${pull}10`, value.body], value.deps)).toEqual({
    code: 0,
    stdout: `replied ${pull}12\nresolved ${pull}10\n`,
    stderr: "",
  });

  expect(writes(value).map((call) => call.args)).toEqual([
    replyArgs(),
    resolveArgs(),
  ]);

  value.calls.length = 0;
  refusal(
    await runReply(["18", `${pull}20`, value.body], value.deps),
    `reply: ${pull}20 is not in a thread only CodeRabbit has written in`,
  );

  expect(writes(value)).toEqual([]);
});

test("test-reviewers: CodeRabbit human refusal; coderabbit human thread was changed", async () => {
  const value = fixture(["coderabbit"]);
  writeFileSync(value.body, "Fixed the lookup.\n");
  value.threads = [
    thread("T2", false, [comment(20, "coderabbitai"), comment(21, "developer")]),
  ];

  refusal(
    await runReply(["18", `${pull}20`, value.body], value.deps),
    `reply: ${pull}20 is not in a thread only CodeRabbit has written in`,
  );

  expect(writes(value)).toEqual([]);
});

function readArgs(number: string): string[][] {
  return [
    [
      "api",
      `repos/{owner}/{repo}/pulls/${number}/comments`,
      "--paginate",
      "--jq",
      '.[] | "### \\(.path):\\(.line // .original_line // "file") by \\(.user.login)\\n\\(.html_url)\\n\\(.body)\\n"',
    ],
    ["pr", "view", number, "--json", "body,reviews,comments"],
  ];
}

function reviewFixture() {
  const value = fixture(["greptile", "coderabbit", "macroscope"]);
  writeFileSync(value.conf, "DELIVERY=prs\n");

  const texts = [
    "### a:3 by one\nhttps://example/a\nfirst\n\n### b:file by two\nhttps://example/b\nsecond\n",
    JSON.stringify({
      body: "intro\nComments Outside Diff\nThis is outside.\n",
      reviews: [],
      comments: [{ author: { login: "three" }, url: "https://example/c", body: "reply" }],
    }),
  ];

  for (const [index, args] of readArgs("12").entries())
    value.responses.set(JSON.stringify(args), success(texts[index]));

  return value;
}

test("test-review-round: review headers out of order; missing empty reviews; missing outside source; missing outside block; review calls differ", async () => {
  const value = reviewFixture();
  const expected =
    "== inline comments\n### a:3 by one\nhttps://example/a\nfirst\n\n### b:file by two\nhttps://example/b\nsecond\n== PR body\nintro\nComments Outside Diff\nThis is outside.\n== reviews\nempty\n== PR comments\n### comment by three\nhttps://example/c\nreply\n== comments outside diff\nfound in: PR body\nComments Outside Diff\nThis is outside.\n";

  expect(await runRead(["12"], value.deps)).toEqual({ code: 0, stdout: expected, stderr: "" });
  expect(value.calls).toEqual(readArgs("12").map((args) => ({ args, deadline: 60_000 })));
});

test("test-review-round: missing review outside source; missing first outside finding; missing second outside finding; later review leaked into outside block", async () => {
  const value = reviewFixture();
  const reviews =
    "### review by coderabbitai, COMMENTED\nActionable comments posted: 0\n<summary>⚠️ Outside diff range comments (2)</summary>\nfirst outside finding\nsecond outside finding\n\n### review by coderabbitai, COMMENTED\nlater review without a block\n";

  value.responses.set(JSON.stringify(readArgs("13")[0]), success());
  value.responses.set(JSON.stringify(readArgs("13")[1]), success(JSON.stringify({
    body: "",
    reviews: [
      { author: { login: "coderabbitai" }, state: "COMMENTED", body: "Actionable comments posted: 0\n<summary>⚠️ Outside diff range comments (2)</summary>\nfirst outside finding\nsecond outside finding" },
      { author: { login: "coderabbitai" }, state: "COMMENTED", body: "later review without a block" },
    ],
    comments: [],
  })));

  const result = await runRead(["13"], value.deps);
  expect(result).toEqual({
    code: 0,
    stdout: `== inline comments\nempty\n== PR body\nempty\n== reviews\n${reviews.trimEnd()}\n== PR comments\nempty\n== comments outside diff\nfound in: reviews\n<summary>⚠️ Outside diff range comments (2)</summary>\nfirst outside finding\nsecond outside finding\n\n`,
    stderr: "",
  });
});

test("test-review-round: review-read: gh failed reading PR body, reviews and comments", async () => {
  const value = reviewFixture();
  value.responses.set(JSON.stringify(readArgs("12")[1]), failure());
  refusal(await runRead(["12"], value.deps), "review-read: gh failed reading PR body, reviews and comments");
  expect(value.calls).toEqual(
    readArgs("12")
      .slice(0, 2)
      .map((args) => ({ args, deadline: 60_000 })),
  );
});

test("test-review-round: non numeric review number succeeded; non numeric did not use usage", async () => {
  const value = reviewFixture();
  refusal(await runRead(["x"], value.deps), readUsage, 2);
  expect(value.calls).toEqual([]);
});

test("review skips starter bodies; participant queries contain no bodies; first body page omits a cursor", async () => {
  const value = fixture();
  expect(threadsQuery).toContain("starter: comments(first: 1) @include(if: $starter)");
  expect(threadsQuery).toContain("comments(first: 100) @skip(if: $starter)");
  expect(threadSelection.split("comments(first: 100)")[1]).not.toMatch(/\bbody\b/);

  await readThreads("18", value.deps.gh);
  expect(value.calls[0]?.args).toContain("starter=false");

  value.calls.length = 0;
  expect(commentsQuery).not.toMatch(/\bbody\b/);
  expect(bodiesQuery).toContain("nodes { url body author { login } }");
  expect(bodiesQuery.split("{")[0]).toBe("query($id: ID!, $cursor: String) ");

  await readThreadBodies("T1", value.deps.gh);
  expect(value.calls).toEqual([{ args: nodeArgs(bodiesQuery), deadline: 60_000 }]);
});

for (const query of [commentsQuery, bodiesQuery])
  for (const paged of [false, true])
    for (const isResolved of [undefined, null, "false"])
      test(`thread recheck fails closed on isResolved=${String(isResolved)}, bodies=${query === bodiesQuery}, paged=${paged}`, async () => {
        const value = fixture();
        const invalid = nodeResponse([comment(10)]);
        const response = { data: { node: { ...invalid.data.node, isResolved } } };

        if (paged)
          value.responses.set(JSON.stringify(nodeArgs(query)), success(JSON.stringify(nodeResponse([comment(10)], true, "next"))));

        value.responses.set(JSON.stringify(nodeArgs(query, "T1", paged ? "next" : undefined)), success(JSON.stringify(response)));
        const reader = query === bodiesQuery ? readThreadBodies : readThreadComments;

        await expect(reader("T1", value.deps.gh)).rejects.toThrow("cannot read review threads");
        expect(writes(value)).toEqual([]);
      });

test("resolve recheck pages comments without bodies and leaves a late human reply open", async () => {
  const value = fixture();
  value.responses.set(JSON.stringify(nodeArgs(commentsQuery)), success(JSON.stringify(nodeResponse([comment(10)], true, "next"))));
  value.responses.set(JSON.stringify(nodeArgs(commentsQuery, "T1", "next")), success(JSON.stringify(nodeResponse([comment(12, "developer"), comment(13, null)]))));

  expect(await runResolve(["18", `${pull}10`], value.deps)).toEqual({
    code: 0,
    stdout: `left-open ${pull}10 reply-from=developer,ghost\n`,
    stderr: "",
  });

  expect(writes(value)).toEqual([]);
  expect(value.calls.map((call) => call.args)).toEqual([
    threadsArgs(), nodeArgs(commentsQuery), nodeArgs(commentsQuery, "T1", "next"),
  ]);
});

for (const verb of ["reply", "resolve"] as const)
  test(`${verb}: the 101st comment is human, no mutation, reply-from=developer`, async () => {
    const value = fixture();
    value.threads = [
      thread(
        "T1",
        false,
        Array.from({ length: 100 }, (_, index) => comment(index + 10)),
      ),
    ];

    const response = threadResponse(value.threads);
    response.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.pageInfo = {
      hasNextPage: true,
      endCursor: "comments-100",
    };

    value.responses.set(JSON.stringify(threadsArgs()), success(JSON.stringify(response)));
    value.responses.set(
      JSON.stringify(nodeArgs(commentsQuery, "T1", "comments-100")),
      success(JSON.stringify(nodeResponse([comment(110, "developer")]))),
    );

    value.threads[0]!.comments.push(comment(110, "developer"));

    const result =
      verb === "reply"
        ? await runReply(["18", `${pull}10`, value.body], value.deps)
        : await runResolve(["18", `${pull}10`], value.deps);

    if (verb === "reply")
      refusal(result, `reply: ${pull}10 is not in a thread only Greptile has written in`);
    else
      expect(result).toEqual({
        code: 0,
        stdout: `left-open ${pull}10 reply-from=developer\n`,
        stderr: "",
      });

    expect(value.calls).toEqual([
      { args: threadsArgs(), deadline: 60_000 },
      { args: nodeArgs(commentsQuery, "T1", "comments-100"), deadline: 60_000 },
      ...(verb === "reply" ? [{ args: nodeArgs(bodiesQuery), deadline: 60_000 }] : []),
    ]);
  });

test("more than 100 threads page; a target on the second page resolves", async () => {
  const value = fixture();
  const first = Array.from({ length: 100 }, (_, index) =>
    thread(`T${index}`, false, [comment(index)]),
  );

  value.responses.set(
    JSON.stringify(threadsArgs()),
    success(JSON.stringify(threadResponse(first, true, "threads-100"))),
  );

  value.responses.set(
    JSON.stringify(threadsArgs("18", "threads-100")),
    success(JSON.stringify(threadResponse([thread("T100", false, [comment(100)])]))),
  );

  value.threads.push(thread("T100", false, [comment(100)]));

  expect(await runResolve(["18", `${pull}100`], value.deps)).toEqual({
    code: 0,
    stdout: `resolved ${pull}100\n`,
    stderr: "",
  });

  expect(value.calls).toEqual([
    { args: threadsArgs(), deadline: 60_000 },
    { args: threadsArgs("18", "threads-100"), deadline: 60_000 },
    { args: nodeArgs(commentsQuery, "T100"), deadline: 60_000 },
    { args: resolveArgs("T100"), deadline: undefined },
  ]);
});

test("reader retains all thread comments and viewer, with ghost for deleted authors", async () => {
  const value = fixture();
  const result = await readThreads("18", value.deps.gh);
  expect(result.viewer).toBe("operator");
  expect(result.threads).toEqual(
    value.threads.map((entry) => ({
      id: entry.id,
      isResolved: entry.isResolved,
      starter: null,
      comments: entry.comments.map((node) => ({
        url: node.url,
        login: node.author?.login ?? "ghost",
      })),
    })),
  );
});

for (const missing of [true, false])
  test(`thread pagination rejects ${missing ? "missing" : "repeated"} cursors before writes`, async () => {
    const value = fixture();
    const response = success(
      JSON.stringify(threadResponse(value.threads, true, missing ? null : "same")),
    );

    value.responses.set(JSON.stringify(threadsArgs()), response);
    value.responses.set(JSON.stringify(threadsArgs("18", "same")), response);
    refusal(
      await runResolve(["18", `${pull}10`], value.deps),
      "resolve: cannot read review threads",
    );

    expect(writes(value)).toEqual([]);
  });

for (const missing of [true, false])
  test(`comment pagination rejects ${missing ? "missing" : "repeated"} cursors before writes`, async () => {
    const value = fixture();
    const response = threadResponse(value.threads);
    response.data.repository.pullRequest.reviewThreads.nodes[0]!.comments.pageInfo = {
      hasNextPage: true,
      endCursor: missing ? null : "same",
    };

    value.responses.set(JSON.stringify(threadsArgs()), success(JSON.stringify(response)));
    value.responses.set(
      JSON.stringify(nodeArgs(commentsQuery, "T1", "same")),
      success(JSON.stringify(nodeResponse([comment(110)], true, "same"))),
    );

    refusal(
      await runResolve(["18", `${pull}10`], value.deps),
      "resolve: cannot read review threads",
    );

    expect(writes(value)).toEqual([]);
  });

for (const response of [
  "not JSON",
  "{}",
  '{"data":null}',
  JSON.stringify({ ...threadResponse([]), errors: [{ message: "partial" }] }),
  JSON.stringify({ data: { ...threadResponse([]).data, viewer: null } }),
  JSON.stringify({
    data: {
      viewer: { login: "operator" },
      repository: { pullRequest: { reviewThreads: { nodes: [] } } },
    },
  }),
  JSON.stringify({
    data: {
      viewer: { login: "operator" },
      repository: {
        pullRequest: {
          reviewThreads: connection([
            { id: "T1", isResolved: "false", comments: connection([]) },
          ]),
        },
      },
    },
  }),
  JSON.stringify({
    data: {
      viewer: { login: "operator" },
      repository: {
        pullRequest: {
          reviewThreads: connection([
            {
              id: "T1",
              isResolved: false,
              comments: connection([{ url: `${pull}10`, author: {} }]),
            },
          ]),
        },
      },
    },
  }),
])
  test(`malformed thread page fails closed: ${response}`, async () => {
    const value = fixture();
    value.responses.set(JSON.stringify(threadsArgs()), success(response));
    refusal(
      await runReply(["18", `${pull}10`, value.body], value.deps),
      "reply: cannot read review threads",
    );

    expect(writes(value)).toEqual([]);
  });

test("reply whose resolve fails once resolves on rerun, exactly one reply across both runs", async () => {
  const value = fixture();
  const original = value.deps.gh;
  let resolves = 0;
  value.deps.gh = async (args, deadline) => {
    const result = await original(args, deadline);

    if (args.includes(`query=${replyMutation}`))
      value.threads[0]!.comments.push(
        comment(12, "operator", readFileSync(value.body, "utf8")),
      );

    if (args.includes(`query=${resolveMutation}`)) {
      resolves += 1;
      if (resolves === 1) return failure();
      value.threads[0]!.isResolved = true;
    }

    return result;
  };

  expect(await runReply(["18", `${pull}10`, value.body], value.deps)).toEqual({
    code: 1,
    stdout: `replied ${pull}12\n`,
    stderr: `reply: gh failed resolving ${pull}10\n`,
  });

  expect(await runReply(["18", `${pull}10`, value.body], value.deps)).toEqual({
    code: 0,
    stdout: `replied ${pull}12\nresolved ${pull}10\n`,
    stderr: "",
  });

  expect(
    writes(value).filter((call) => call.args.includes(`query=${replyMutation}`)),
  ).toHaveLength(1);

  expect(
    writes(value).filter((call) => call.args.includes(`query=${resolveMutation}`)),
  ).toHaveLength(2);

  expect(writes(value).every((call) => call.deadline === undefined)).toBe(true);

  const before = writes(value).length;
  expect((await runReply(["18", `${pull}10`, value.body], value.deps)).stdout).toBe(
    `replied ${pull}12\nresolved ${pull}10\n`,
  );

  expect(writes(value)).toHaveLength(before);
});

test("a lost reply acknowledgement recovers from remote state without reposting", async () => {
  const value = fixture();
  const original = value.deps.gh;
  value.deps.gh = async (args, deadline) => {
    const result = await original(args, deadline);

    if (args.includes(`query=${replyMutation}`)) {
      value.threads[0]!.comments.push(
        comment(12, "operator", readFileSync(value.body, "utf8")),
      );

      return failure();
    }

    return result;
  };

  refusal(
    await runReply(["18", `${pull}10`, value.body], value.deps),
    `reply: gh failed replying to ${pull}10`,
  );

  expect((await runReply(["18", `${pull}10`, value.body], value.deps)).stdout).toBe(
    `replied ${pull}12\nresolved ${pull}10\n`,
  );

  expect(
    writes(value).filter((call) => call.args.includes(`query=${replyMutation}`)),
  ).toHaveLength(1);
});

for (const resolved of [false, true])
  test(`matching viewer reply tolerates reviewer comments after it, normalises CRLF and trim, resolved=${resolved}`, async () => {
    const value = fixture();
    writeFileSync(value.body, "  Fixed the guard.\r\nSee abc1234.\r\n");
    value.threads = [
      thread("T1", resolved, [
        comment(10),
        comment(12, "operator", "Fixed the guard.\nSee abc1234.\n"),
        comment(13),
      ]),
    ];

    expect(await runReply(["18", `${pull}10`, value.body], value.deps)).toEqual({
      code: 0,
      stdout: `replied ${pull}12\nresolved ${pull}10\n`,
      stderr: "",
    });

    expect(writes(value).map((call) => call.args)).toEqual(resolved ? [] : [resolveArgs()]);
    expect(value.calls.filter((call) => call.args.includes(`query=${bodiesQuery}`))).toEqual([
      { args: nodeArgs(bodiesQuery), deadline: 60_000 },
    ]);
  });

test("target bodies paginate, prior viewer reply on the 101st comment recovers", async () => {
  const value = fixture();
  const comments = Array.from({ length: 100 }, (_, index) => comment(index + 10));
  value.threads = [
    thread("T1", false, [
      ...comments,
      comment(110, "operator", readFileSync(value.body, "utf8")),
    ]),
  ];

  value.responses.set(
    JSON.stringify(nodeArgs(bodiesQuery)),
    success(JSON.stringify(nodeResponse(comments, true, "bodies-100"))),
  );

  value.responses.set(
    JSON.stringify(nodeArgs(bodiesQuery, "T1", "bodies-100")),
    success(JSON.stringify(nodeResponse([value.threads[0]!.comments[100]!]))),
  );

  expect((await runReply(["18", `${pull}10`, value.body], value.deps)).stdout).toBe(
    `replied ${pull}110\nresolved ${pull}10\n`,
  );

  expect(writes(value).map((call) => call.args)).toEqual([resolveArgs()]);
  expect(value.calls.filter((call) => call.args.includes(`query=${bodiesQuery}`))).toEqual([
    { args: nodeArgs(bodiesQuery), deadline: 60_000 },
    { args: nodeArgs(bodiesQuery, "T1", "bodies-100"), deadline: 60_000 },
  ]);
});

test("body pagination rejects repeated cursors without writes", async () => {
  const value = fixture();
  value.threads[0]!.comments.push(comment(12, "operator", readFileSync(value.body, "utf8")));
  const response = success(
    JSON.stringify(nodeResponse(value.threads[0]!.comments, true, "same")),
  );

  value.responses.set(JSON.stringify(nodeArgs(bodiesQuery)), response);
  value.responses.set(JSON.stringify(nodeArgs(bodiesQuery, "T1", "same")), response);
  refusal(
    await runReply(["18", `${pull}10`, value.body], value.deps),
    "reply: cannot read review threads",
  );

  expect(writes(value)).toEqual([]);
});

for (const scenario of [
  "human before",
  "human after",
  "viewer first",
  "two viewer replies",
  "mismatched viewer body",
])
  test(`reply recovery refuses ${scenario}`, async () => {
    const value = fixture();
    const body = readFileSync(value.body, "utf8");
    const prior = comment(
      12,
      "operator",
      scenario === "mismatched viewer body" ? "Different reply." : body,
    );

    value.threads = [
      thread(
        "T1",
        false,
        scenario === "human before"
          ? [comment(10), comment(11, "developer"), prior]
          : scenario === "human after"
            ? [comment(10), prior, comment(13, "developer")]
            : scenario === "viewer first"
              ? [prior, comment(13)]
              : scenario === "two viewer replies"
                ? [comment(10), comment(11, "operator", body), prior]
                : [comment(10), prior, comment(13)],
      ),
    ];

    refusal(
      await runReply(
        ["18", scenario === "viewer first" ? prior.url : `${pull}10`, value.body],
        value.deps,
      ),
      scenario === "mismatched viewer body"
        ? `reply: ${pull}10 already holds a reply from operator at ${pull}12`
        : `reply: ${scenario === "viewer first" ? prior.url : `${pull}10`} is not in a thread only Greptile has written in`,
    );

    expect(writes(value)).toEqual([]);
  });

test("resolve never reads bodies, viewer replies stay left-open", async () => {
  const value = fixture();
  value.threads[0]!.comments.push(comment(12, "operator", readFileSync(value.body, "utf8")));
  expect(await runResolve(["18", `${pull}10`], value.deps)).toEqual({
    code: 0,
    stdout: `left-open ${pull}10 reply-from=operator\n`,
    stderr: "",
  });

  expect(value.calls).toEqual([{ args: threadsArgs(), deadline: 60_000 }]);
});

test("body file is passed by filename only, shell punctuation never enters argv", async () => {
  const value = fixture();
  const text = 'Fixed `echo secret`; $(touch secret) "quoted"\n';
  writeFileSync(value.body, text);

  expect((await runReply(["18", `${pull}10`, value.body], value.deps)).code).toBe(0);
  expect(writes(value)[0]!.args).toEqual(replyArgs());
  expect(value.calls.flatMap((call) => call.args).join(" ")).not.toContain(text.trim());
});

test("empty reply mutation response refuses before resolve", async () => {
  const value = fixture();
  value.posted = success();
  refusal(
    await runReply(["18", `${pull}10`, value.body], value.deps),
    `reply: the reply to ${pull}10 did not post`,
  );

  expect(writes(value)).toHaveLength(1);
});

test("resolve sorts and deduplicates non-reviewer logins, resolved state wins", async () => {
  const value = fixture();
  value.threads = [
    thread("T1", false, [
      comment(10),
      comment(11, "zoe"),
      comment(12, null),
      comment(13, "alice"),
      comment(14, "zoe"),
    ]),
    thread("T2", true, [comment(20), comment(21, "developer")]),
  ];

  expect(await runResolve(["18", `${pull}10`, `${pull}20`], value.deps)).toEqual({
    code: 0,
    stdout: `left-open ${pull}10 reply-from=alice,ghost,zoe\nalready-resolved ${pull}20\n`,
    stderr: "",
  });

  expect(writes(value)).toEqual([]);
});

test("no outsideDiff declarations match no source, not every line", async () => {
  const value = fixture(["testbot"]);
  value.responses.set(JSON.stringify(readArgs("12")[0]), success());
  value.responses.set(JSON.stringify(readArgs("12")[1]), success(JSON.stringify({
    body: "Comments Outside Diff\nnot a declared heading\n",
    reviews: [{ author: { login: "testbot" }, state: "COMMENTED", body: "Comments Outside Diff\nnot a declared heading\n" }],
    comments: [],
  })));

  const result = await runRead(["12"], value.deps);
  expect(result.code).toBe(0);
  expect(result.stdout.split("== comments outside diff\n")[1]).toBe("empty\n");
});

test("outside headings match case-insensitive substrings in every installed declaration", async () => {
  const value = reviewFixture();
  value.responses.set(JSON.stringify(readArgs("12")[0]), success());
  value.responses.set(JSON.stringify(readArgs("12")[1]), success(JSON.stringify({
    body: "prefix COMMENTS OUTSIDE DIFF suffix\nfinding\n",
    reviews: [{ author: { login: "coderabbitai" }, state: "COMMENTED", body: "Outside diff range comments\nsecond\n### review by other\nnot outside\n" }],
    comments: [{ author: { login: "other" }, url: "https://example/c", body: "comments outside diff\nthird\n### comment by later\nnot outside\n" }],
  })));

  const result = await runRead(["12"], value.deps);
  expect(result.code).toBe(0);
  expect(result.stdout.split("== comments outside diff\n")[1]).toBe(
    "found in: PR body, reviews, PR comments\nprefix COMMENTS OUTSIDE DIFF suffix\nfinding\nOutside diff range comments\nsecond\ncomments outside diff\nthird\n",
  );
});

for (const [index, source] of [
  "inline comments",
  "PR body, reviews and comments",
].entries())
  test(`review read stops at the first failing source in legacy order: ${source}`, async () => {
    const value = reviewFixture();
    for (const args of readArgs("12").slice(index))
      value.responses.set(JSON.stringify(args), failure());

    refusal(await runRead(["12"], value.deps), `review-read: gh failed reading ${source}`);
    expect(value.calls).toHaveLength(index + 1);
  });

test("review read preserves whitespace and shell newline trimming; empty sources print empty", async () => {
  const value = reviewFixture();
  value.responses.set(JSON.stringify(readArgs("12")[0]), success(" \t\n\n"));
  value.responses.set(JSON.stringify(readArgs("12")[1]), success(JSON.stringify({
    body: "intro  \nComments Outside Diff\nend  \n\n\n",
    reviews: [],
    comments: [],
  })));

  expect(await runRead(["12"], value.deps)).toEqual({
    code: 0,
    stdout:
      "== inline comments\nempty\n== PR body\nintro  \nComments Outside Diff\nend  \n== reviews\nempty\n== PR comments\nempty\n== comments outside diff\nfound in: PR body\nComments Outside Diff\nend  \n",
    stderr: "",
  });
});

test("review read renders ghost authors and separates nonempty reviews and comments", async () => {
  const value = reviewFixture();
  value.responses.set(JSON.stringify(readArgs("12")[0]), success());
  value.responses.set(JSON.stringify(readArgs("12")[1]), success(JSON.stringify({
    body: "",
    reviews: [
      { author: null, state: "COMMENTED", body: "first" },
      { author: { login: "operator" }, state: "APPROVED", body: "" },
      { author: { login: "bot" }, state: "COMMENTED", body: "  second  \n" },
    ],
    comments: [
      { author: null, url: "https://example/a", body: "" },
      { author: { login: "operator" }, url: "https://example/b", body: "last" },
    ],
  })));

  expect(await runRead(["12"], value.deps)).toEqual({
    code: 0,
    stdout: "== inline comments\nempty\n== PR body\nempty\n== reviews\n### review by ghost, COMMENTED\nfirst\n\n### review by bot, COMMENTED\n  second  \n== PR comments\n### comment by ghost\nhttps://example/a\n\n\n### comment by operator\nhttps://example/b\nlast\n== comments outside diff\nempty\n",
    stderr: "",
  });
});

for (const response of [
  "not JSON", "null", "[]", "{}",
  JSON.stringify({ body: null, reviews: [], comments: [] }),
  JSON.stringify({ body: "", reviews: {}, comments: [] }),
  JSON.stringify({ body: "", reviews: [], comments: null }),
  JSON.stringify({ body: "", reviews: [null], comments: [] }),
  JSON.stringify({ body: "", reviews: [{ body: "text", author: {}, state: "COMMENTED" }], comments: [] }),
  JSON.stringify({ body: "", reviews: [{ body: 3, author: null, state: "COMMENTED" }], comments: [] }),
  JSON.stringify({ body: "", reviews: [{ body: "text", author: null, state: null }], comments: [] }),
  JSON.stringify({ body: "", reviews: [], comments: [{ body: "text", author: null }] }),
  JSON.stringify({ body: "", reviews: [], comments: [{ body: null, author: null, url: "url" }] }),
])
  test(`review read fails closed on malformed PR view: ${response}`, async () => {
    const value = reviewFixture();
    value.responses.set(JSON.stringify(readArgs("12")[1]), success(response));

    refusal(await runRead(["12"], value.deps), "review-read: cannot read PR body, reviews and comments");
    expect(value.calls).toHaveLength(2);
  });

test("review verbs register in order and every test has exactly one root bun owner", async () => {
  const review = areas.find((area) =>
    area.verbs.some((verb) => verb.name.join(" ") === "review read"),
  )!;

  expect(review.verbs.map((verb) => verb.name)).toEqual([
    ["review", "read"],
    ["review", "reply"],
    ["review", "resolve"],
  ]);

  expect(suites.find((suite) => suite.name === "bun")!.files).toContain("src/**/*.test.ts");
  expect(suites.some((suite) => suite.name === "test-review-threads")).toBe(false);
  expect(await checkManifest(repo, suites)).toEqual([]);
});
