import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readDelivery } from "../delivery.ts";
import { ghOutput } from "../gh.ts";
import type { Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { defaultBranch } from "../project.ts";
import { git, OPERATIONS, read, Refusal, refuse, type Session } from "./restack.ts";

type Command =
  | { kind: "run"; pr: number; named: readonly string[] }
  | { kind: "continue" }
  | { kind: "abort" };

type Pull = {
  author: string;
  head: string;
  headOid: string;
  url: string;
  commits: readonly { oid: string; logins: readonly string[] }[];
};

type State = {
  pr: number;
  branch: string;
  tip: string;
  head: string;
  remaining: string[];
  stop?: { sha: string; kind: "picking" | "picked" | "conflict" | "failed"; paths?: string[] };
};

type Source = {
  sha: string;
  parents: number;
  email: string;
  encoded: boolean;
  subject: string;
  carried: string;
};

type Checkout = { s: Session; branch: string; path: string };

const resume = "skills takeover --continue, or skills takeover --abort";
const IDENTITY = /^(?:GIT_(?:AUTHOR_|COMMITTER_|CONFIG)|XDG_CONFIG_HOME$)/;
const LISTED = 100;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const RESETTABLE = new Set(["skills-takeover", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]);

function commandFor(args: readonly string[]): Command | undefined {
  if (args.length === 1 && args[0] === "--continue") return { kind: "continue" };
  if (args.length === 1 && args[0] === "--abort") return { kind: "abort" };

  const [pr, ...named] = args;
  if (!pr || !/^[1-9][0-9]*$/.test(pr) || named.some((sha) => !/^[0-9a-f]{7,40}$/.test(sha)))
    return undefined;

  return { kind: "run", pr: Number(pr), named };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function pullFrom(text: string): Pull | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }

  const fields = record(raw);
  const author = record(fields?.author)?.login;
  const head = fields?.headRefName;
  const headOid = fields?.headRefOid;
  const url = fields?.url;
  if (
    typeof author !== "string" ||
    typeof head !== "string" ||
    typeof headOid !== "string" ||
    typeof url !== "string" ||
    !Array.isArray(fields?.commits)
  )
    return undefined;

  const commits = [];
  for (const entry of fields.commits) {
    const oid = record(entry)?.oid;
    const authors = record(entry)?.authors;
    if (typeof oid !== "string" || !Array.isArray(authors)) return undefined;

    const logins = authors.map((each) => record(each)?.login);
    commits.push({ oid, logins: logins.map((login) => (typeof login === "string" ? login : "")) });
  }

  return { author, head, headOid, url, commits };
}

function selected(pull: Pull, pr: number, named: readonly string[]): string[] {
  if (!named.length) {
    const own = pull.commits.filter((commit) => commit.logins[0] === pull.author);
    if (!own.length) refuse(`PR ${pr} has no commits by ${pull.author}, name the shas to carry`);
    return own.map((commit) => commit.oid);
  }

  const wanted = new Set<string>();
  for (const sha of named) {
    const matches = pull.commits.filter((commit) => commit.oid.startsWith(sha));
    if (!matches.length) refuse(`${sha} is not a commit of PR ${pr}`);
    if (matches.length > 1) refuse(`${sha} names more than one commit of PR ${pr}`);
    wanted.add(matches[0]!.oid);
  }

  return [...wanted];
}

function ignored(commit: Source): string {
  return `an ignored file in this checkout sits where ${short(commit.sha)} ${commit.subject} adds one, move it`;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? "";
}

function names(text: string): string[] {
  return text.split("\0").filter(Boolean);
}

async function source(s: Session, sha: string): Promise<Source> {
  const run = await read(s, ["cat-file", "commit", sha], `cannot read commit ${short(sha)}`);
  const split = run.stdout.indexOf("\n\n");
  const headers = (split < 0 ? run.stdout : run.stdout.slice(0, split)).split("\n");
  const author = headers.find((line) => line.startsWith("author ")) ?? "";

  const raw = Buffer.from(run.bytes).toString("latin1");
  const rawSplit = raw.indexOf("\n\n");
  const rawAuthor = raw.split("\n").find((line) => line.startsWith("author ")) ?? "";
  return {
    sha,
    parents: headers.filter((line) => line.startsWith("parent ")).length,
    email: /<([^>]*)>/.exec(author)?.[1] ?? "",
    encoded: headers.some((line) => line.startsWith("encoding ")),
    subject: firstLine(split < 0 ? "" : run.stdout.slice(split + 2)),
    carried: `${rawAuthor}\n\n${rawSplit < 0 ? "" : raw.slice(rawSplit + 2)}`,
  };
}

