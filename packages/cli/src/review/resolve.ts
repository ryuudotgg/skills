import type { CommandOutput } from "../round/types.ts";
import {
  activeReviewers,
  declarations,
  readThreadComments,
  readThreads,
  resolveThread,
  runReview,
  validUrl,
  type Dependencies,
  type ThreadComment,
} from "./threads.ts";

function outsiders(comments: readonly ThreadComment[], logins: ReadonlySet<string>): string[] {
  return [
    ...new Set(
      comments
        .filter((comment) => !logins.has(comment.login.toLowerCase()))
        .map((comment) => comment.login),
    ),
  ].sort();
}

export async function runResolve(
  args: readonly string[],
  deps: Dependencies,
  usage: string,
): Promise<CommandOutput> {
  return runReview("resolve", usage, deps, async (output, context) => {
    const [number, ...urls] = args;
    if (
      !number ||
      !/^\d+$/.test(number) ||
      !urls.length ||
      urls.some((url) => !validUrl(number, url))
    )
      throw new Error(usage);

    const { names, logins } = activeReviewers(declarations(context), context, "resolve");
    const { threads } = await readThreads(number, context.gh, context.stderr);
    const plan = urls.map((url) => {
      const thread = threads.find((entry) => entry.comments.some((comment) => comment.url === url));
      if (!thread) throw new Error(`${url} is not in a review thread on PR ${number}`);
      if (!thread.comments[0] || !logins.has(thread.comments[0].login.toLowerCase()))
        throw new Error(`${url} is in a thread ${names} did not start`);

      return { url, thread, others: outsiders(thread.comments, logins) };
    });

    const outcomes = new Map<
      string,
      { status: "resolved" | "already-resolved" | "left-open"; others: string[] }
    >();

    for (const { url, thread, others } of plan)
      if (thread.isResolved) output.stdout += `already-resolved ${url}\n`;
      else if (others.length) output.stdout += `left-open ${url} reply-from=${others.join(",")}\n`;
      else {
        let outcome = outcomes.get(thread.id);
        if (outcome === undefined) {
          const fresh = await readThreadComments(thread.id, context.gh, context.stderr);
          const freshOthers = outsiders(fresh.comments, logins);
          if (fresh.isResolved) outcome = { status: "already-resolved", others: [] };
          else if (freshOthers.length) outcome = { status: "left-open", others: freshOthers };
          else {
            await resolveThread(thread.id, url, context);
            outcome = { status: "resolved", others: [] };
          }

          outcomes.set(thread.id, outcome);
        }

        output.stdout += `${outcome.status} ${url}${outcome.others.length ? ` reply-from=${outcome.others.join(",")}` : ""}\n`;
      }
  });
}
