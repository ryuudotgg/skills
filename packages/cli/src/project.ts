import { readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { processIo, type Io } from "./io.ts";
import { plansDir } from "./plans/paths.ts";
import { describe, read, type Read, type ReadFailure } from "./read.ts";

type GitOptions = {
  timeout?: number;
  stderr?: "ignore" | "inherit";
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

export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

function hostAndPath(url: string): { host: string; path: string } | undefined {
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (scheme) {
    if (asciiLower(scheme[1]!) === "file") return undefined;

    const rest = url.slice(scheme[0].length);
    const slash = rest.search(/[/?#]/);
    const authority = slash === -1 ? rest : rest.slice(0, slash);
    const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d*$/, "");
    return { host, path: slash === -1 ? "" : rest.slice(slash) };
  }

  const bracketed = /^([^/@]*@)?\[[^\]/]*\]:/.exec(url);
  const colon = bracketed ? bracketed[0].length - 1 : url.indexOf(":");
  const slash = url.indexOf("/");
  if (colon <= 0 || (slash !== -1 && slash < colon)) return undefined;

  const authority = url.slice(0, colon);
  return { host: authority.slice(authority.lastIndexOf("@") + 1), path: url.slice(colon + 1) };
}

export function repoKey(url: string): string | undefined {
  const parts = hostAndPath(url.trim().replace(/^[a-z][a-z0-9+.-]*::/i, ""));
  if (!parts?.host) return undefined;

  const path = parts.path
    .replace(/[?#].*$/s, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "")
    .replace(/^\/+/, "");

  return path ? `${parts.host}/${path}`.toLowerCase() : undefined;
}

const PIN_NAME = "skills.project";
const PIN_KEY = "skills.repo";

export const pinRead = [
  "config",
  "--local",
  "--null",
  "--get-regexp",
  "^skills\\.(project|repo)$",
] as const;

export type Pin = { name: string; key?: string };

export type Step = "folder" | "pin" | "main" | "remote";

export type Name = { step: Step; name: string };

export type Answer = { step: Step; project: string };

export type Checkout = { inside: boolean; repo: string; names: Name[]; pin?: Pin };

export type ReadGit = (args: readonly string[]) => Promise<string | undefined>;

export function gitReader(cwd: string, io: Io = processIo()): ReadGit {
  return (args) => gitOutput(cwd, args, { quiet: true }, io);
}

export function pinOf(config: string | undefined): Pin | undefined {
  const values = new Map<string, string>();
  for (const entry of config?.split("\0") ?? []) {
    const newline = entry.indexOf("\n");
    values.set(
      newline === -1 ? entry : entry.slice(0, newline),
      newline === -1 ? "" : entry.slice(newline + 1),
    );
  }

  const name = values.get(PIN_NAME);
  const key = values.get(PIN_KEY);
  return name ? { name, ...(key ? { key } : {}) } : undefined;
}

export async function readCheckout(
  cwd: string,
  quiet = false,
  io: Io = processIo(),
): Promise<Checkout> {
  const [output, config] = await Promise.all([
    gitOutput(
      cwd,
      ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
      { quiet },
      io,
    ),
    gitOutput(cwd, pinRead, { quiet: true }, io),
  ]);

  const [top, common] = output?.split("\n") ?? [];
  return checkoutAt(top, common, cwd, config, gitReader(cwd, io));
}

export async function checkoutAt(
  top: string | undefined,
  common: string | undefined,
  cwd: string,
  config: string | undefined,
  readGit: ReadGit,
): Promise<Checkout> {
  const pin = pinOf(config);
  const stands = !pin?.key || (await checkoutKeys(readGit)).includes(pin.key);
  return checkoutOf(top, common, cwd, stands ? pin : undefined);
}

export function checkoutOf(
  top: string | undefined,
  common: string | undefined,
  cwd: string,
  pin?: Pin,
): Checkout {
  const repo = basename(top || cwd);
  if (!top) return { inside: false, repo, names: [{ step: "folder", name: repo }] };

  const main = common
    ? basename(common) === ".git"
      ? basename(dirname(common))
      : basename(common).replace(/\.git$/, "")
    : "";

  const names: Name[] = [
    ...(main && main !== repo ? [{ step: "folder" as const, name: repo }] : []),
    ...(pin ? [{ step: "pin" as const, name: pin.name }] : []),
    { step: "main", name: main || repo },
  ];

  return { inside: true, repo, names, ...(pin ? { pin } : {}) };
}

export function answersAmong(
  names: readonly Name[],
  projects: readonly string[],
  pinDirectories: readonly string[] = projects,
): Answer[] {
  const sorted = [...projects].sort();
  const found: Answer[] = [];
  const pinned = names.some(
    ({ step, name }) =>
      step === "pin" &&
      pinDirectories.some((directory) => asciiLower(directory) === asciiLower(name)),
  );

  for (const { step, name } of names) {
    if (step === "main" && pinned) continue;

    const matches = sorted.filter((candidate) => asciiLower(candidate) === asciiLower(name));
    if (matches.length === 0) continue;

    const project = matches.find((match) => !found.some((answer) => answer.project === match));
    if (project !== undefined) found.push({ step, project });
  }

  return found;
}

export function projectDirectories(plansDir: string, names: readonly Name[]): string[] {
  const wanted = new Set(names.map(({ name }) => asciiLower(name)));
  if (wanted.size === 0) return [];

  let entries: string[];
  try {
    entries = readdirSync(plansDir).filter(
      (name) => !name.startsWith(".") && wanted.has(asciiLower(name)),
    );
  } catch {
    return [];
  }

  return entries.filter((name) => {
    try {
      return statSync(`${plansDir}/${name}`).isDirectory();
    } catch {
      return false;
    }
  });
}

type RemoteKey = { remote: string; key: string };

async function remoteKeys(readGit: ReadGit): Promise<RemoteKey[] | undefined> {
  const listed = await readGit(["remote"]);
  if (listed === undefined) return undefined;

  const remotes = listed.split("\n").filter(Boolean);
  const urls = await Promise.all(remotes.map((remote) => readGit(["remote", "get-url", remote])));
  if (urls.includes(undefined)) return undefined;

  return remotes.flatMap((remote, at) => {
    const key = repoKey(urls[at]!);
    return key ? [{ remote, key }] : [];
  });
}

async function checkoutKeys(readGit: ReadGit): Promise<string[]> {
  const keys = (await remoteKeys(readGit)) ?? [];
  return [...new Set(keys.map(({ key }) => key))];
}

async function remoteAnswer(
  keys: readonly string[],
  plansDir: string,
  projects?: readonly string[],
): Promise<Answer | undefined> {
  if (keys.length === 0) return undefined;

  const { recordedOrigins } = await import("./plans/origins.ts");
  const names: Name[] = recordedOrigins(plansDir)
    .filter(({ origin }) => {
      const key = repoKey(origin);
      return key !== undefined && keys.includes(key);
    })
    .map(({ project }) => ({ step: "remote", name: project }));

  if (names.length === 0) return undefined;

  const sorted = [...(projects ?? projectDirectories(plansDir, names))].sort();
  const matched = new Set(
    names.flatMap(
      ({ name }) =>
        sorted.find((project) => project === name) ??
        sorted.find((project) => asciiLower(project) === asciiLower(name)) ??
        [],
    ),
  );

  const [project] = matched;
  return matched.size === 1 ? { step: "remote", project: project! } : undefined;
}

export async function answersFor(
  checkout: Checkout,
  plansDir: string,
  readGit: ReadGit,
  projects?: readonly string[],
): Promise<Answer[]> {
  const directories = projectDirectories(plansDir, checkout.names);
  const found = answersAmong(checkout.names, projects ?? directories, directories);
  const pinned = checkout.names.some(
    ({ step, name }) =>
      step === "pin" && directories.some((directory) => asciiLower(directory) === asciiLower(name)),
  );

  if (found.length > 0 || pinned || !checkout.inside) return found;

  const remote = await remoteAnswer(await checkoutKeys(readGit), plansDir, projects);
  return remote ? [remote] : [];
}

export async function checkoutIs(
  cwd: string,
  project: string,
  io: Io = processIo(),
): Promise<string | undefined> {
  const checkout = await readCheckout(cwd, false, io);
  if (!checkout.inside) return `not inside a git repository, not a checkout of ${project}`;

  const wanted = asciiLower(project);
  const pins = checkout.names.filter(({ step }) => step === "pin");
  const pin = answersAmong(pins, projectDirectories(plansDir(io.env), pins))[0]?.project;
  const passes = checkout.names.some(({ step, name }) =>
    step === "pin"
      ? pin !== undefined && asciiLower(pin) === wanted
      : (step === "folder" || pin === undefined) && asciiLower(name) === wanted,
  );

  if (passes) return undefined;

  const [answer] = await answersFor(checkout, plansDir(io.env), gitReader(cwd, io));
  if (answer?.step === "remote" && asciiLower(answer.project) === wanted) return undefined;

  const pinned = pin === undefined ? "" : ` pinned to ${pin}`;
  return `this checkout is ${checkout.repo}${pinned}, not a checkout of ${project}`;
}

async function detectAnswers(
  cwd: string,
  plansDir: string,
  quiet = false,
  io: Io = processIo(),
): Promise<Answer[]> {
  return answersFor(await readCheckout(cwd, quiet, io), plansDir, gitReader(cwd, io));
}

export async function detectProjects(
  cwd: string,
  plansDir: string,
  quiet = false,
  io: Io = processIo(),
): Promise<string[]> {
  return (await detectAnswers(cwd, plansDir, quiet, io)).map(({ project }) => project);
}

export async function detectProject(
  cwd: string,
  plansDir: string,
  quiet = false,
  io: Io = processIo(),
): Promise<string | undefined> {
  return (await detectProjects(cwd, plansDir, quiet, io))[0];
}

export async function learnProject(
  cwd: string,
  plansDir: string,
  io: Io = processIo(),
): Promise<string | undefined> {
  const checkout = await readCheckout(cwd, true, io);
  const readGit = gitReader(cwd, io);
  const [answer] = await answersFor(checkout, plansDir, readGit);

  const learned = answer?.step === "main" || answer?.step === "remote" ? answer.project : undefined;
  const pins = checkout.names.filter(({ step }) => step === "pin");
  const unkeyed = !checkout.pin?.key && projectDirectories(plansDir, pins).length > 0;
  if (learned === undefined && !unkeyed) return answer?.project;

  const keys = await remoteKeys(readGit);
  if (keys === undefined) return answer?.project;

  const key = (keys.find(({ remote }) => remote === "origin") ?? keys[0])?.key;
  const config = (args: string[]) => gitRead(cwd, ["config", "--local", ...args], {}, io);
  if (learned !== undefined) {
    const pinned = await config(["--replace-all", PIN_NAME, learned]);
    if (pinned.ok && pinned.code === 0)
      await config(key ? ["--replace-all", PIN_KEY, key] : ["--unset-all", PIN_KEY]);
  } else if (key) await config(["--replace-all", PIN_KEY, key]);

  return answer?.project;
}
