import { hostname } from "node:os";
import { join as joinPath } from "node:path";
import { INVITE } from "skills-core";
import type { Io } from "../io.ts";
import { tryLock } from "../lock.ts";
import { openPlansStore } from "../plans/commit.ts";
import { Refusal } from "../plans/import.ts";
import { plansDir } from "../plans/index-tsv.ts";
import { hubSetting, hubUrl, networkOf } from "./network.ts";
import { readTailnet } from "./tailscale.ts";
import {
  HUB_BUSY,
  devices,
  init,
  invite,
  join,
  recover,
  revoke,
  rotateRecovery,
  sentence,
  type Deps,
} from "./enroll.ts";
import { hubDeps, LONG_BUDGET, pullToHead, reseed, statusVerb, syncVerb } from "./sync.ts";

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

type Typed =
  | { readonly kind: "line"; readonly text: string }
  | { readonly kind: "eof" }
  | { readonly kind: "interrupt" };

const INTERRUPTED = 130;

const interrupted = Symbol("interrupted");

type Escape = "none" | "start" | "csi" | "ss3";

function escapeAfter(escape: Escape, char: string): Escape {
  if (escape === "start") return char === "[" ? "csi" : char === "O" ? "ss3" : "none";
  if (escape === "csi") return char >= "@" && char <= "~" ? "none" : "csi";
  return "none";
}

function typedLine(prompt: string): Promise<Typed> {
  const stdin = process.stdin;
  const decoder = new TextDecoder();
  let text = "";
  let escape: Escape = "none";

  stdin.setRawMode(true);
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const finish = (typed: Typed) => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);

      stdin.setRawMode(false);
      stdin.pause();
      process.stderr.write("\n");
      resolve(typed);
    };

    const onEnd = () => finish({ kind: "eof" });
    const onData = (chunk: Buffer) => {
      for (const char of decoder.decode(chunk, { stream: true })) {
        if (char === "\r" || char === "\n") return finish({ kind: "line", text });
        if (char === "\x03") return finish({ kind: "interrupt" });
        if (char === "\x04") return finish({ kind: "eof" });
        if (escape !== "none") escape = escapeAfter(escape, char);
        else if (char === "\x1b") escape = "start";
        else if (char === "\x7f" || char === "\b") text = text.slice(0, -1);
        else if (char === "\x15") text = "";
        else if (char >= " ") text += char;
      }
    };

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.resume();
  });
}

async function enteredCode(prompt: string): Promise<string | typeof interrupted> {
  if (!process.stdin.isTTY) return (await Bun.stdin.text()).trim();

  const typed = await typedLine(prompt);
  if (typed.kind === "interrupt") return interrupted;

  return typed.kind === "line" ? typed.text.trim() : "";
}

function requiredUrl(env: NodeJS.ProcessEnv): string {
  const url = hubSetting(env, "HUB_URL");
  if (url === undefined) throw new Refusal("no HUB_URL, set it in the environment or skills.conf");
  return url;
}

async function dependencies(io: Io): Promise<Deps> {
  const store = await openPlansStore(plansDir(io.env));
  return hubDeps(store, io.env, (line) => io.out(`${line}\n`));
}

async function confirmPublish(waiting: number): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  process.stdout.write(`publish ${waiting} quarantined events under this device? [y/N] `);
  for await (const line of console) return /^y(es)?$/i.test(line.trim());
  return false;
}

const READERS: ReadonlySet<HubVerb> = new Set(["devices", "status"]);
async function run(verb: HubVerb, args: readonly string[], io: Io): Promise<number> {
  const deps = await dependencies(io);
  try {
    if (READERS.has(verb) || verb === "invite") return await dispatch(verb, args, io, deps);

    const locked = await tryLock(joinPath(plansDir(io.env), "hub.lock"), () =>
      dispatch(verb, args, io, deps),
    );

    if (locked.held) throw new Refusal(HUB_BUSY);

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

    const code = text(parsed, "code") ?? (await enteredCode("the hub's init code: "));
    if (code === interrupted) return INTERRUPTED;
    if (code === "")
      throw new Refusal("init reads the hub's init code at the prompt, from --code or from a pipe");

    const made = await init(deps, url, code, checkedLabel(text(parsed, "label") ?? machineLabel()));
    if (made === "reseed") await reseed(deps, url);
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

    const code = await enteredCode("the recovery code: ");
    if (code === interrupted) return INTERRUPTED;
    if (code === "")
      throw new Refusal("recover reads the recovery code at the prompt or from a pipe");

    await recover(deps, url, code, checkedLabel(text(parsed, "label") ?? machineLabel()));
    return 0;
  }

  if (verb === "revoke") {
    const [named, ...extra] = parse(args, [], []).positional;
    if (named === undefined || extra.length > 0) throw new UsageError();

    await pullToHead(deps, requiredUrl(io.env));
    await revoke(deps, requiredUrl(io.env), named);
    return 0;
  }

  if (verb === "sync") {
    const parsed = parse(args, [], ["publish-quarantine"]);
    if (parsed.positional.length > 0) throw new UsageError();

    return syncVerb(deps, requiredUrl(io.env), {
      env: io.env,
      budget: LONG_BUDGET,
      publishQuarantine: parsed.flags.has("publish-quarantine"),
      confirm: confirmPublish,
      quiet: false,
    });
  }

  if (args.length > 0) throw new UsageError();
  if (verb === "status") {
    const url = hubSetting(io.env, "HUB_URL");
    const network = networkOf(io.env);
    const tailnet =
      url !== undefined && network === "tailscale" ? await readTailnet(io.env) : undefined;

    return statusVerb(deps, url, network, tailnet);
  }

  if (verb === "devices") await devices(deps);
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
