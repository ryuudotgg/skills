import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Declaration } from "../reviewers/declaration.ts";
import { envSecrets, redact } from "../sessions/redact.ts";

export type OutgoingKind = "reply" | "PR";

export const disclosure = "An agent posted this on behalf of this account.";
export function disclose(body: string): string {
  return `${disclosure}\n\n${body}`;
}

export type Outgoing = {
  kind: OutgoingKind;
  body: string;
  env: NodeJS.ProcessEnv;
  directory: string;
  reviewers: readonly Pick<Declaration, "displayName" | "handles">[];
};

const planId =
  /(^|[^\p{L}\p{N}_])(plan\s*#?\s*[0-9]+|plans\s*#?\s*[0-9]+\s*(,|and|or)\s*#?\s*[0-9]+)([^\p{L}\p{N}_]|$)/iu;

const tokenEdges = /^["'`()[\]{}<>,;:.!?]+|["'`()[\]{}<>,;:.!?]+$/gu;

const marker = /\[redacted:([a-z0-9-]+)\]/gu;

const pathStart = /(?<=[[({<="'`,;])/u;
function homePath(body: string, home: string): string | undefined {
  for (const raw of body.split(/\s+/u))
    for (const piece of raw.split(pathStart)) {
      const token = piece.replace(tokenEdges, "");
      if (home && (token === home || token.startsWith(`${home}/`))) return token;
      if (/^\/(?:Users|home)\/./u.test(token) || token.startsWith("~/")) return token;
    }

  return undefined;
}

function upToRepo(directory: string): string[] {
  const directories: string[] = [];
  for (let at = resolve(directory); ; at = dirname(at)) {
    directories.push(at);
    if (existsSync(join(at, ".git"))) return directories;
    if (dirname(at) === at) return [resolve(directory)];
  }
}

function tokenAt(line: string, at: number): number {
  return (
    line.slice(0, at).split(/\s+/u).filter(Boolean).length -
    (/\S$/u.test(line.slice(0, at)) ? 1 : 0)
  );
}

function sameToken(body: string, redacted: string, at: number): string {
  const line = redacted.slice(0, at).split("\n").length - 1;
  const start = redacted.lastIndexOf("\n", at - 1) + 1;
  const changed = redacted.slice(start).split("\n")[0]!;

  const original = body.split("\n")[line] ?? "";
  const tokens = original.split(/\s+/u).filter(Boolean);
  if (tokens.length !== changed.split(/\s+/u).filter(Boolean).length) return original.trim();

  return tokens[tokenAt(changed, at - start)]?.replace(tokenEdges, "") ?? original.trim();
}

function firstSecret(
  body: string,
  redacted: string,
  secrets: readonly string[],
): { label: string; token: string } | undefined {
  const markers = [...redacted.matchAll(marker)];
  const first = markers.findIndex((match) => !body.startsWith(match[0], match.index));
  if (first < 0) return undefined;

  const start = markers[first]!;

  let end = start.index + start[0].length;
  for (const next of markers.slice(first + 1)) {
    if (!/^(?:\r?\n)*$/u.test(redacted.slice(end, next.index))) break;
    end = next.index + next[0].length;
  }

  const label = start[1]!;
  const after = redacted.slice(end);
  const next = after.search(/\[redacted:[a-z0-9-]+\]/u);
  const following = next < 0 ? after : after.slice(0, next);
  if (redacted.slice(0, start.index) === body.slice(0, start.index)) {
    const rest = body.slice(start.index);
    const known = secrets
      .filter((secret) => rest.startsWith(secret))
      .sort((a, b) => b.length - a.length);

    if (label === "env" && known[0]) return { label, token: known[0] };

    const stop = following === "" ? rest.length : rest.indexOf(following, 1);
    if (stop > 0) return { label, token: rest.slice(0, stop) };
  }

  return { label, token: sameToken(body, redacted, start.index) };
}

export function checkOutgoing({ kind, body, env, directory, reviewers }: Outgoing): void {
  if (planId.test(body.replaceAll("\n", " ")))
    throw new Error(`the ${kind} body names a plan id, which exists only on this machine`);

  for (const entry of reviewers)
    for (const handle of entry.handles)
      if (body.toLowerCase().includes(handle.toLowerCase()))
        throw new Error(
          `the ${kind} body mentions ${handle}, which summons ${entry.displayName} and may cost a review`,
        );

  const home = homePath(body, (env.HOME ?? "").replace(/(?<=.)\/+$/u, ""));
  if (home !== undefined) throw new Error(`the ${kind} body holds a home path: ${home}`);

  const secrets = envSecrets(upToRepo(directory));
  const redacted = redact(body, secrets);
  if (redacted === body) return;

  const secret = firstSecret(body, redacted, secrets);
  if (secret) throw new Error(`the ${kind} body holds a secret ${secret.label}: ${secret.token}`);
}
