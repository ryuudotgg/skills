import { readFileSync } from "node:fs";
import { join } from "node:path";
import { git } from "./notes.ts";

export type VersionPr = {
  cwd: string;
  repo: string;
  token: string;
  branch: string;
  base: string;
  title: string;
  body: string;
  fetch?: typeof fetch;
};

type TreeEntry = {
  path: string;
  mode: string;
  type: "blob";
  sha: string | null;
};

type Staged = {
  path: string;
  mode: string;
  deleted: boolean;
};

export function stagedChanges(cwd: string): Staged[] {
  git(cwd, ["add", "-A"]);

  const fields = git(cwd, ["diff", "--cached", "--raw", "-z", "--no-renames", "HEAD"]).split("\0");
  const changes: Staged[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode] = fields[index]!.slice(1).split(" ");
    const deleted = /^0+$/.test(newMode!);
    changes.push({ path: fields[index + 1]!, mode: deleted ? oldMode! : newMode!, deleted });
  }

  return changes;
}

export async function openVersionPr(options: VersionPr): Promise<{ commit: string; pr: number }> {
  const { cwd, repo, branch, base, title, body } = options;
  async function api<T>(method: string, path: string, payload?: unknown): Promise<T> {
    const response = await (options.fetch ?? fetch)(`https://api.github.com/repos/${repo}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });

    if (!response.ok)
      throw new Error(`${method} ${path} failed with ${response.status}: ${await response.text()}`);

    return (await response.json()) as T;
  }

  const parent = git(cwd, ["rev-parse", "HEAD"]).trim();
  const changes = stagedChanges(cwd);
  if (!changes.length)
    throw new Error("The version run changed no files, so there is no version PR to open");

  const tree: TreeEntry[] = [];
  for (const { path, mode, deleted } of changes) {
    if (deleted) {
      tree.push({ path, mode, type: "blob", sha: null });
      continue;
    }

    const content = readFileSync(join(cwd, path)).toString("base64");
    const blob = await api<{ sha: string }>("POST", "/git/blobs", { content, encoding: "base64" });
    tree.push({ path, mode, type: "blob", sha: blob.sha });
  }

  const created = await api<{ sha: string }>("POST", "/git/trees", {
    base_tree: git(cwd, ["rev-parse", "HEAD^{tree}"]).trim(),
    tree,
  });

  // Only a commit created through the API comes back signed by GitHub, and every branch requires signatures.
  const commit = await api<{ sha: string }>("POST", "/git/commits", {
    message: title,
    tree: created.sha,
    parents: [parent],
  });

  const signed = await api<{ commit: { verification?: { verified: boolean } } }>(
    "GET",
    `/commits/${commit.sha}`,
  );

  if (!signed.commit.verification?.verified)
    throw new Error(`GitHub did not sign the version commit ${commit.sha}`);

  const [owner] = repo.split("/");
  const branches = await api<{ ref: string }[]>("GET", `/git/matching-refs/heads/${branch}`);
  if (branches.some(({ ref }) => ref === `refs/heads/${branch}`))
    await api("PATCH", `/git/refs/heads/${branch}`, { sha: commit.sha, force: true });
  else await api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha });

  const query = new URLSearchParams({ head: `${owner}:${branch}`, base, state: "open" });
  const [open] = await api<{ number: number }[]>("GET", `/pulls?${query}`);
  const pr = open
    ? await api<{ number: number }>("PATCH", `/pulls/${open.number}`, { title, body })
    : await api<{ number: number }>("POST", "/pulls", { title, body, head: branch, base });

  return { commit: commit.sha, pr: pr.number };
}
