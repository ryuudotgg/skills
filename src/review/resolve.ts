import type { CommandOutput } from "../round/types.ts";
import {
  activeReviewers,
  declarations,
  readThreads,
  resolveMutation,
  runReview,
  validUrl,
  type Dependencies,
} from "./threads.ts";

export const resolveUsage = "usage: skills review resolve <pr> <inline comment url>...";

export async function runResolve(
  args: readonly string[],
  deps: Dependencies,
): Promise<CommandOutput> {
  return runReview("resolve", resolveUsage, deps, async (output, context) => {
    const [number, ...urls] = args;
    if (
      !number ||
      !/^\d+$/.test(number) ||
      !urls.length ||
      urls.some((url) => !validUrl(number, url))
    )
      throw new Error(resolveUsage);

    const { names, logins } = activeReviewers(declarations(context), context, "resolve");
    const { threads } = await readThreads(number, context.gh, context.stderr);
    const plan = urls.map((url) => {
      const thread = threads.find((entry) =>
        entry.comments.some((comment) => comment.url === url),
      );

      if (!thread) throw new Error(`${url} is not in a review thread on PR ${number}`);
      if (!thread.comments[0] || !logins.has(thread.comments[0].login.toLowerCase()))
        throw new Error(`${url} is in a thread ${names} did not start`);

      const others = [
        ...new Set(
          thread.comments
            .filter((comment) => !logins.has(comment.login.toLowerCase()))
            .map((comment) => comment.login),
        ),
      ].sort();

      return { url, thread, others };
    });

    const resolved = new Set<string>();
    for (const { url, thread, others } of plan)
      if (thread.isResolved) output.stdout += `already-resolved ${url}\n`;
      else if (others.length)
        output.stdout += `left-open ${url} reply-from=${others.join(",")}\n`;
      else {
        if (!resolved.has(thread.id)) {
          const result = await context.gh([
            "api",
            "graphql",
            "-f",
            `query=${resolveMutation}`,
            "-f",
            `id=${thread.id}`,
            "--jq",
            ".data.resolveReviewThread.thread.isResolved",
          ]);

          context.stderr?.(result.stderr);
          if (result.code !== 0) throw new Error(`gh failed resolving ${url}`);
          if (result.stdout.replace(/\n+$/, "") !== "true")
            throw new Error(`${url} did not resolve`);

          resolved.add(thread.id);
        }

        output.stdout += `resolved ${url}\n`;
      }
  });
}
