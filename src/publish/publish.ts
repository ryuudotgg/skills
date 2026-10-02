import { readDelivery } from "../delivery.ts";
import {
  argumentsFor,
  commitStaged,
  git,
  messageProblem,
  run,
  selectedIndex,
  stageSelected,
  type ProcessResult,
} from "./commit.ts";
import { defaultBranch } from "../project.ts";
import { baseKey, parseBase } from "../stack/skills-base.ts";
import { clearGeneratedBody, registered, stackLayers, templateBody } from "./stack.ts";

const NETWORK = 60_000;

function ghRead(cwd: string, args: readonly string[]): Promise<ProcessResult> {
  return run(cwd, ["gh", ...args], { capture: true, timeout: NETWORK });
}

function ghWrite(cwd: string, args: readonly string[], capture = false): Promise<ProcessResult> {
  return run(cwd, ["gh", ...args], { capture, write: true });
}

function output(result: ProcessResult, reason: string): string {
  if (result.code !== 0) throw new Error(reason);
  return result.output.replace(/\n+$/, "");
}

async function openPr(cwd: string, branch: string): Promise<string> {
  return output(
    await ghRead(cwd, [
      "pr",
      "list",
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url // empty",
    ]),
    `gh pr list failed for ${branch}`,
  );
}

async function recordedBase(cwd: string, branch: string): Promise<string> {
  const result = await git(cwd, ["config", baseKey(branch)], { capture: true });
  const reason = `cannot read recorded base for ${branch}`;
  if (result.code === undefined) throw new Error(reason);

  const recorded = parseBase(branch, result.code, result.output);
  if (!recorded.ok) throw new Error(reason);

  return recorded.base ?? "";
}

async function publishStack(
  cwd: string,
  branch: string,
  trunk: string,
  prbase: string,
  title: string,
  existing: string,
): Promise<string> {
  const chain = [branch];

  let parent = prbase;
  while (parent !== trunk) {
    if (chain.includes(parent)) throw new Error(`cycle in recorded bases at ${parent}`);

    chain.unshift(parent);

    const base = await recordedBase(cwd, parent);
    if (!base) throw new Error(`ancestor ${parent} has no recorded base`);

    parent = base.replace(/^origin\//, "");
  }

  for (const layer of chain) {
    if (layer === branch) continue;
    if (!(await openPr(cwd, layer))) throw new Error(`ancestor ${layer} has no open PR`);
  }

  const gitDir = output(
    await git(cwd, ["rev-parse", "--absolute-git-dir"], { capture: true }),
    "cannot read git directory",
  );

  if (!registered(gitDir, branch))
    if (registered(gitDir, prbase)) {
      if ((await git(cwd, ["checkout", "--quiet", prbase], { write: true })).code !== 0)
        throw new Error("git checkout failed");

      if ((await ghWrite(cwd, ["stack", "add", branch])).code !== 0) {
        if ((await git(cwd, ["checkout", "--quiet", branch], { write: true })).code !== 0)
          throw new Error("git checkout failed");

        throw new Error("gh stack add failed");
      }

      const current = await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        capture: true,
      });

      if (current.code !== 0 || current.output.replace(/\n+$/, "") !== branch)
        throw new Error(`gh stack add did not check out ${branch}`);
    } else if ((await ghWrite(cwd, ["stack", "init", "--base", trunk, ...chain])).code !== 0)
      throw new Error("gh stack init failed");

  const view = output(await ghRead(cwd, ["stack", "view", "--json"]), "gh stack view failed");
  const layers = stackLayers(view);
  if (!layers) throw new Error("gh stack view failed");

  for (const layer of layers) {
    const remote = await git(cwd, ["ls-remote", "--exit-code", "origin", `refs/heads/${layer}`], {
      capture: true,
      timeout: NETWORK,
    });

    if (remote.code === 2) continue;
    if (remote.code !== 0) throw new Error(`cannot read origin/${layer}`);

    if (
      (
        await git(
          cwd,
          ["fetch", "--quiet", "origin", `+refs/heads/${layer}:refs/remotes/origin/${layer}`],
          { write: true },
        )
      ).code !== 0
    )
      throw new Error(`cannot fetch origin/${layer}`);

    const ancestor = await git(cwd, [
      "merge-base",
      "--is-ancestor",
      `refs/remotes/origin/${layer}`,
      `refs/heads/${layer}`,
    ]);

    if (ancestor.code === 1)
      throw new Error(`origin/${layer} has commits ${layer} lacks, rebase before publishing`);

    if (ancestor.code !== 0) throw new Error(`cannot compare origin/${layer} with ${layer}`);
  }

  if ((await ghWrite(cwd, ["stack", "submit", "--auto", "--open"])).code !== 0)
    throw new Error("gh stack submit failed");

  const url = await openPr(cwd, branch);
  if (!url) throw new Error(`gh stack submit opened no PR for ${branch}`);

  let clear = !existing;
  if (existing) {
    const body = output(
      await ghRead(cwd, ["pr", "view", url, "--json", "body", "--jq", ".body"]),
      "gh pr view failed",
    );

    clear = clearGeneratedBody(existing, body, undefined);
    if (!clear) {
      const root = output(
        await git(cwd, ["rev-parse", "--show-toplevel"], { capture: true }),
        "cannot read work tree root",
      );

      clear = clearGeneratedBody(existing, body, templateBody(root));
    }
  }

  if (
    (await ghWrite(cwd, ["pr", "edit", url, "--title", title, ...(clear ? ["--body", ""] : [])]))
      .code !== 0
  )
    throw new Error("gh pr edit failed");

  return url;
}

