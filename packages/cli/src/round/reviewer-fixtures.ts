import { readDeclarations } from "../reviewers/declaration.ts";
import { resolveSettings } from "../reviewers/settings.ts";
import { acceptanceCases, repo, reviewerInput } from "./fixtures.ts";
import { presence } from "./presence.ts";
import type { CheckRun, Comment, PullRequest, Review, ReviewerInput, Snapshot } from "./types.ts";

export const coderabbitNow = "2026-09-27T16:58:30Z";
export const macroscopeNow = "2026-09-30T14:30:00Z";
const headOid = "a".repeat(40);
const oldOid = "b".repeat(40);
const declarations = readDeclarations(`${repo}/skills`);

export function inputFor(
  name: string,
  snapshot: Snapshot,
  changes: Partial<ReviewerInput> = {},
): ReviewerInput {
  const declaration = declarations.find((entry) => entry.name === name)!;
  const settings = resolveSettings(declaration, true, {
    conf: "",
    lines: [],
    git: new Map(),
    unknown: [],
  }).values;

  const now = name === "coderabbit" ? coderabbitNow : macroscopeNow;
  const input = reviewerInput(snapshot.pr, { snapshot, declaration, settings, now, ...changes });
  input.presence = presence(snapshot, declaration, input.now);

  return input;
}

function base(stamp: string): PullRequest {
  return {
    body: "",
    createdAt: stamp,
    userContentEdits: { nodes: [] },
    timelineItems: { nodes: [] },
    comments: { nodes: [] },
    reviews: { nodes: [] },
    reviewThreads: { nodes: [] },
    commits: {
      nodes: [
        {
          commit: {
            oid: headOid,
            committedDate: stamp,
            checkSuites: { nodes: [{ createdAt: stamp }] },
            statusCheckRollup: { contexts: { nodes: [] } },
          },
        },
      ],
    },
  };
}

