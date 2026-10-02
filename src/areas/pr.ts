import type { Area } from "../registry.ts";

export const pr: Area = {
  verbs: [
    {
      name: ["pr", "watch"],
      usage:
        "skills pr watch [--pr <n>] [--stack | --queued-stack [--stack-prs <n,...>]] [--status-only] [--allow-draft] [--pretty] [--interval s] [--sweep-interval s] [--timeout s] [--max-query-errors n] [--owner o --repo r]",
      grammar: [
        'NDJSON: {"schemaVersion":1,"sequence":n,"observedAt":"ISO-8601","mode":"single|stack|queued-stack","kind":"QUEUE|STATUS|WAITING|ADVANCE|RETRY|READY|COMPLETE|BLOCKER|TIMEOUT","terminal":boolean,...}; terminal verdicts include exitCode',
        "--pretty: STATUS Markdown table: PR | CI | Review | Merge",
        "--pretty: READY: no merge conflicts, no unresolved review threads, no failing or pending checks",
        "--pretty: BLOCKER: merge-conflicts|review-threads|failing-checks|closed-without-merge|draft-pr|changes-requested|review-required|status-query",
      ],
      async run(args, ctx) {
        const { main } = await import("../pr/watch.ts");
        return main(args, ctx.root);
      },
    },
  ],
  suites: [],
};
