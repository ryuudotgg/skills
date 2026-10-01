import { readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";

type GitOptions = { timeout?: number; stderr?: "ignore" | "inherit"; killSignal?: "SIGKILL" | "SIGTERM" };

export async function gitOutput(
  cwd: string,
  args: readonly string[],
  { timeout = 2000, stderr = "ignore", killSignal = "SIGKILL" }: GitOptions = {},
): Promise<string | undefined> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr,
      timeout,
      killSignal,
    });

    const [output, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

type Checkout = { inside: boolean; repo: string; candidates: string[] };

export async function readCheckout(cwd: string): Promise<Checkout> {
  const output = await gitOutput(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
    "--git-common-dir",
  ]);

  const [top, common] = output?.split("\n") ?? [];
  const repo = basename(top || cwd);
  const main = common
    ? basename(common) === ".git"
      ? basename(dirname(common))
      : basename(common).replace(/\.git$/, "")
    : "";

  return { inside: Boolean(top), repo, candidates: main && main !== repo ? [repo, main] : [repo] };
}

export async function checkoutIs(cwd: string, project: string): Promise<string | undefined> {
  const checkout = await readCheckout(cwd);
  if (!checkout.inside) return `not inside a git repository, not a checkout of ${project}`;
  if (checkout.candidates.some((name) => asciiLower(name) === asciiLower(project))) return undefined;

  return `this checkout is ${checkout.repo}, not a checkout of ${project}`;
}

export async function detectProject(cwd: string, plansDir: string): Promise<string | undefined> {
  const { candidates } = await readCheckout(cwd);

  let entries: string[];
  try {
    entries = readdirSync(plansDir).filter((name) => !name.startsWith(".")).sort();
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
