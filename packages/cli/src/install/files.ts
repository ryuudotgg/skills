import { lstatSync, readFileSync, readlinkSync, realpathSync, statSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDirectory, isFile } from "../io.ts";
import { gitOutput } from "../project.ts";
import { resolveTarget, writeAtomic } from "./settings-file.ts";

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

export type Snapshot = { target: string; bytes: Buffer | undefined };

export function snapshot(path: string): Snapshot | undefined {
  try {
    const target = resolveTarget(path);
    const stats = statSync(target, { throwIfNoEntry: false });
    if (!stats) return { target, bytes: undefined };

    return stats.isFile() ? { target, bytes: readFileSync(target) } : undefined;
  } catch {
    return undefined;
  }
}

export function holds(path: string, judged: Snapshot): boolean {
  try {
    if (resolveTarget(path) !== judged.target) return false;
    if (judged.bytes === undefined) return !lstatSync(judged.target, { throwIfNoEntry: false });
    return holdsBytes(judged.target, judged.bytes);
  } catch {
    return false;
  }
}

function holdsBytes(path: string, bytes: Uint8Array): boolean {
  try {
    return readFileSync(path).equals(bytes);
  } catch {
    return false;
  }
}

export function placeAgent(
  source: string,
  destination: string,
  judged: Snapshot,
): "written" | "changed" | "failed" {
  const current = () => holds(destination, judged);
  try {
    if (!isDirectory(dirname(judged.target))) return "failed";

    const metadata = judged.bytes === undefined ? source : judged.target;
    const content = readFileSync(source);
    const mode = statSync(metadata).mode & 0o7777;
    return writeAtomic(judged.target, content, mode, metadata, current) ? "written" : "changed";
  } catch {
    return current() ? "failed" : "changed";
  }
}

export async function history(repo: string, alsoShipped?: string) {
  const inside =
    (await gitOutput(repo, ["rev-parse", "--show-toplevel"], { quiet: true }))?.trimEnd() ===
    realpathSync(repo);

  const complete =
    inside &&
    (await gitOutput(repo, ["rev-parse", "--is-shallow-repository"]))?.trimEnd() === "false";

  const shippedTip =
    inside && alsoShipped && /^[0-9a-f]{40,64}$/.test(alsoShipped)
      ? (
          await gitOutput(repo, ["rev-parse", "--verify", "--quiet", `${alsoShipped}^{commit}`])
        )?.trimEnd()
      : undefined;

  const revisions = shippedTip ? ["HEAD", shippedTip] : [];
  const versions = new Map<string, string | undefined>();
  const unmatched = complete
    ? "matches no version this repo committed"
    : "differs from this checkout, which has no full git history to recognise an older copy";

  const shipped = async (path: string, file: string): Promise<Snapshot | undefined> => {
    const judged = snapshot(file);
    if (judged?.bytes === undefined) return undefined;
    if (holdsBytes(join(repo, path), judged.bytes)) return judged;
    if (!inside) return undefined;

    const plain = (await gitOutput(repo, ["hash-object", "--no-filters", "--", file]))?.trimEnd();
    const filtered = (
      await gitOutput(repo, ["hash-object", `--path=${path}`, "--", file])
    )?.trimEnd();

    if (!plain || !filtered) return undefined;
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
            ...revisions,
            "--",
            `:(literal)${path}`,
          ],
          { timeout: 30_000 },
        ),
      );

    const owned = (versions.get(path) ?? "").split("\n").some((line) => {
      if (!line.startsWith(":")) return false;
      const fields = line.split(/\s+/);
      return [fields[2], fields[3]].some((hash) => hash === plain || hash === filtered);
    });

    return owned ? judged : undefined;
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

    const added = shippedTip
      ? await gitOutput(
          repo,
          [
            "diff-tree",
            "-r",
            "--no-renames",
            "--name-only",
            "--diff-filter=D",
            shippedTip,
            "HEAD",
            "--",
            pattern,
          ],
          { timeout: 30_000 },
        )
      : undefined;

    return [...new Set(`${output ?? ""}\n${added ?? ""}`.split("\n").filter(Boolean))].sort();
  };

  return { unmatched, shipped, deleted };
}

export function removeOwned(path: string, agents: string): boolean {
  if (!ownedLink(path, agents)) return false;
  unlinkSync(path);
  return true;
}
