import { accessSync, constants, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import { withLock } from "../lock.ts";
import { read } from "../read.ts";
import { isFile } from "../reviewers/declaration.ts";
import { readSettingsSources } from "../reviewers/settings.ts";
import type { CommandOutput, ReadRunner } from "../round/types.ts";
import { checkOutgoing, disclose } from "./outgoing.ts";
import { outgoingSetting } from "./outgoing-keys.ts";
import {
  activeReviewers,
  declarations,
  readThreadBodies,
  readThreads,
  replyMutation,
  resolveMutation,
  runReview,
  validUrl,
  type Dependencies,
} from "./threads.ts";

export const replyUsage = "usage: skills review reply <pr> <inline comment url> <body file>";

function normalise(body: string): string {
  return body.replaceAll("\r\n", "\n").trim();
}

function gitIn(cwd: string, env: NodeJS.ProcessEnv): ReadRunner {
  return async (args, deadline) => {
    const result = await read(["git", ...args], { cwd, env, deadline });
    return result.ok
      ? { code: result.code, stdout: result.stdout, stderr: result.stderr }
      : { code: -1, stdout: "", stderr: "" };
  };
}

export async function runReply(
  args: readonly string[],
  deps: Dependencies,
): Promise<CommandOutput> {
  return runReview("reply", replyUsage, deps, async (output, context) => {
    const [number, url, file] = args;
    if (
      args.length !== 3 ||
      !number ||
      !/^\d+$/.test(number) ||
      !url ||
      !validUrl(number, url) ||
      !file
    )
      throw new Error(replyUsage);

    let body: string;
    try {
      if (!isFile(file)) throw new Error(replyUsage);
      accessSync(file, constants.R_OK);
      body = readFileSync(file, "utf8");
    } catch {
      throw new Error(replyUsage);
    }

    if (!/\S/.test(body)) throw new Error("the reply body is empty");

    const installed = declarations(context);
    checkOutgoing({
      kind: "reply",
      body,
      env: context.env,
      directory: context.cwd,
      reviewers: installed,
    });

    const { names, logins } = activeReviewers(installed, context, "reply");
    const sources = await readSettingsSources(
      [],
      readDeliveryConfig(context.env),
      gitIn(context.cwd, context.env),
    );

    const text = outgoingSetting("disclosure", sources) === "on" ? disclose(body) : body;

    const { viewer, threads } = await readThreads(number, context.gh, context.stderr);
    const thread = threads.find((entry) => entry.comments.some((comment) => comment.url === url));
    if (!thread) throw new Error(`${url} is not in a review thread on PR ${number}`);

    const lock = join(tmpdir(), `skills-review-${thread.id.replace(/[^A-Za-z0-9_-]/g, "_")}.lock`);
    await withLock(lock, "review thread", async () => {
      const fresh = await readThreadBodies(thread.id, context.gh, context.stderr);
      const bodies = fresh.comments;
      let prior: string | undefined;

      const answers = new Set([normalise(body), normalise(disclose(body))]);
      const previous = bodies.findLast(
        (comment) => comment.login === viewer && answers.has(normalise(comment.body)),
      );

      const first = bodies[0];
      const latest = bodies.findLast((comment) => comment.login === viewer);
      if (first && latest && logins.has(first.login.toLowerCase()))
        if (
          previous &&
          bodies.every((comment) => comment === previous || logins.has(comment.login.toLowerCase()))
        )
          prior = previous.url;
        else if (
          !previous &&
          bodies.every(
            (comment) => comment.login === viewer || logins.has(comment.login.toLowerCase()),
          )
        )
          throw new Error(`${url} already holds a reply from ${viewer} at ${latest.url}`);

      if (!prior && fresh.isResolved) throw new Error(`${url} is in a resolved thread`);
      if (
        !prior &&
        (!bodies[0] ||
          !logins.has(bodies[0].login.toLowerCase()) ||
          !bodies.every((comment) => logins.has(comment.login.toLowerCase())))
      )
        throw new Error(`${url} is not in a thread only ${names} has written in`);

      let posted = prior;
      if (!posted) {
        const result = await context.gh(
          [
            "api",
            "graphql",
            "-f",
            `query=${replyMutation}`,
            "-f",
            `id=${thread.id}`,
            "-F",
            "body=@-",
            "--jq",
            ".data.addPullRequestReviewThreadReply.comment.url",
          ],
          undefined,
          text,
        );

        context.stderr?.(result.stderr);
        if (result.code !== 0) throw new Error(`gh failed replying to ${url}`);

        posted = result.stdout.replace(/\n+$/, "");
        if (!posted) throw new Error(`the reply to ${url} did not post`);
      }

      output.stdout = `replied ${posted}\n`;

      if (!fresh.isResolved) {
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
        if (result.stdout.replace(/\n+$/, "") !== "true") throw new Error(`${url} did not resolve`);
      }

      output.stdout += `resolved ${url}\n`;
    });
  });
}