export function coderabbitFixture(name: string): Snapshot {
  const stamp = "2026-09-27T16:50:00Z";
  const bot = { login: "coderabbitai" };
  const major = "_🟠 Major_ Find a missing branch.";
  const minor = "_🟡 Minor_ Check the name.";
  const trivial = "_🔵 Trivial_ Tidy this.";

  const pr = base(stamp);
  const head = pr.commits.nodes[0]!.commit;
  const check = {
    __typename: "StatusContext" as const,
    context: "CodeRabbit",
    state: "SUCCESS",
    description: "Review completed",
    createdAt: stamp,
  };

  head.statusCheckRollup!.contexts.nodes = [check];
  const review = (oid = headOid, body = "Reviewed this commit.", state = "COMMENTED"): Review => ({
    author: bot,
    state,
    body,
    commit: { oid },
    submittedAt: null,
  });

  const thread = (body = major, resolved = false, oid = headOid) => ({
    isResolved: resolved,
    comments: { nodes: [{ author: bot, body, originalCommit: { oid } }] },
    latest: undefined as PullRequest["reviewThreads"]["nodes"][number]["latest"],
  });

  const oldCommit = () =>
    pr.commits.nodes.unshift({
      commit: {
        oid: oldOid,
        committedDate: stamp,
        checkSuites: { nodes: [] },
        statusCheckRollup: null,
      },
    });

  const comment = (
    body: string,
    createdAt = stamp,
    updatedAt = createdAt,
    author = bot,
  ): Comment => ({ author, body, createdAt, updatedAt });

  if (
    [
      "major",
      "approved",
      "trivial",
      "old-major",
      "budget",
      "minor",
      "empty",
      "real-line",
      "no-severity",
      "outside-major",
      "outside-minor",
      "dismissed",
      "full-threads",
      "full-reviews",
      "old-approved",
      "outside-mismatch",
    ].includes(name)
  )
    pr.reviews.nodes.push(review());

  if (["major", "budget", "minor", "real-line", "no-severity", "dismissed"].includes(name))
    pr.reviewThreads.nodes.push(
      thread(
        name === "minor"
          ? minor
          : name === "real-line"
            ? "_🧭 Sample Category_ | _🟡 Minor_ | _⚡ Quick win_"
            : name === "no-severity"
              ? "Unlabeled issue."
              : major,
      ),
    );

  if (name === "approved-then-review") {
    pr.reviewThreads.nodes.push(thread());
    pr.reviews.nodes = [review(headOid, "", "APPROVED"), review(headOid, "Found a new issue.")];
  } else if (name === "approved") {
    pr.reviewThreads.nodes.push(thread(major, true));
    pr.reviews.nodes.push(review(headOid, "", "APPROVED"));
  } else if (name === "trivial") pr.reviewThreads.nodes.push(thread(trivial));
  else if (name === "old-major") {
    pr.reviewThreads.nodes.push(thread(major, false, oldOid));
    oldCommit();
  } else if (name === "budget")
    for (const letter of "bcd") pr.reviews.nodes.push(review(letter.repeat(40)));
  else if (name === "old-approved") {
    head.statusCheckRollup = null;
    pr.reviews.nodes = [review(oldOid, "", "APPROVED")];
  } else if (name === "empty") {
    head.statusCheckRollup = null;
    pr.reviews.nodes = [review(headOid, "")];
  } else if (["outside-major", "outside-minor"].includes(name)) {
    const word = name === "outside-major" ? "Major" : "Minor";
    const icon = name === "outside-major" ? "🟠" : "🟡";
    pr.reviews.nodes = [
      review(
        headOid,
        `> [!CAUTION]\n> Some comments are outside the diff.\n> **⚠️ Outside diff range comments (1)**\n> <details>\n> <summary><em>${icon} ${word}</em> · <code>sample.py:8</code></summary><blockquote>\n> An invented finding.\n> <details>\n> <summary>Supported by static analysis</summary>\n> </details>\n> <!-- cr-comment:v1:synthetic -->\n> </blockquote></details>`,
      ),
    ];
  } else if (name === "full-threads")
    pr.reviewThreads.nodes = Array.from({ length: 100 }, () => thread(trivial, true));
  else if (name === "full-reviews") {
    pr.reviewThreads.nodes = [thread()];
    pr.reviews.nodes.push(...Array.from({ length: 99 }, () => review(headOid, "")));
  } else if (
    [
      "paused",
      "paused-budget",
      "triggered",
      "pending",
      "expected",
      "absent",
      "old-notice",
      "open-notice",
      "notice-pending",
      "old-wait",
    ].includes(name)
  ) {
    pr.reviews.nodes = [];

    if (
      ["paused", "paused-budget", "triggered", "absent", "old-notice", "open-notice"].includes(name)
    )
      head.statusCheckRollup = null;

    if (name === "triggered")
      pr.comments.nodes.push(
        comment("Walkthrough."),
        comment(" @coderabbitai review ", "2026-09-27T16:51:00Z", "2026-09-27T16:51:00Z", {
          login: "developer",
        }),
      );

    if (["paused", "paused-budget"].includes(name))
      pr.comments.nodes.push(comment("Review paused."));

    if (name === "paused-budget") pr.reviews.nodes.push(review(oldOid));
    if (name === "pending" || name === "notice-pending")
      Object.assign(check, { state: "PENDING", description: "Review in progress" });

    if (name === "expected") check.state = "EXPECTED";
    if (name === "old-wait") check.description = "Review rate limited";
    if (["old-notice", "open-notice", "notice-pending", "old-wait"].includes(name)) {
      const body =
        "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n" +
        (name === "old-wait"
          ? "Please wait **1 minutes and 30 seconds**"
          : "**Next included review available in 15 minutes.**");

      const updated =
        name === "old-notice"
          ? "2026-09-27T16:30:00Z"
          : name === "open-notice"
            ? "2026-09-27T16:49:00Z"
            : "2026-09-27T16:58:01Z";

      pr.comments.nodes.push(comment(body, stamp, updated));
    }
  } else if (
    [
      "trigger-limited",
      "status-limited",
      "limited-old-major",
      "limited-answered-major",
      "ready",
    ].includes(name)
  ) {
    check.description =
      name === "ready" ? "Review skipped: automatic reviews are disabled" : "Review rate limited";

    if (["limited-old-major", "limited-answered-major"].includes(name)) {
      oldCommit();
      pr.reviewThreads.nodes.push(thread(major, false, oldOid));
    }

    if (name === "limited-answered-major")
      pr.reviewThreads.nodes.at(-1)!.latest = { nodes: [{ author: { login: "developer" } }] };

    if (name === "trigger-limited")
      pr.comments.nodes.push(
        comment("@coderabbitai review", "2026-09-27T16:51:00Z", "2026-09-27T16:51:00Z", {
          login: "developer",
        }),
        comment(
          "<!-- This is an auto-generated comment: rate limited by coderabbit.ai -->\n**Next included review available in 5 minutes.**",
          stamp,
          "2026-09-27T16:51:10Z",
        ),
      );

    if (name === "ready") pr.timelineItems.nodes.push({ createdAt: "2026-09-27T16:56:00Z" });
  } else if (name === "outside-mismatch")
    pr.reviews.nodes = [
      review(
        headOid,
        "> **⚠️ Outside diff range comments (2)**\n> <details>\n> <summary><em>🔵 Trivial</em> · <code>sample.py:3</code></summary><blockquote>\n> An invented finding.\n> <!-- cr-comment:v1:synthetic -->\n> </blockquote></details>",
      ),
    ];
  else if (
    [
      "completed-head",
      "completed-old-major",
      "approved-status",
      "skipped-disabled",
      "skipped-disabled-budget",
      "skipped-ineligible",
      "completed-budget",
      "completed-and-review",
    ].includes(name)
  ) {
    check.description =
      name === "approved-status"
        ? "Review approved"
        : name.startsWith("skipped-disabled")
          ? "Review skipped: automatic reviews are disabled"
          : name === "skipped-ineligible"
            ? "Review skipped: bot user not eligible for review"
            : "Review completed";

    pr.comments.nodes.push(comment("Walkthrough."));

    if (name === "completed-old-major") {
      oldCommit();
      pr.reviewThreads.nodes.push(thread(major, false, oldOid));
    } else if (name === "completed-budget" || name === "completed-and-review") {
      if (name === "completed-and-review") pr.reviews.nodes.push(review());

      for (const letter of name === "completed-budget" ? "bcd" : "bc")
        pr.reviews.nodes.push(review(letter.repeat(40)));

      pr.reviewThreads.nodes.push(thread());
    } else if (name === "skipped-disabled-budget") pr.reviews.nodes.push(review(oldOid));
  }

  return { pr, comments: pr.comments.nodes, headChecks: {} };
}

