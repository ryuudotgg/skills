import { processIo } from "../io.ts";
import type { Area } from "../registry.ts";

export const greenUsage = "skills pr green [<n>...] [--interval s] [--timeout s]";

export const pr: Area = {
  verbs: [
    {
      name: ["pr", "green"],
      allow: true,
      usage: greenUsage,
      grammar: [
        "#<n> green <head sha, first 7 chars>",
        "#<n> merged",
        "#<n> closed",
        "#<n> blocked <rollup state>",
        "#<n> conflicting <mergeable> <mergeStateStatus>",
        "#<n> failing <check name> <check link or ->",
        "#<n> pending <check name>",
        "#<n> no checks yet on <head sha, first 7 chars>",
        "#<n> mergeability unknown",
        "#<n> rule unmet <rollup state or ->",
        "#<n> unreadable <detail>",
        "waiting: <line>",
        "#<n> auto-merge armed <MERGE|SQUASH|REBASE>",
        "#<n> in merge queue",
        "unreadable <detail>",
      ],
      sync: true,
      async run(args, ctx) {
        const { main } = await import("../pr/green.ts");
        return main(args, ctx.root);
      },
    },
    {
      name: ["pr", "watch"],
      allow: true,
      usage:
        "skills pr watch [--pr <n>] [--stack | --queued-stack [--stack-prs <n,...>]] [--status-only] [--allow-draft] [--pretty] [--interval s] [--sweep-interval s] [--timeout s] [--max-query-errors n] [--owner o --repo r]",
      grammar: [
        'NDJSON: {"schemaVersion":1,"sequence":n,"observedAt":"ISO-8601","mode":"single|stack|queued-stack","kind":"QUEUE|STATUS|WAITING|ADVANCE|RETRY|READY|COMPLETE|BLOCKER|TIMEOUT","terminal":boolean,...}; terminal verdicts include exitCode',
        "--pretty: QUEUE: captured <n> PR[s] bottom-to-top: #<n>[,#<n>...]",
        "--pretty: STATUS Markdown table: PR | CI | Review | Merge",
        "--pretty: WAITING: frontier=#<n>; <n> check[s] pending",
        "--pretty: WAITING: frontier=#<n>; no checks yet on <head sha, first 7 chars>",
        "--pretty: WAITING: frontier=#<n> is blocker-free; waiting for merge queue (<n> PR[s] unmerged)",
        "--pretty: ADVANCE: merged #<n>[,#<n>...]; next=#<n>; remaining=<n>",
        "--pretty: RETRY: GitHub status query failed; retrying in <n>s",
        "--pretty: detail=<detail>",
        "--pretty: READY: no merge conflicts, no unresolved review threads, no failing or pending checks",
        "--pretty: BLOCKER: merge-conflicts|review-threads|failing-checks|closed-without-merge|draft-pr|changes-requested|review-required|status-query",
        "--pretty: COMPLETE: queued stack merged (<n> PR[s]): #<n>[,#<n>...]",
        "--pretty: TIMEOUT: checks still pending",
        "--pretty: TIMEOUT: no checks yet on <head sha, first 7 chars>",
        "--pretty: TIMEOUT: GitHub status remained unavailable",
        "--pretty: TIMEOUT: queued stack still has <n> PR[s] unmerged; frontier=#<n>",
      ],
      ownsHelp: true,
      async run(args, ctx) {
        const { main } = await import("../pr/watch.ts");
        return main(args, ctx.root);
      },
    },
    {
      name: ["pr", "retitle"],
      allow: false,
      usage: 'skills pr retitle <n> "<title>"',
      grammar: ["#<n> retitled", "#<n> unchanged"],
      async run(args, ctx) {
        const { retitleVerb } = await import("../pr/retitle.ts");
        return retitleVerb(args, this.usage, ctx.root, processIo());
      },
    },
  ],
  suites: [],
};
