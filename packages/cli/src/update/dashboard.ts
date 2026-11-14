import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { withLock } from "../lock.ts";
import { describe, read, type ReadFailure } from "../read.ts";
import { agentsDir } from "./notice.ts";
import { type Asset, releaseAssets, releaseProblem, trustedRepository } from "./release.ts";

export type Fetched =
  | { kind: "installed" }
  | { kind: "present" }
  | { kind: "refused"; reason: string };

export const dashboardAsset = (version: string) => `skills-dashboard-${version}.tar.gz`;
export const sumsAsset = "SHA256SUMS";

export function dashboardDir(env: NodeJS.ProcessEnv, version: string): string | undefined {
  const agents = agentsDir(env);
  return agents === undefined ? undefined : join(dirname(agents), "dashboard", version);
}

export function expectedSum(sums: string, name: string): string | undefined {
  for (const line of sums.split("\n")) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/i.exec(line.trimEnd());
    if (match?.[2] === name) return match[1]!.toLowerCase();
  }

  return undefined;
}

type Gh = { ok: true; stdout: string; bytes: Uint8Array } | { ok: false; detail: string };

const deadline = 120_000;
function failed(failure: ReadFailure): string {
  if (failure.kind === "spawn") return "gh is not installed";
  if (failure.kind === "deadline") return `gh timed out after ${deadline / 1000} s, offline?`;
  return describe(failure);
}

async function gh(args: readonly string[], env: NodeJS.ProcessEnv): Promise<Gh> {
  const result = await read(["gh", "api", "--hostname", "github.com", ...args], { env, deadline });
  if (!result.ok) return { ok: false, detail: failed(result.failure) };
  if (result.code === 0) return { ok: true, stdout: result.stdout, bytes: result.bytes };

  const detail =
    result.stderr.split("\n").find((line) => line.trim()) ?? `gh exited ${result.code}`;

  return { ok: false, detail: detail.trim() };
}

function sweepScratch(root: string): void {
  const stale = Date.now() - 2 * deadline;
  for (const name of readdirSync(root).filter((name) => name.startsWith(".fetch-")))
    try {
      if (statSync(join(root, name)).mtimeMs < stale)
        rmSync(join(root, name), { recursive: true, force: true });
    } catch {}
}

function place(build: string, target: string): Promise<Fetched> {
  return withLock(join(dirname(dirname(target)), ".dashboard.lock"), "dashboard install", () => {
    if (existsSync(join(target, "index.html"))) return { kind: "present" };

    rmSync(target, { recursive: true, force: true });
    renameSync(build, target);

    return { kind: "installed" };
  });
}

export async function installDashboard(
  version: string,
  env: NodeJS.ProcessEnv,
  release?: string,
): Promise<Fetched> {
  const refused = (reason: string): Fetched => ({ kind: "refused", reason });

  const target = dashboardDir(env, version);
  if (target === undefined) return refused("HOME is not set");
  if (existsSync(join(target, "index.html"))) return { kind: "present" };

  const tag = `v${version}`;
  if (release === undefined) {
    const read = await gh([`repos/${trustedRepository}/releases/tags/${tag}`], env);
    if (!read.ok) return refused(`cannot read the release of ${tag}: ${read.detail}`);
    release = read.stdout;
  }

  const problem = releaseProblem(tag, release);
  if (problem) return refused(problem);

  const name = dashboardAsset(version);
  const assets = releaseAssets(release);

  const tarball = assets.find((asset) => asset.name === name);
  const sums = assets.find((asset) => asset.name === sumsAsset);
  if (!tarball) return refused(`${name} is missing from the ${tag} release`);
  if (!sums) return refused(`${sumsAsset} is missing from the ${tag} release`);

  const download = (asset: Asset) =>
    gh(
      [
        "--header",
        "Accept: application/octet-stream",
        `repos/${trustedRepository}/releases/assets/${asset.id}`,
      ],
      env,
    );

  let scratch: string | undefined;
  try {
    const root = dirname(target);
    mkdirSync(root, { recursive: true });
    sweepScratch(root);
    scratch = mkdtempSync(join(root, ".fetch-"));

    const packed = await download(tarball);
    if (!packed.ok) return refused(`cannot download ${tarball.name}: ${packed.detail}`);

    const listed = await download(sums);
    if (!listed.ok) return refused(`cannot download ${sums.name}: ${listed.detail}`);

    const expected = expectedSum(listed.stdout, name);
    if (!expected) return refused(`${sumsAsset} has no sha256 for ${name}`);

    if (new Bun.CryptoHasher("sha256").update(packed.bytes).digest("hex") !== expected)
      return refused(`${name} does not match its sha256 in ${sumsAsset}`);

    const build = join(scratch, "build");
    mkdirSync(build);
    await new Bun.Archive(packed.bytes).extract(build);
    if (!existsSync(join(build, "index.html"))) return refused(`${name} holds no index.html`);

    return await place(build, target);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return refused(`cannot install ${name}: ${message.split("\n", 1)[0]}`);
  } finally {
    if (scratch !== undefined)
      try {
        rmSync(scratch, { recursive: true, force: true });
      } catch {}
  }
}