async function paths(s: Session, sha: string): Promise<Set<string>> {
  const listed = await read(
    s,
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "--no-renames", "-r", "-z", sha],
    `cannot read the paths of ${short(sha)}`,
  );

  return new Set(names(listed.stdout));
}

async function touched(s: Session): Promise<string[]> {
  const listed = await read(
    s,
    ["diff", "--name-only", "--no-renames", "-z", "HEAD"],
    "cannot read tracked changes",
  );

  return names(listed.stdout);
}

async function tipOf(s: Session, ref: string): Promise<string> {
  return (await read(s, ["rev-parse", "--verify", ref], `cannot read ${ref}`)).stdout.trimEnd();
}

async function unmergedPaths(s: Session): Promise<string[]> {
  const { stdout } = await read(s, ["ls-files", "-u", "-z"], "cannot read unmerged paths");
  return [...new Set(names(stdout).map((line) => line.slice(line.indexOf("\t") + 1)))].sort();
}

async function changed(s: Session, args: readonly string[], reason: string): Promise<boolean> {
  return (await read(s, ["diff", "--quiet", ...args], reason, [0, 1])).code === 1;
}

function save(path: string, state: State): void {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(state)}\n`);
  renameSync(`${path}.tmp`, path);
}

function load(path: string): State | undefined {
  if (!existsSync(path)) return undefined;

  try {
    return JSON.parse(readFileSync(path, "utf8")) as State;
  } catch {
    return refuse(`cannot read ${path}, remove it to drop the stopped takeover`);
  }
}

async function checkout(io: Io): Promise<Checkout> {
  const probe: Session = { ...io, indexes: [], ownRows: new Set() };
  const top = await git(probe, ["rev-parse", "--show-toplevel"], { stderr: "capture" });
  if (top.code !== 0) refuse("not inside a work tree");

  const s: Session = { ...probe, cwd: top.stdout.trimEnd() };
  const current = await read(
    s,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    "cannot read HEAD",
    [0, 1],
  );

  if (current.code === 1) refuse("detached HEAD");

  const path = (
    await read(s, ["rev-parse", "--git-path", "skills-takeover"], "cannot read the git directory")
  ).stdout.trimEnd();

  return { s, branch: current.stdout.trimEnd(), path: resolve(s.cwd, path) };
}

function idle(c: Checkout, allowed: ReadonlySet<string> = new Set()): void {
  for (const operation of OPERATIONS)
    if (!allowed.has(operation) && existsSync(join(dirname(c.path), operation)))
      refuse(`${operation} in progress on ${c.branch}`);
}

async function ownEmail(s: Session): Promise<string> {
  const env = Object.fromEntries(Object.entries(s.env).filter(([name]) => !IDENTITY.test(name)));
  const run = await read({ ...s, env }, ["config", "user.email"], "cannot read user.email", [0, 1]);
  const email = run.stdout.trim().toLowerCase();
  if (!email) refuse("no user.email is set, so a takeover cannot tell your commits from theirs");

  return email;
}

async function land(c: Checkout, state: State, commit: Source, unchanged: string): Promise<void> {
  const staged = await changed(c.s, ["--cached"], "cannot read the staged change");
  if (staged) {
    // core.hooksPath, not --no-verify: prepare-commit-msg still runs under --no-verify and rewrites the author's message.
    const made = await git(
      c.s,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "commit",
        "--quiet",
        "--allow-empty-message",
        "--cleanup=verbatim",
        "-C",
        commit.sha,
      ],
      { write: true, stderr: "capture" },
    );

    if (made.code !== 0) {
      save(c.path, {
        ...state,
        stop: { sha: commit.sha, kind: "conflict", paths: await touched(c.s) },
      });

      refuse(
        `cannot commit ${short(commit.sha)} ${commit.subject}: ${firstLine(made.stderr)}, fix it, then ${resume}`,
      );
    }

    const parents = await read(c.s, ["rev-parse", "HEAD^@"], "cannot read the carried commit");
    if (
      parents.stdout.trimEnd() !== state.head ||
      (await source(c.s, "HEAD")).carried !== commit.carried
    ) {
      await git(c.s, ["reset", "--soft", "--quiet", state.head], { write: true });
      save(c.path, {
        ...state,
        stop: { sha: commit.sha, kind: "conflict", paths: await touched(c.s) },
      });

      refuse(
        `git changed the parents, author line or message of ${short(commit.sha)} ${commit.subject}, run skills takeover --abort`,
      );
    }
  } else
    for (const name of ["MERGE_MSG", "AUTO_MERGE"])
      rmSync(join(dirname(c.path), name), { force: true });

  state.head = await tipOf(c.s, "HEAD");
  state.remaining.shift();
  delete state.stop;
  save(c.path, state);

  c.s.out(
    staged
      ? `carried ${short(commit.sha)} ${commit.subject}\n`
      : `skipped ${short(commit.sha)} ${commit.subject}, ${unchanged}\n`,
  );
}

async function carry(c: Checkout, state: State): Promise<number> {
  for (let sha = state.remaining[0]; sha; sha = state.remaining[0]) {
    const commit = await source(c.s, sha);
    if (await collides(c, commit)) {
      save(c.path, { ...state, stop: { sha, kind: "failed" } });
      refuse(`${ignored(commit)}, then ${resume}`);
    }

    save(c.path, { ...state, stop: { sha, kind: "picking" } });

    const picked = await git(c.s, ["cherry-pick", "-n", "--no-rerere-autoupdate", sha], {
      write: true,
      stderr: "capture",
    });

    if (picked.code !== 0) {
      const unmerged = await unmergedPaths(c.s);
      save(c.path, {
        ...state,
        stop: { sha, kind: unmerged.length ? "conflict" : "failed", paths: await touched(c.s) },
      });

      refuse(
        unmerged.length
          ? `stopped at ${short(sha)} ${commit.subject}: conflict in ${unmerged.join(" ")}, resolve it here, git add, then ${resume}`
          : `stopped at ${short(sha)} ${commit.subject}: ${firstLine(picked.stderr)}, fix it, then ${resume}`,
      );
    }

    save(c.path, { ...state, stop: { sha, kind: "picked", paths: await touched(c.s) } });
    await land(c, state, commit, `already on ${c.branch}`);
  }

  rmSync(c.path, { force: true });
  return 0;
}

async function caughtUp(c: Checkout, state: State): Promise<void> {
  const head = await tipOf(c.s, "HEAD");
  if (head === state.head) return;

  const next = state.remaining[0];
  const parents = (
    await read(c.s, ["rev-parse", "HEAD^@"], "cannot read the parents of HEAD")
  ).stdout.trimEnd();

  if (parents === state.head && next) {
    if ((await source(c.s, head)).carried === (await source(c.s, next)).carried) {
      state.head = head;
      state.remaining.shift();
      delete state.stop;
      save(c.path, state);
      return;
    }

    refuse(
      `${state.branch} gained ${short(head)} since the takeover stopped, run git reset --soft ${short(state.head)}, then ${resume}`,
    );
  }

  refuse(
    `${state.branch} moved from ${short(state.head)} to ${short(head)}, run skills takeover --abort`,
  );
}

function stopped(c: Checkout): State {
  const state = load(c.path);
  if (!state) refuse("no takeover is stopped on this checkout");
  if (state.branch !== c.branch)
    refuse(
      `the takeover stopped on ${state.branch}, switch back to it, or remove ${c.path} to drop it`,
    );

  return state;
}

async function ordered(c: Checkout, pull: Pull, pr: number, shas: string[]): Promise<string[]> {
  const listed = await read(
    c.s,
    ["rev-list", "--reverse", "--topo-order", pull.headOid],
    `cannot read the history of PR ${pr}`,
  );

  const order = new Map(listed.stdout.split("\n").map((sha, index) => [sha, index]));
  const stray = shas.find((sha) => !order.has(sha));
  if (stray) refuse(`${short(stray)} is not in the history of PR ${pr}'s head`);

  return shas.sort((left, right) => order.get(left)! - order.get(right)!);
}

