import type { Area } from "../registry.ts";
import type { Dependencies } from "../review/threads.ts";
import type { CommandOutput } from "../round/types.ts";

type Handler = (
  args: readonly string[],
  deps: Dependencies,
  usage: string,
) => Promise<CommandOutput>;

const usages = {
  read: "skills review read <pr number>",
  reply: "skills review reply <pr> <inline comment url> <body file>",
  resolve: "skills review resolve <pr> <inline comment url>...",
} as const;

export function usage(verb: keyof typeof usages): string {
  return `usage: ${usages[verb]}`;
}

async function run(
  verb: keyof typeof usages,
  load: () => Promise<Handler>,
  args: readonly string[],
  root: string,
): Promise<number> {
  const [handler, { dependencies }] = await Promise.all([load(), import("../review/threads.ts")]);

  const result = await handler(args, dependencies(root), usage(verb));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  return result.code;
}

export const review: Area = {
  verbs: [
    {
      name: ["review", "read"],
      allow: true,
      usage: usages.read,
      grammar: [
        "== inline comments",
        "== PR body",
        "== reviews",
        "== PR comments",
        "== comments outside diff",
      ],
      run: (args, ctx) =>
        run("read", () => import("../review/read.ts").then((verb) => verb.runRead), args, ctx.root),
    },
    {
      name: ["review", "reply"],
      allow: false,
      usage: usages.reply,
      grammar: ["replied <url>", "resolved <url>"],
      run: (args, ctx) =>
        run(
          "reply",
          () => import("../review/reply.ts").then((verb) => verb.runReply),
          args,
          ctx.root,
        ),
    },
    {
      name: ["review", "resolve"],
      allow: false,
      usage: usages.resolve,
      grammar: ["resolved <url>", "already-resolved <url>", "left-open <url> reply-from=<logins>"],
      run: (args, ctx) =>
        run(
          "resolve",
          () => import("../review/resolve.ts").then((verb) => verb.runResolve),
          args,
          ctx.root,
        ),
    },
  ],
  suites: [],
};
