import { semver } from "bun";
import { dirname, join } from "node:path";

export const trustedRepository = "ryuudotgg/skills";

export type Tag = { tag: string; version: string; sha: string };
export type Advertisement = { defaultBranch: string; tags: readonly Tag[] };
export type Release = Tag & { url: string };
export type Outcome =
  | { kind: "updated"; from: string; to: Release }
  | { kind: "available"; to: Release }
  | { kind: "current"; version: string }
  | { kind: "refused"; reason: string };

const versionTag = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function trustedOrigin(url: string): boolean {
  return /^(?:https:\/\/github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)ryuudotgg\/skills(?:\.git)?\/?$/i.test(
    url,
  );
}

export function parseAdvertisement(text: string): Advertisement | undefined {
  const defaultBranch = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(text)?.[1];
  if (!defaultBranch) return undefined;

  const shas = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{40,64})\trefs\/tags\/(\S+?)(\^\{\})?$/.exec(line);
    if (!match) continue;
    if (match[3] || !shas.has(match[2]!)) shas.set(match[2]!, match[1]!);
  }

  const tags = [...shas].flatMap(([tag, sha]) => {
    const version = versionTag.exec(tag)?.[1];
    return version ? [{ tag, version, sha }] : [];
  });

  return { defaultBranch, tags };
}

export function pickCandidate(tags: readonly Tag[], current: string): Tag | undefined {
  return tags
    .filter((tag) => semver.order(tag.version, current) > 0)
    .sort((left, right) => semver.order(right.version, left.version))[0];
}

function field(json: string, path: readonly string[]): unknown {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return undefined;
  }

  for (const key of path)
    value =
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;

  return value;
}

export function readRelease(tag: Tag, json: string): Release | { reason: string } {
  if (field(json, ["tag_name"]) !== tag.tag) return { reason: `${tag.tag} has no release` };
  if (field(json, ["draft"]) !== false) return { reason: `${tag.tag} is a draft release` };
  if (field(json, ["prerelease"]) !== false) return { reason: `${tag.tag} is a prerelease` };

  if (typeof field(json, ["published_at"]) !== "string")
    return { reason: `${tag.tag} release is not published` };

  const url = `https://github.com/${trustedRepository}/releases/tag/${tag.tag}`;
  if (field(json, ["html_url"]) !== url) return { reason: `${tag.tag} release is not at ${url}` };

  return { ...tag, url };
}

export function verifiedCommit(sha: string, json: string): boolean {
  return (
    field(json, ["sha"]) === sha && field(json, ["commit", "verification", "verified"]) === true
  );
}

export function updateLine(outcome: Outcome): string {
  switch (outcome.kind) {
    case "updated":
      return `updated v${outcome.from} -> ${outcome.to.tag} ${outcome.to.url}`;

    case "available":
      return `available ${outcome.to.tag} ${outcome.to.url}`;

    case "current":
      return `current v${outcome.version}`;

    case "refused":
      return `refused ${outcome.reason}`;
  }
}

export function updateLock(env: NodeJS.ProcessEnv): string {
  return join(dirname(env.AGENTS_DIR || `${env.HOME ?? ""}/.agents/skills`), ".skills-update.lock");
}