function repository(url: string): string {
  const parts = url
    .replace(/\/pull\/\d+\/?$/, "")
    .replace(/\.git\/?$/, "")
    .split(/[/:]/)
    .filter(Boolean);

  return parts.slice(-2).join("/").toLowerCase();
}

async function remoteFor(c: Checkout, pull: Pull): Promise<string> {
  const wanted = repository(pull.url);
  const listed = await read(c.s, ["remote", "-v"], "cannot read the remotes");
  for (const line of listed.stdout.split("\n")) {
    const [name, url, role] = line.split(/\s+/);
    if (name && url && role === "(fetch)" && repository(url) === wanted) return name;
  }

  return "origin";
}

async function collides(c: Checkout, commit: Source): Promise<boolean> {
  const listed = await read(
    c.s,
    ["ls-files", "-z", "-o", "-i", "--exclude-standard", "--directory"],
    "cannot read ignored files",
  );

  const written = await read(
    c.s,
    [
      "diff",
      "-z",
      "--no-renames",
      "--name-only",
      "--diff-filter=d",
      commit.parents ? `${commit.sha}^` : EMPTY_TREE,
      commit.sha,
    ],
    `cannot read the paths of ${short(commit.sha)}`,
  );

  const ignored = names(listed.stdout).map((path) => path.replace(/\/$/, ""));
  return names(written.stdout).some((path) =>
    ignored.some((entry) => path === entry || path.startsWith(`${entry}/`)),
  );
}

