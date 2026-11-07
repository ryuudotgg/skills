import { readDelivery } from "../delivery.ts";
import type { Io } from "../io.ts";
import { messageProblem, run } from "../publish/commit.ts";
import { owned, projectIndexes } from "../stack/layers.ts";
import { Refusal, refuse } from "../stack/restack.ts";

type Pr = {
  state: string;
  isCrossRepository: boolean;
  headRefName: string;
  title: string;
  headlines: string[];
};

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function parsePr(text: string): Pr | undefined {
  try {
    const { state, isCrossRepository, headRefName, title, commits } =
      object(JSON.parse(text)) ?? {};

    if (
      typeof state !== "string" ||
      typeof isCrossRepository !== "boolean" ||
      typeof headRefName !== "string" ||
      typeof title !== "string" ||
      !Array.isArray(commits)
    )
      return undefined;

    const headlines: string[] = [];
    for (const commit of commits) {
      const headline = object(commit)?.messageHeadline;
      if (typeof headline !== "string") return undefined;
      headlines.push(headline);
    }

    return { state, isCrossRepository, headRefName, title, headlines };
  } catch {
    return undefined;
  }
}

async function retitle(number: string, title: string, root: string, io: Io): Promise<number> {
  const problem = messageProblem(title);
  if (problem) refuse(problem);
  if (readDelivery(root, io.env).mode !== "prs") refuse("delivery mode is not prs");

  const view = await run(
    io.cwd,
    ["gh", "pr", "view", number, "--json", "state,isCrossRepository,headRefName,title,commits"],
    { capture: true, timeout: 60_000 },
    io,
  );

  if (view.code !== 0) refuse(`cannot read PR #${number}`);

  const pr = parsePr(view.output);
  if (!pr) refuse(`cannot read PR #${number}`);
  if (pr.state !== "OPEN") refuse(`#${number} is ${pr.state.toLowerCase()}`);
  if (pr.isCrossRepository) refuse(`#${number} comes from another repository`);

  const { indexes, owners } = await projectIndexes(undefined, io);
  if (!(await owned({ ...io, indexes, ownRows: new Set(), owners }, pr.headRefName)))
    refuse(`${pr.headRefName} is not an owned branch`);

  const [only, second] = pr.headlines;
  if (only !== undefined && second === undefined && title !== only)
    refuse(`#${number} has one commit, so its title stays that commit's message: ${only}`);

  if (title === pr.title) {
    io.out(`#${number} unchanged\n`);
    return 0;
  }

  const edited = await run(
    io.cwd,
    ["gh", "pr", "edit", number, "--title", title],
    { write: true },
    io,
  );

  if (edited.code !== 0) refuse("gh pr edit failed");

  io.out(`#${number} retitled\n`);
  return 0;
}

export async function retitleVerb(
  args: readonly string[],
  usage: string,
  root: string,
  io: Io,
): Promise<number> {
  const [number, title, ...rest] = args;
  if (!number || !/^\d+$/.test(number) || title === undefined || rest.length) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    return await retitle(number, title, root, io);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`pr retitle: ${error.message}\n`);
    return 1;
  }
}
