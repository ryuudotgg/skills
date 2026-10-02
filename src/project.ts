import { readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { processIo, type Io } from "./io.ts";
import { describe, read, type Read, type ReadFailure } from "./read.ts";

type GitOptions = {
  timeout?: number;
  stderr?: "ignore" | "inherit";
  killSignal?: "SIGKILL" | "SIGTERM";
  quiet?: boolean;
};

export function gitRead(
  cwd: string,
  args: readonly string[],
  { timeout = 2000 }: { timeout?: number } = {},
  io: Io = processIo(),
): Promise<Read> {
  return read(["git", ...args], { cwd, env: io.env, deadline: timeout });
}

export async function defaultBranch(
  cwd: string,
  io: Io = processIo(),
): Promise<{ ok: true; branch: string } | { ok: false; failure?: ReadFailure }> {
  const result = await gitRead(
    cwd,
    ["ls-remote", "--symref", "origin", "HEAD"],
    { timeout: 60_000 },
    io,
  );

  if (!result.ok) return { ok: false, failure: result.failure };
  if (result.code !== 0) return { ok: false };

  const branch = result.stdout
    .split("\n")
    .find((line) => line.split(/\s+/)[0] === "ref:")
    ?.split(/\s+/)[1]
    ?.replace(/^refs\/heads\//, "");

  return branch ? { ok: true, branch } : { ok: false };
}

export async function gitOutput(
  cwd: string,
  args: readonly string[],
  { timeout = 2000, stderr = "ignore", quiet = false }: GitOptions = {},
  io: Io = processIo(),
): Promise<string | undefined> {
  const result = await gitRead(cwd, args, { timeout }, io);
  if (stderr === "inherit") io.err(result.stderr);
  if (!result.ok) {
    if (!quiet) io.err(describe(result.failure) + "\n");
    return undefined;
  }

  return result.code === 0 ? result.stdout : undefined;
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

type Checkout = { inside: boolean; repo: string; candidates: string[] };

export async function readCheckout(
  cwd: string,
  quiet = false,
  io: Io = processIo(),
): Promise<Checkout> {
  const output = await gitOutput(
    cwd,
    ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
    { quiet },
    io,
  );

  const [top, common] = output?.split("\n") ?? [];
  const repo = basename(top || cwd);
  const main = common
    ? basename(common) === ".git"
      ? basename(dirname(common))
      : basename(common).replace(/\.git$/, "")
    : "";

  return { inside: Boolean(top), repo, candidates: main && main !== repo ? [repo, main] : [repo] };
}

export async function checkoutIs(
  cwd: string,
  project: string,
  io: Io = processIo(),
): Promise<string | undefined> {
  const checkout = await readCheckout(cwd, false, io);
  if (!checkout.inside) return `not inside a git repository, not a checkout of ${project}`;
  if (checkout.candidates.some((name) => asciiLower(name) === asciiLower(project)))
    return undefined;

  return `this checkout is ${checkout.repo}, not a checkout of ${project}`;
}

export async function detectProject(
  cwd: string,
  plansDir: string,
  quiet = false,
): Promise<string | undefined> {
  const { candidates } = await readCheckout(cwd, quiet);

  let entries: string[];
  try {
    entries = readdirSync(plansDir)
      .filter((name) => !name.startsWith("."))
      .sort();
  } catch {
    return undefined;
  }

  for (const candidate of candidates)
    for (const name of entries) {
      if (asciiLower(name) !== asciiLower(candidate)) continue;

      try {
        if (statSync(`${plansDir}/${name}`).isDirectory()) return name;
      } catch {}
    }

  return undefined;
}