async function fetched(c: Checkout, pull: Pull, pr: number, shas: readonly string[]) {
  const present = async () =>
    (
      await Promise.all(
        [pull.headOid, ...shas].map(
          async (sha) =>
            (await git(c.s, ["cat-file", "-e", `${sha}^{commit}`], { stderr: "ignore" })).code ===
            0,
        ),
      )
    ).every(Boolean);

  const remote = await remoteFor(c, pull);
  const sources = [
    [remote, `refs/pull/${pr}/head`],
    [remote, `refs/heads/${pull.head}`],
    [`${pull.url.replace(/\/pull\/\d+\/?$/, "")}.git`, `refs/pull/${pr}/head`],
  ];

  let failure = "";
  for (const [from, ref] of sources) {
    if (await present()) return;

    const run = await git(
      c.s,
      ["fetch", "--quiet", "--no-tags", "--no-write-fetch-head", "--refmap=", from!, ref!],
      { write: true, stderr: "capture" },
    );

    failure ||= firstLine(run.stderr);
  }

  if (!(await present()))
    refuse(`cannot fetch the commits of PR ${pr}${failure ? `: ${failure}` : ""}`);
}

async function start(c: Checkout, pr: number, named: readonly string[]): Promise<number> {
  const before = load(c.path);
  if (before) refuse(`a takeover of PR ${before.pr} is stopped on ${before.branch}, run ${resume}`);

  idle(c);

  const trunk = await defaultBranch(c.s.cwd, c.s);
  if (!trunk.ok) refuse("cannot read the default branch of origin");
  if (trunk.branch === c.branch)
    refuse(`${c.branch} is the default branch, take over on a branch of your own`);

  if (
    (
      await read(
        c.s,
        ["status", "--porcelain", "--untracked-files=no"],
        "cannot read tracked changes",
      )
    ).stdout.trim()
  )
    refuse("tracked changes");

  const own = await ownEmail(c.s);
  const user = (await ghOutput(["api", "user", "--jq", ".login"], c.s))?.trim();
  if (!user) refuse("cannot read the gh user");

  const text = await ghOutput(
    ["pr", "view", String(pr), "--json", "author,headRefName,headRefOid,commits,url"],
    c.s,
  );

  const pull = text === undefined ? undefined : pullFrom(text);
  if (!pull) refuse(`cannot read PR ${pr}`);
  if (pull.author === user)
    refuse(`PR ${pr} is yours, a takeover carries another author's commits`);

  if (pull.commits.length >= LISTED)
    refuse(`PR ${pr} lists ${LISTED} commits, the most gh returns, so some may be missing`);

  const picked = selected(pull, pr, named);
  const yours = pull.commits.find(
    (commit) => picked.includes(commit.oid) && commit.logins.includes(user),
  );

  if (yours) refuse(`${short(yours.oid)} names you, ${user}, among its authors`);

  await fetched(c, pull, pr, picked);

  const shas = await ordered(c, pull, pr, picked);
  for (const sha of shas) {
    const commit = await source(c.s, sha);
    if (commit.parents > 1) refuse(`${short(sha)} is a merge commit, name the commits around it`);
    if (commit.encoded) refuse(`${short(sha)} has an encoding header a carried commit cannot keep`);
    if (commit.email.toLowerCase() === own)
      refuse(`${short(sha)} is authored as ${commit.email}, which is you`);

    if (await collides(c, commit)) refuse(ignored(commit));
  }

  if (!named.length)
    for (const commit of pull.commits)
      if (!shas.includes(commit.oid))
        c.s.out(
          `left ${short(commit.oid)} ${(await source(c.s, commit.oid)).subject}, by ${commit.logins[0] || "an author GitHub cannot link"}\n`,
        );

  const tip = await tipOf(c.s, "HEAD");
  return carry(c, { pr, branch: c.branch, tip, head: tip, remaining: shas });
}

