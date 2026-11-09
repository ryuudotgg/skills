import { hostname } from "node:os";
import { join as joinPath } from "node:path";
import { INVITE } from "skills-core";
import type { Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { openPlansStore } from "../plans/commit.ts";
import { Refusal } from "../plans/import.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { connect, hubSetting, hubUrl, networkOf } from "./client.ts";
import {
  devices,
  init,
  invite,
  join,
  recover,
  revoke,
  rotateRecovery,
  sentence,
  status,
  sync,
  type Deps,
} from "./enroll.ts";
import { keyStore } from "./keys.ts";

export const HUB_VERBS = [
  "init",
  "invite",
  "join",
  "devices",
  "revoke",
  "recover",
  "recovery rotate",
  "sync",
  "status",
] as const;

export type HubVerb = (typeof HUB_VERBS)[number];

type Parsed = { readonly positional: string[]; readonly flags: Map<string, string | true> };

const HOUR = 60 * 60 * 1000;

const DAY = 24 * HOUR;

class UsageError extends Error {}

function parse(
  args: readonly string[],
  valued: readonly string[],
  bare: readonly string[],
): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const name = arg.slice(2);
    if (flags.has(name)) throw new UsageError();

    if (bare.includes(name)) flags.set(name, true);
    else if (valued.includes(name) && index + 1 < args.length) flags.set(name, args[++index] ?? "");
    else throw new UsageError();
  }

  return { positional, flags };
}

function text(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function duration(value: string): number {
  const found = /^([1-9][0-9]*)(h|d)$/.exec(value);
  const lasts = found === null ? NaN : Number(found[1]) * (found[2] === "d" ? DAY : HOUR);
  if (!(lasts <= 7 * DAY))
    throw new Refusal(`--for takes hours or days up to 7d, such as 24h, not ${value}`);

  return lasts;
}

function checkedLabel(label: string): string {
  if (label.trim() === "" || new TextEncoder().encode(label).length > INVITE.maxLabel)
    throw new Refusal(`a label holds 1 to ${INVITE.maxLabel} bytes, not "${label}"`);

  return label;
}

function machineLabel(): string {
  const scutil = Bun.which("scutil");
  const computer =
    process.platform === "darwin" && scutil !== null
      ? Bun.spawnSync([scutil, "--get", "ComputerName"]).stdout.toString().trim()
      : "";

  const label = computer || hostname();
  const bytes = new TextEncoder().encode(label);
  return bytes.length <= INVITE.maxLabel
    ? label
    : new TextDecoder().decode(bytes.slice(0, INVITE.maxLabel)).replace(/�$/, "");
}

async function stdinText(): Promise<string> {
  return (await Bun.stdin.text()).trim();
}

function requiredUrl(env: NodeJS.ProcessEnv): string {
  const url = hubSetting(env, "HUB_URL");
  if (url === undefined) throw new Refusal("no HUB_URL, set it in the environment or skills.conf");
  return url;
}

async function dependencies(io: Io): Promise<Deps> {
  return {
    store: await openPlansStore(plansDir(io.env)),
    keys: keyStore(io.env),
    connect: (url) => connect(url, networkOf(io.env)),
    now: Date.now,
    sleep: (ms) => Bun.sleep(ms),
    out: (line) => io.out(`${line}\n`),
  };
}

const READERS: ReadonlySet<HubVerb> = new Set(["devices", "status"]);
async function run(verb: HubVerb, args: readonly string[], io: Io): Promise<number> {
  const deps = await dependencies(io);
  try {
    if (READERS.has(verb)) return await dispatch(verb, args, io, deps);

    const locked = await tryLock(joinPath(plansDir(io.env), "hub.lock"), () =>
      dispatch(verb, args, io, deps),
    );

    if (locked.held)
      throw new Refusal("another skills hub verb is changing this store, run this once it ends");

    return locked.value;
  } finally {
    deps.store.db.close();
  }
}

async function dispatch(
  verb: HubVerb,
  args: readonly string[],
  io: Io,
  deps: Deps,
): Promise<number> {
  if (verb === "init") {
    const parsed = parse(args, ["code", "label"], []);
    const [url, ...extra] = parsed.positional;
    if (url === undefined || extra.length > 0) throw new UsageError();

    const code = text(parsed, "code") ?? (await stdinText());
    if (code === "") throw new Refusal("init reads the hub's init code from --code or stdin");

    await init(deps, url, code, checkedLabel(text(parsed, "label") ?? machineLabel()));
    return 0;
  }

  if (verb === "invite") {
    const parsed = parse(args, ["label", "for"], ["no-wait"]);
    if (parsed.positional.length > 0) throw new UsageError();

    const label = text(parsed, "label");
    return invite(deps, requiredUrl(io.env), {
      label: label === undefined ? undefined : checkedLabel(label),
      lasts: duration(text(parsed, "for") ?? "24h"),
      wait: !parsed.flags.has("no-wait"),
    });
  }

  if (verb === "join") {
    const [url, line, ...extra] = parse(args, [], []).positional;
    if (url === undefined || line === undefined || extra.length > 0) throw new UsageError();

    const configured = hubSetting(io.env, "HUB_URL");
    if (configured === undefined || hubUrl(configured).origin !== hubUrl(url).origin)
      throw new Refusal(
        `join takes only the hub HUB_URL names, and that is ${configured ?? "unset"}`,
      );

    await join(deps, url, line);
    return 0;
  }

  if (verb === "recover") {
    const parsed = parse(args, ["label"], []);
    const [url, ...extra] = parsed.positional;
    if (url === undefined || extra.length > 0) throw new UsageError();

    const code = await stdinText();
    if (code === "") throw new Refusal("recover reads the recovery code from stdin");

    await recover(deps, url, code, checkedLabel(text(parsed, "label") ?? machineLabel()));
    return 0;
  }

  if (verb === "revoke") {
    const [named, ...extra] = parse(args, [], []).positional;
    if (named === undefined || extra.length > 0) throw new UsageError();

    await revoke(deps, requiredUrl(io.env), named);
    return 0;
  }

  if (args.length > 0) throw new UsageError();

  if (verb === "devices") await devices(deps);
  else if (verb === "status") await status(deps, hubSetting(io.env, "HUB_URL"));
  else if (verb === "sync") await sync(deps, requiredUrl(io.env));
  else await rotateRecovery(deps, requiredUrl(io.env));

  return 0;
}

export async function hubVerb(
  verb: HubVerb,
  args: readonly string[],
  usage: string,
  io: Io,
): Promise<number> {
  try {
    return await run(verb, args, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`usage: ${usage}\n`);
      return 2;
    }

    const said = error instanceof Refusal ? error.message : sentence(error);
    if (said === undefined) throw error;

    io.err(`hub ${verb}: ${said}\n`);
    return 1;
  }
}