export async function publishVerb(
  args: readonly string[],
  usage: string,
  root: string,
): Promise<number> {
  const options = argumentsFor(args, "mt");
  const message = options?.options.get("m");
  if (!options || message === undefined || options.files.length === 0) {
    process.stderr.write(`usage: ${usage}\n`);
    return 2;
  }

  const parsed = { message, title: options.options.get("t"), files: options.files };
  try {
    for (const value of [parsed.message, ...(parsed.title === undefined ? [] : [parsed.title])]) {
      const problem = messageProblem(value);
      if (problem) throw new Error(problem);
    }

    if (readDelivery(root, process.env).mode !== "prs") throw new Error("delivery mode is not prs");

    const cwd = process.cwd();
    const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"], {
      capture: true,
      stderr: "ignore",
    });

    if (inside.code !== 0 || inside.output.replace(/\n+$/, "") !== "true")
      throw new Error("not inside a work tree");

    const branch = output(
      await git(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"], { capture: true }),
      "detached HEAD",
    );

    const remote = await defaultBranch(cwd);
    if (!remote.ok) throw new Error("cannot read the default branch of origin");

    const trunk = remote.branch;
    if (branch === trunk) throw new Error(`cannot publish the default branch ${trunk}`);

    const index = await selectedIndex(cwd, parsed.files);
    if ("reason" in index) throw new Error(index.reason);

    const base = await recordedBase(cwd, branch);
    const prbase = (base || `origin/${trunk}`).replace(/^origin\//, "");
    const baseref = prbase === trunk ? `origin/${trunk}` : prbase;
    const staging = await stageSelected(
      cwd,
      parsed.files,
      async (path) => {
        const touched = output(
          await git(
            cwd,
            ["log", "--format=", "--name-only", "-z", `${baseref}..HEAD`, "--", path],
            { capture: true },
          ),
          `cannot read changes since ${baseref}`,
        );

        return touched.length > 0;
      },
      index,
    );

    if (staging) throw new Error(staging);

    const committed = await commitStaged(cwd, parsed.message);
    if (typeof committed === "string") throw new Error(committed);

    const count = Number(
      output(
        await git(cwd, ["rev-list", "--count", `${baseref}..HEAD`], { capture: true }),
        `cannot read commits since ${baseref}`,
      ),
    );

    if (!Number.isSafeInteger(count) || count < 0)
      throw new Error(`cannot read commits since ${baseref}`);

    if (count === 0) throw new Error(`nothing to publish since ${baseref}`);
    if (count !== 1 && parsed.title === undefined)
      throw new Error(
        `branch has ${count} commits since ${baseref}, pass -t with a title covering it`,
      );

    const title =
      count === 1
        ? output(
            await git(cwd, ["log", "-1", "--format=%s"], { capture: true }),
            "cannot read commit title",
          )
        : (parsed.title ?? "");

    let url = await openPr(cwd, branch);
    const stack = await run(cwd, ["gh", "stack", "--version"], {
      capture: true,
      stderr: "ignore",
      timeout: NETWORK,
    });

    if (stack.code === undefined) throw new Error("gh stack --version failed");

    if (stack.code === 0 && prbase !== trunk)
      url = await publishStack(cwd, branch, trunk, prbase, title, url);
    else {
      if (
        (
          await git(
            cwd,
            ["push", "--quiet", "-u", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
            { write: true },
          )
        ).code !== 0
      )
        throw new Error("git push failed");

      if (!url) {
        const created = output(
          await ghWrite(
            cwd,
            ["pr", "create", "--base", prbase, "--head", branch, "--title", title, "--body", ""],
            true,
          ),
          "gh pr create failed",
        );

        url = created.split("\n").at(-1) ?? "";
        if (!url) throw new Error("gh pr create returned no URL");
      } else if ((await ghWrite(cwd, ["pr", "edit", url, "--title", title])).code !== 0)
        throw new Error("gh pr edit failed");
    }

    process.stdout.write(`${url}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`publish: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