async function proceed(c: Checkout): Promise<number> {
  const state = stopped(c);
  idle(c, new Set(["skills-takeover"]));

  const unmerged = await unmergedPaths(c.s);
  if (unmerged.length)
    refuse(`unmerged paths: ${unmerged.join(" ")}, resolve them, git add, then ${resume}`);

  await caughtUp(c, state);

  if (await changed(c.s, [], "cannot read unstaged changes"))
    refuse(`unstaged changes, git add them, then ${resume}`);

  const next = state.remaining[0];
  const stop = state.stop?.sha === next ? state.stop?.kind : undefined;
  const staged = await changed(c.s, ["--cached"], "cannot read the staged change");
  if (next && (stop === "conflict" || stop === "picked" || (stop === "picking" && staged))) {
    const allowed = new Set([...(await paths(c.s, next)), ...(state.stop?.paths ?? [])]);
    const listed = await read(
      c.s,
      ["diff", "--cached", "--name-only", "--no-renames", "-z"],
      "cannot read the staged paths",
    );

    const stray = names(listed.stdout).find((name) => !allowed.has(name));
    if (stray) refuse(`${stray} is staged but ${short(next)} does not touch it, unstage it first`);

    await land(
      c,
      state,
      await source(c.s, next),
      stop === "conflict" ? "resolved to no change" : `already on ${c.branch}`,
    );
  } else if (staged)
    refuse(`staged changes the takeover did not make, unstage them, then ${resume}`);

  return carry(c, state);
}

async function abort(c: Checkout): Promise<number> {
  const state = stopped(c);
  idle(c, RESETTABLE);

  const dropped = await read(
    c.s,
    ["log", "--reverse", "--format=dropped %h %s", `${state.tip}..HEAD`],
    `cannot read the history of ${c.branch}`,
  );

  const picking = new Set([
    ...(state.stop ? await paths(c.s, state.stop.sha) : []),
    ...(state.stop?.paths ?? []),
  ]);

  const discarded = (await touched(c.s)).filter((name) => !picking.has(name));

  if ((await git(c.s, ["reset", "--hard", "--quiet", state.tip], { write: true })).code !== 0)
    refuse(`cannot reset ${c.branch} to ${short(state.tip)}`);

  rmSync(c.path, { force: true });
  c.s.out(
    `${dropped.stdout}${discarded.map((name) => `discarded ${name}\n`).join("")}${c.branch} back at ${short(state.tip)}\n`,
  );

  return 0;
}

export async function takeoverVerb(
  args: readonly string[],
  usage: string,
  root: string,
  io: Io,
): Promise<number> {
  const command = commandFor(args);
  if (!command) {
    io.err(`usage: ${usage}\n`);
    return 2;
  }

  try {
    if (command.kind !== "abort" && readDelivery(root, io.env).mode !== "prs")
      refuse("delivery mode is not prs");

    const c = await checkout(io);
    const locked = await tryLock(`${c.path}.lock`, () => {
      if (command.kind === "continue") return proceed(c);
      if (command.kind === "abort") return abort(c);
      return start(c, command.pr, command.named);
    });

    if (locked.held) refuse("another skills takeover runs in this checkout");
    return locked.value;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    io.err(`takeover: ${error.message}\n`);
    return 1;
  }
}