export function coderabbitAcceptance(name: string): Snapshot {
  const pr = structuredClone(
    acceptanceCases.find((entry) => entry.name === (name === "expected" ? "absent" : name))!.pr,
  );

  for (const item of [
    ...pr.comments.nodes,
    ...pr.reviews.nodes,
    ...pr.reviewThreads.nodes.flatMap((thread) => thread.comments.nodes),
  ])
    if (item.author?.login.startsWith("greptile-apps"))
      item.author.login = item.author.login.replace("greptile-apps", "coderabbitai");

  for (const edit of pr.userContentEdits.nodes)
    if (edit.editor?.login.toLowerCase().startsWith("greptile-apps"))
      edit.editor.login = edit.editor.login.replace(/greptile-apps/i, "CODERABBITAI");

  for (const item of pr.comments.nodes)
    item.body = item.body?.replace("@greptileai", "@coderabbitai review") ?? null;

  for (const { commit } of pr.commits.nodes)
    commit.statusCheckRollup!.contexts.nodes = commit.statusCheckRollup!.contexts.nodes.map(
      (check) =>
        check.__typename === "CheckRun" && check.name === "Greptile Review"
          ? {
              __typename: "StatusContext",
              context: "CodeRabbit",
              state: check.status === "IN_PROGRESS" ? "PENDING" : "SUCCESS",
              description:
                check.status === "IN_PROGRESS" ? "Review in progress" : "Review completed",
              createdAt: check.startedAt!,
            }
          : check,
    );

  if (name === "seen-push") pr.reviews.nodes = [];
  if (name === "thread-seen") {
    const starter = pr.reviewThreads.nodes[0]!.comments.nodes[0]!;
    starter.body = "Finding.";
  }

  if (name === "expected")
    pr.commits.nodes.at(-1)!.commit.statusCheckRollup!.contexts.nodes = [
      {
        __typename: "StatusContext",
        context: "CodeRabbit",
        state: "EXPECTED",
        createdAt: "2026-09-28T11:58:30Z",
        description: null,
      },
    ];

  return { pr, comments: pr.comments.nodes, headChecks: {} };
}

