import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { gitOutput } from "../project.ts";
import { resolveTarget, writeAtomic } from "./codex-hooks.ts";

export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function sameFile(first: string, second: string): boolean {
  try {
    return readFileSync(first).equals(readFileSync(second));
  } catch {
    return false;
  }
}

export function ownedLink(path: string, agents: string): boolean {
  if (!lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) return false;

  const target = readlinkSync(path).replace(/\/$/, "");
  const name = basename(path);
  if (target === `${agents}/${name}`) return true;
  if (!target.startsWith("/") || !target.endsWith(`/skills/${name}`)) return false;

  const repo = target.slice(0, -`/skills/${name}`.length);
  return (
    isFile(join(repo, "install.sh")) &&
    (isFile(join(repo, "skills/playbook/bin/skills")) ||
      isFile(join(repo, "skills/playbook/scripts/delivery-mode.sh")))
  );
}

export function runsCheckout(path: string, expected: string): boolean {
  try {
    return realpathSync(path) === realpathSync(expected);
  } catch {
    return false;
  }
}

export function placeAgent(source: string, destination: string): boolean {
  try {
    const target = resolveTarget(destination);
    if (!isDirectory(dirname(target))) return false;

    const metadata = existsSync(target) ? target : source;
    writeAtomic(target, readFileSync(source), statSync(metadata).mode & 0o7777, metadata);

    return true;
  } catch {
    return false;
  }
}

export async function history(repo: string) {
  const inside =
    (await gitOutput(repo, ["rev-parse", "--show-toplevel"], { quiet: true }))?.trimEnd() ===
    realpathSync(repo);

  const complete =
    inside &&
    (await gitOutput(repo, ["rev-parse", "--is-shallow-repository"]))?.trimEnd() === "false";

  const versions = new Map<string, string | undefined>();
  const unmatched = complete
    ? "matches no version this repo committed"
    : "differs from this checkout, which has no full git history to recognise an older copy";

  const shipped = async (path: string, file: string): Promise<boolean> => {
    if (sameFile(join(repo, path), file)) return true;
    if (!inside || !isFile(file)) return false;

    const plain = (await gitOutput(repo, ["hash-object", "--no-filters", "--", file]))?.trimEnd();
    const filtered = (
      await gitOutput(repo, ["hash-object", `--path=${path}`, "--", file])
    )?.trimEnd();

    if (!plain || !filtered) return false;
    if (!versions.has(path))
      versions.set(
        path,
        await gitOutput(
          repo,
          [
            "-c",
            "log.follow=false",
            "log",
            "-m",
            "--full-history",
            "--no-renames",
            "--no-show-signature",
            "--format=",
            "--raw",
            "--no-abbrev",
            "--",
            `:(literal)${path}`,
          ],
          { timeout: 30_000 },
        ),
      );

    return (versions.get(path) ?? "").split("\n").some((line) => {
      if (!line.startsWith(":")) return false;
      const fields = line.split(/\s+/);
      return [fields[2], fields[3]].some((hash) => hash === plain || hash === filtered);
    });
  };

  const deleted = async (pattern: string): Promise<string[]> => {
    if (!inside) return [];

    const output = await gitOutput(
      repo,
      [
        "-c",
        "log.follow=false",
        "log",
        "-m",
        "--full-history",
        "--no-renames",
        "--no-show-signature",
        "--diff-filter=D",
        "--name-only",
        "--format=",
        "--",
        pattern,
      ],
      { timeout: 30_000 },
    );

    return [...new Set((output ?? "").split("\n").filter(Boolean))].sort();
  };

  return { unmatched, shipped, deleted };
}

export function removeOwned(path: string, agents: string): boolean {
  if (!ownedLink(path, agents)) return false;
  unlinkSync(path);
  return true;
}
