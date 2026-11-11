import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { MAX_FILE_SIZE } from "skills-core";
import { describe, read, type Read } from "../read.ts";

export const PACK_FORMAT = 1;

const GIT_DEADLINE = 60_000;

const TAR_DEADLINE = 120_000;

export const MAX_PACK = MAX_FILE_SIZE;

export type PackInput = {
  readonly project: string;
  readonly id: string;
  readonly slug: string;
  readonly branch: string;
  readonly checkout: string;
  readonly base: { readonly ref: string; readonly sha: string };
  readonly source: { readonly device: string; readonly label: string };
  readonly to: string | null;
  readonly threads: readonly string[] | undefined;
  readonly sessions: readonly string[] | undefined;
  readonly resume: string;
};

export type Pack = {
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly head: string;
  readonly commits: number;
  readonly changed: number;
  readonly untracked: number;
};

export class PackRefusal extends Error {
  override name = "PackRefusal";
}

type Member = { readonly path: string; readonly digest: string; readonly mode: string };

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function failed(what: string, result: Read): never {
  if (!result.ok) throw new PackRefusal(`${what} failed: ${describe(result.failure)}`);
  throw new PackRefusal(`${what} failed: ${result.stderr.trim() || `exit ${result.code}`}`);
}

async function git(
  checkout: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Uint8Array> {
  const result = await read(["git", ...args], { cwd: checkout, env, deadline: GIT_DEADLINE });
  if (!result.ok || result.code !== 0)
    failed(`git ${args[0] === "-c" ? args[2] : args[0]}`, result);

  return result.bytes;
}

async function gitText(
  checkout: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new TextDecoder().decode(await git(checkout, args, env));
}

function paths(output: string): string[] {
  return output.split("\0").filter(Boolean);
}

function mtimeOf(path: string): number {
  try {
    return lstatSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function fitsUstar(path: string): boolean {
  const size = (text: string) => Buffer.byteLength(text);
  if (size(path) <= 100) return true;

  return [...path.matchAll(/\//g)].some(
    ({ index }) => size(path.slice(0, index)) <= 155 && size(path.slice(index + 1)) <= 100,
  );
}

function sizeOf(checkout: string, path: string): number {
  try {
    return lstatSync(join(checkout, path)).size;
  } catch {
    return 0;
  }
}

function checkUntracked(checkout: string, untracked: readonly string[], patch: number): void {
  for (const path of untracked) {
    if (path.endsWith("/"))
      throw new PackRefusal(`untracked ${path} is a nested repository, commit or remove it first`);

    if (!fitsUstar(`untracked/${path}`))
      throw new PackRefusal(`untracked ${path} has a path too long for the pack, rename it first`);
  }

  const sizes = untracked.map((path) => ({ path, size: sizeOf(checkout, path) }));
  const total = sizes.reduce((sum, entry) => sum + entry.size, patch);
  if (total <= MAX_PACK) return;

  const largest = sizes.toSorted((left, right) => right.size - left.size)[0];
  const named = largest ? `, the largest is untracked ${largest.path}` : "";
  throw new PackRefusal(`the work is over ${MAX_PACK / 1024 / 1024} MiB${named}`);
}

function stageUntracked(checkout: string, stage: string, path: string): Member {
  const from = join(checkout, path);
  const to = join(stage, "untracked", path);
  mkdirSync(dirname(to), { recursive: true });

  const stat = lstatSync(from);
  if (stat.isSymbolicLink()) {
    const target = readlinkSync(from);
    if (Buffer.byteLength(target) > 100)
      throw new PackRefusal(`untracked ${path} links to a target too long for the pack`);

    symlinkSync(target, to);
    return { path: `untracked/${path}`, digest: sha256(target), mode: "120000" };
  }

  if (!stat.isFile()) throw new PackRefusal(`untracked ${path} is not a file`);

  copyFileSync(from, to);
  chmodSync(to, stat.mode & 0o111 ? 0o755 : 0o644);
  const mode = stat.mode & 0o111 ? "100755" : "100644";
  return { path: `untracked/${path}`, digest: sha256(readFileSync(to)), mode };
}

function stageFile(stage: string, path: string, bytes: Uint8Array | string): Member {
  writeFileSync(join(stage, path), bytes);
  chmodSync(join(stage, path), 0o644);
  return { path, digest: sha256(bytes), mode: "100644" };
}

function membersDigest(members: readonly Member[]): string {
  return sha256(
    members.map((member) => `${member.mode} ${member.digest}  ${member.path}\n`).join(""),
  );
}

async function tarFlags(env: NodeJS.ProcessEnv): Promise<string[]> {
  const version = await read(["tar", "--version"], { env, deadline: 5_000 });
  if (!version.ok || version.code !== 0) failed("tar --version", version);

  const common = ["--format", "ustar", "--null", "-T"];
  if (version.stdout.includes("bsdtar"))
    return [
      "-n",
      "--uid",
      "0",
      "--gid",
      "0",
      "--uname",
      "",
      "--gname",
      "",
      "--no-xattrs",
      "--no-mac-metadata",
      "--no-fflags",
      "--no-acls",
      ...common,
    ];

  return [
    "--no-recursion",
    "--owner=0",
    "--group=0",
    "--numeric-owner",
    "--no-xattrs",
    "--no-acls",
    ...common,
  ];
}

async function tar(
  stage: string,
  members: readonly Member[],
  out: string,
  env: NodeJS.ProcessEnv,
): Promise<Uint8Array> {
  for (const member of members) lutimesSync(join(stage, member.path), 0, 0);

  const list = join(dirname(stage), "members");
  writeFileSync(list, members.map((member) => `${member.path}\0`).join(""));

  const flags = await tarFlags(env);
  const argv = ["tar", "-c", "-f", out, ...flags, list];
  const quiet = { ...env, COPYFILE_DISABLE: "1" };
  const result = await read(argv, { cwd: stage, env: quiet, deadline: TAR_DEADLINE });
  if (!result.ok || result.code !== 0) failed("tar", result);

  const bytes = readFileSync(out);
  if (bytes.length > MAX_PACK)
    throw new PackRefusal(`the pack is over ${MAX_PACK / 1024 / 1024} MiB`);

  return bytes;
}

const DIFF = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  "--binary",
  "HEAD",
];

type Work = {
  readonly patch: Uint8Array;
  readonly changed: string[];
  readonly untracked: string[];
};

async function readWork(checkout: string, env: NodeJS.ProcessEnv): Promise<Work> {
  return {
    patch: await git(checkout, DIFF, env),
    changed: paths(await gitText(checkout, ["diff", "--name-only", "-z", "HEAD"], env)),
    untracked: paths(
      await gitText(checkout, ["ls-files", "--others", "--exclude-standard", "-z"], env),
    ),
  };
}

function sourceDigest(checkout: string, path: string): string | undefined {
  try {
    const from = join(checkout, path);
    return lstatSync(from).isSymbolicLink()
      ? sha256(readlinkSync(from))
      : sha256(readFileSync(from));
  } catch {
    return undefined;
  }
}

async function sameWork(
  checkout: string,
  before: Work,
  copies: readonly Member[],
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  const after = await readWork(checkout, env);
  if (sha256(after.patch) !== sha256(before.patch)) return false;
  if (after.untracked.join("\0") !== before.untracked.join("\0")) return false;

  return copies.every(
    (copy) => sourceDigest(checkout, copy.path.slice("untracked/".length)) === copy.digest,
  );
}

function scratchFor(id: string): string {
  const parent = join("/tmp", `plans-${id}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new PackRefusal(`${parent} is not a private directory of this user, remove it first`);

  return mkdtempSync(join(parent, "move-"));
}

export async function buildPack(input: PackInput, env: NodeJS.ProcessEnv): Promise<Pack> {
  const { checkout, branch, base } = input;
  const scratch = scratchFor(input.id);
  try {
    const stage = join(scratch, "pack");
    mkdirSync(stage);

    const head = (await gitText(checkout, ["rev-parse", `refs/heads/${branch}`], env)).trim();
    const range = `${base.sha}..refs/heads/${branch}`;
    const commits = Number((await gitText(checkout, ["rev-list", "--count", range], env)).trim());

    const members: Member[] = [];
    if (commits > 0) {
      const bundle = join(stage, "commits.bundle");
      await git(checkout, ["-c", "pack.threads=1", "bundle", "create", "-q", bundle, range], env);
      chmodSync(bundle, 0o644);
      members.push({
        path: "commits.bundle",
        digest: sha256(readFileSync(bundle)),
        mode: "100644",
      });
    }

    const work = await readWork(checkout, env);
    const { patch, changed, untracked } = work;

    checkUntracked(checkout, untracked, patch.length);
    members.push(stageFile(stage, "tracked.patch", patch));

    const copies = untracked.map((path) => stageUntracked(checkout, stage, path));
    members.push(...copies);

    let note: Uint8Array;
    try {
      note = readFileSync(input.resume);
    } catch {
      throw new PackRefusal(`${input.resume} is missing, write the resume note first`);
    }

    members.push(stageFile(stage, "resume.md", note));

    const now = (
      await gitText(checkout, ["rev-parse", "HEAD", `refs/heads/${branch}`], env)
    ).trim();

    if (now !== `${head}\n${head}`)
      throw new PackRefusal(`${branch} moved while it was packed, run the move again`);

    if (!(await sameWork(checkout, work, copies, env)))
      throw new PackRefusal("the work changed while it was packed, run the move again");

    const committed = Number(
      (await gitText(checkout, ["log", "-1", "--format=%ct", head], env)).trim(),
    );

    const touched = [...changed, ...untracked].map((path) => mtimeOf(join(checkout, path)));
    const captured = new Date(Math.max(committed * 1000, ...touched.map(Math.floor))).toISOString();

    members.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const content = membersDigest(members);
    const manifest = {
      format: PACK_FORMAT,
      project: input.project,
      id: input.id,
      slug: input.slug,
      branch,
      base,
      head,
      source: input.source,
      captured,
      sha256: content,
      to: input.to,
      ...(input.threads === undefined ? {} : { threads: input.threads }),
      ...(input.sessions === undefined ? {} : { sessions: input.sessions }),
    };

    const all = [
      ...members,
      stageFile(stage, "pack.json", `${JSON.stringify(manifest, null, 2)}\n`),
    ];

    all.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

    const bytes = await tar(stage, all, join(scratch, "pack.tar"), env);
    return {
      bytes,
      sha256: sha256(bytes),
      head,
      commits,
      changed: changed.length,
      untracked: untracked.length,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
