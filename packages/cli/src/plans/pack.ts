import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  lutimesSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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

async function extractFlags(env: NodeJS.ProcessEnv): Promise<string[]> {
  const version = await read(["tar", "--version"], { env, deadline: 5_000 });
  if (!version.ok || version.code !== 0) failed("tar --version", version);

  const common = ["--no-same-owner", "--no-same-permissions", "--no-xattrs", "--no-acls"];
  return version.stdout.includes("bsdtar")
    ? [...common, "--no-fflags", "--no-mac-metadata"]
    : common;
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

export function scratchFor(id: string, prefix = "move-"): string {
  const parent = join("/tmp", `plans-${id}`);
  mkdirSync(parent, { recursive: true, mode: 0o700 });

  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0)
    throw new PackRefusal(`${parent} is not a private directory of this user, remove it first`);

  return mkdtempSync(join(parent, prefix));
}

function byPath(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
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

    members.sort(byPath);

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

    all.sort(byPath);

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

export const UNVERIFIED = "pack sha256 does not match its moved record";

export type Manifest = {
  readonly project: string;
  readonly id: string;
  readonly slug: string;
  readonly branch: string;
  readonly base: { readonly ref: string; readonly sha: string };
  readonly head: string;
};

export type Opened = {
  readonly manifest: Manifest;
  readonly bundle: string | undefined;
  readonly prerequisites: readonly string[];
  readonly patch: string;
  readonly resume: string;
  readonly untracked: readonly string[];
  readonly root: string;
};

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

const TOP = new Set(["pack.json", "commits.bundle", "tracked.patch", "resume.md"]);

function texts(...values: unknown[]): boolean {
  return values.every((value) => typeof value === "string" && value !== "");
}

function fieldsOf(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parsed(path: string): Record<string, unknown> {
  try {
    return fieldsOf(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new PackRefusal(UNVERIFIED);
  }
}

function manifestOf(fields: Record<string, unknown>): Manifest {
  const { project, id, slug, branch, base, head } = fields;
  const { ref, sha } = fieldsOf(base);
  if (!texts(project, id, slug, branch, ref) || !SHA.test(String(sha)) || !SHA.test(String(head)))
    throw new PackRefusal(UNVERIFIED);

  return {
    project: project as string,
    id: id as string,
    slug: slug as string,
    branch: branch as string,
    base: { ref: ref as string, sha: sha as string },
    head: head as string,
  };
}

function walk(root: string): Member[] {
  const members: Member[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name).slice(root.length + 1);
    const untracked = path.startsWith("untracked/");
    if (entry.isDirectory() && (path === "untracked" || untracked)) continue;

    if (entry.isSymbolicLink() && untracked) {
      const target = readlinkSync(join(root, path));
      members.push({ path, digest: sha256(target), mode: "120000" });
      continue;
    }

    const stat = lstatSync(join(root, path));
    if (!entry.isFile() || stat.nlink > 1 || (!untracked && !TOP.has(path)))
      throw new PackRefusal(UNVERIFIED);

    if (path === "pack.json") continue;

    const bytes = readFileSync(join(root, path));
    const executable = untracked && stat.mode & 0o111;
    members.push({ path, digest: sha256(bytes), mode: executable ? "100755" : "100644" });
  }

  return members.sort(byPath);
}

function zeros(bytes: Uint8Array): boolean {
  return bytes.every((byte) => byte === 0);
}

const USTAR_KINDS = new Set(["0", "\0", "2", "5"]);
function padded(bytes: Uint8Array): boolean {
  let at = 0;
  while (at + 512 <= bytes.length) {
    const header = bytes.subarray(at, at + 512);
    if (zeros(header)) return zeros(bytes.subarray(at));

    const kind = String.fromCharCode(header[156] ?? 0);
    const magic = new TextDecoder().decode(header.subarray(257, 262));
    if (magic !== "ustar" || !USTAR_KINDS.has(kind)) return false;

    const field = new TextDecoder().decode(header.subarray(124, 136)).replace(/\0.*$/s, "");
    const size = Number.parseInt(field.trim() || "0", 8);
    if (!Number.isSafeInteger(size) || size < 0) return false;

    const next = at + 512 + Math.ceil(size / 512) * 512;
    if (next > bytes.length || !zeros(bytes.subarray(at + 512 + size, next))) return false;

    at = next;
  }

  return at === bytes.length;
}

function bundleHeader(path: string): { prerequisites: string[]; refs: Map<string, string> } {
  const bytes = readFileSync(path);
  const end = bytes.indexOf("\n\n");
  const lines = new TextDecoder().decode(bytes.subarray(0, end < 0 ? 0 : end)).split("\n");
  const prerequisites: string[] = [];
  const refs = new Map<string, string>();
  for (const line of lines.slice(1))
    if (line.startsWith("-")) prerequisites.push(line.slice(1).split(" ")[0] ?? "");
    else if (!line.startsWith("@")) {
      const [sha = "", ref = ""] = line.split(" ");
      refs.set(ref, sha);
    }

  return { prerequisites, refs };
}

export async function openPack(
  file: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Opened> {
  if (!padded(readFileSync(file))) throw new PackRefusal(UNVERIFIED);

  mkdirSync(root);
  const quiet = { ...env, COPYFILE_DISABLE: "1" };
  const flags = await extractFlags(env);
  const result = await read(["tar", "-x", "-f", file, "-C", root, ...flags], {
    env: quiet,
    deadline: TAR_DEADLINE,
  });

  if (!result.ok || result.code !== 0) throw new PackRefusal(UNVERIFIED);

  const members = walk(root);
  const fields = parsed(join(root, "pack.json"));
  if (fields.format !== PACK_FORMAT)
    throw new PackRefusal(
      `pack format ${String(fields.format)} is not ${PACK_FORMAT}, run skills update on both machines`,
    );

  const paths = new Set(members.map((member) => member.path));
  const whole = paths.has("tracked.patch") && paths.has("resume.md");
  if (!whole || membersDigest(members) !== fields.sha256) throw new PackRefusal(UNVERIFIED);

  const manifest = manifestOf(fields);
  const bundle = paths.has("commits.bundle") ? join(root, "commits.bundle") : undefined;
  const header = bundle === undefined ? undefined : bundleHeader(bundle);
  const tip = header?.refs.get(`refs/heads/${manifest.branch}`) ?? manifest.base.sha;
  if (tip !== manifest.head || (header !== undefined && header.refs.size !== 1))
    throw new PackRefusal(UNVERIFIED);

  return {
    manifest,
    bundle,
    prerequisites: header?.prerequisites ?? [],
    patch: join(root, "tracked.patch"),
    resume: join(root, "resume.md"),
    untracked: members
      .filter((member) => member.path.startsWith("untracked/"))
      .map((member) => member.path.slice("untracked/".length)),
    root,
  };
}