export function macroscopeFixture(
  name: string,
  approvalRows: CheckRun[] = [],
  earlierComments: Comment[] = [],
): Snapshot {
  const stamp = "2026-09-30T14:20:00Z";
  const later = "2026-09-30T14:21:00Z";
  const bot = { login: "macroscopeapp" };
  const human = { login: "developer" };

  const medium = "🟡 **Medium** `sample.py:14`\n\nA missing branch.";
  const low = "🔵 **Low** `sample.py:3`\n\nTidy this.";
  const run = (
    status = "COMPLETED",
    conclusion = "SUCCESS",
    name = "Macroscope - Correctness Check",
    startedAt: string | null = stamp,
  ): CheckRun => ({
    __typename: "CheckRun",
    name,
    status,
    conclusion: status === "COMPLETED" ? conclusion : null,
    startedAt,
    completedAt: status === "COMPLETED" ? stamp : null,
    checkSuite: { createdAt: stamp },
  });

  const commit = (oid: string, checks: CheckRun[]) => ({
    commit: {
      oid,
      committedDate: stamp,
      checkSuites: { nodes: [{ createdAt: stamp }] },
      statusCheckRollup: {
        contexts: { nodes: checks, pageInfo: { hasNextPage: false } },
      } as PullRequest["commits"]["nodes"][number]["commit"]["statusCheckRollup"],
    },
  });

  const thread = (body = medium, resolved = false, last = bot) => ({
    isResolved: resolved,
    comments: { nodes: [{ author: bot, body }] },
    latest: { nodes: [{ author: last }] },
  });

  const pr = base(stamp);
  pr.reviews.nodes = [{ author: bot, body: null, submittedAt: null, commit: null }];
  pr.commits.nodes = [
    commit(headOid, [run("COMPLETED", "SUCCESS", "Macroscope - Approvability Check"), run()]),
  ];

  const head = pr.commits.nodes[0]!.commit;
  const checks = head.statusCheckRollup!.contexts.nodes as CheckRun[];
  if (name === "medium") pr.reviewThreads.nodes.push(thread());
  else if (name === "low") pr.reviewThreads.nodes.push(thread(low));
  else if (name === "resolved") pr.reviewThreads.nodes.push(thread(medium, true));
  else if (name === "no-severity") pr.reviewThreads.nodes.push(thread("Unlabeled issue."));
  else if (name === "human-thread")
    pr.reviewThreads.nodes.push({
      isResolved: false,
      comments: { nodes: [{ author: human, body: "Why?" }] },
      latest: { nodes: [{ author: human }] },
    });
  else if (name === "neutral") {
    checks[1]!.conclusion = "NEUTRAL";
    pr.reviewThreads.nodes.push(thread());
  } else if (name === "old-medium") {
    pr.commits.nodes.unshift(commit(oldOid, [run("COMPLETED", "NEUTRAL")]));
    pr.reviewThreads.nodes.push(thread());
  } else if (name === "budget") {
    pr.commits.nodes.unshift(...[..."bc"].map((letter) => commit(letter.repeat(40), [run()])));
    pr.reviewThreads.nodes.push(thread());
  } else if (
    ["unreviewed", "unreviewed-budget", "triggered", "triggered-answered", "absent"].includes(name)
  ) {
    head.statusCheckRollup = null;

    if (name === "unreviewed-budget")
      pr.commits.nodes.unshift(...[..."bcd"].map((letter) => commit(letter.repeat(40), [run()])));

    if (name.startsWith("triggered"))
      pr.comments.nodes.push({
        author: human,
        body: name === "triggered" ? " @macroscope-app review " : "@macroscope-app review",
        createdAt: later,
      });

    if (name === "triggered-answered") pr.reviewThreads.nodes.push(thread());
    if (name === "absent") pr.reviews.nodes = [];
  } else if (name === "skipped") checks[1]!.conclusion = "SKIPPED";
  else if (name === "pending") checks[1] = run("IN_PROGRESS");
  else if (name === "full-threads")
    pr.reviewThreads.nodes = Array.from({ length: 100 }, () => thread(low, true));
  else if (name.startsWith("not-approved")) {
    checks[0]!.conclusion = "NEUTRAL";
    if (name === "not-approved-low") pr.reviewThreads.nodes.push(thread(low));
  } else if (name === "approval-skipped") checks[0]!.conclusion = "SKIPPED";
  else if (name === "no-approval") checks.shift();
  else if (name === "approval-pending")
    checks[0] = run(
      "IN_PROGRESS",
      "SUCCESS",
      "Macroscope - Approvability Check",
      "2026-09-30T14:25:00Z",
    );
  else if (name === "rerun")
    checks.push(
      run("COMPLETED", "CANCELLED", "Macroscope - Correctness Check", "2026-09-30T14:10:00Z"),
      run("COMPLETED", "NEUTRAL", "Macroscope - Approvability Check", "2026-09-30T14:10:00Z"),
    );
  else if (["full-contexts", "context-page", "stale-visible"].includes(name)) {
    if (name === "stale-visible")
      Object.assign(checks[0]!, { conclusion: "NEUTRAL", startedAt: "2026-09-30T14:00:00Z" });
    else checks.shift();

    checks.push(...Array.from({ length: 99 }, () => run("COMPLETED", "SUCCESS", "build")));
    head.statusCheckRollup!.contexts.pageInfo = { hasNextPage: name !== "context-page" };
  } else if (["commit-page", "long-commits"].includes(name)) {
    pr.commits.nodes.unshift(
      ...Array.from({ length: 99 }, (_, index) => commit(String(index).padStart(40, "0"), [])),
    );

    head.statusCheckRollup = null;
    pr.commits.totalCount = name === "long-commits" ? 150 : 100;
  } else if (["buried-trigger", "noise-page"].includes(name)) {
    head.statusCheckRollup = null;
    pr.comments.nodes = Array.from({ length: 100 }, () => ({
      author: human,
      body: "noise",
      createdAt: later,
    }));

    pr.comments.pageInfo = {
      hasPreviousPage: name === "buried-trigger",
      startCursor: name === "buried-trigger" ? "older" : null,
    };
  } else if (name === "unreviewed-open") {
    pr.commits.nodes.unshift(commit(oldOid, [run("COMPLETED", "NEUTRAL")]));
    head.statusCheckRollup = null;
    pr.reviewThreads.nodes.push(thread());
  }

  return {
    pr,
    comments: [...earlierComments, ...pr.comments.nodes],
    headChecks: { "Macroscope - Approvability Check": approvalRows },
  };
}
