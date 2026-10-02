import type { Area } from "../registry.ts";

export const review: Area = {
  verbs: [
    {
      name: ["review", "read"],
      usage: "skills review read <pr number>",
      grammar: [
        "== inline comments",
        "== PR body",
        "== reviews",
        "== PR comments",
        "== comments outside diff",
      ],
      async run(args, ctx) {
        const { runRead } = await import("../review/read.ts");
        const { dependencies } = await import("../review/threads.ts");
        const result = await runRead(args, dependencies(ctx.root));
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
    {
      name: ["review", "reply"],
      usage: "skills review reply <pr> <inline comment url> <body file>",
      grammar: ["replied <url>", "resolved <url>"],
      async run(args, ctx) {
        const { runReply } = await import("../review/reply.ts");
        const { dependencies } = await import("../review/threads.ts");
        const result = await runReply(args, dependencies(ctx.root));
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
    {
      name: ["review", "resolve"],
      usage: "skills review resolve <pr> <inline comment url>...",
      grammar: [
        "resolved <url>",
        "already-resolved <url>",
        "left-open <url> reply-from=<logins>",
      ],
      async run(args, ctx) {
        const { runResolve } = await import("../review/resolve.ts");
        const { dependencies } = await import("../review/threads.ts");
        const result = await runResolve(args, dependencies(ctx.root));
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
  ],
  suites: [],
};
