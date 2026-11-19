import { accessSync, constants } from "node:fs";
import { read } from "../read.ts";

const TAILSCALE_DOWNLOAD = "https://tailscale.com/download";

export const MISSING = `tailscale is not installed, install it from ${TAILSCALE_DOWNLOAD}`;

const MAC_APP = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

const READ_TIMEOUT = 2_000;

const DAEMON_GONE = /failed to connect to local tailscale|is tailscale running/i;

export type Peer = { readonly host: string; readonly url: string; readonly online: boolean };

export type Tailnet =
  | { readonly kind: "missing" }
  | { readonly kind: "unknown"; readonly reason: string }
  | { readonly kind: "down"; readonly state: string }
  | {
      readonly kind: "up";
      readonly name: string;
      readonly suffix: string;
      readonly peers: readonly Peer[];
      readonly taken: readonly string[];
    };

export function tailscaleBinary(
  env: NodeJS.ProcessEnv,
  fallbacks: readonly string[] = process.platform === "darwin" ? [MAC_APP] : [],
): string | undefined {
  return Bun.which("tailscale", { PATH: env.PATH ?? "" }) ?? fallbacks.find(runnable);
}

function runnable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function dnsName(node: Record<string, unknown>): string {
  return text(node.DNSName).replace(/\.$/, "");
}

function peerOf(value: unknown): Peer | undefined {
  const node = record(value);
  const name = dnsName(node);
  if (name === "" || node.Expired === true) return undefined;

  return { host: text(node.HostName), url: `https://${name}`, online: node.Online === true };
}

export function parseStatus(output: string): Tailnet {
  let json: Record<string, unknown>;
  try {
    json = record(JSON.parse(output));
  } catch {
    return { kind: "unknown", reason: "tailscale status printed no JSON" };
  }

  const state = text(json.BackendState);
  if (state === "") return { kind: "unknown", reason: "tailscale status named no backend state" };
  if (state !== "Running") return { kind: "down", state };

  const current = record(json.CurrentTailnet);
  const magicDns = current.MagicDNSEnabled !== false;
  const suffix = magicDns ? text(current.MagicDNSSuffix) || text(json.MagicDNSSuffix) : "";

  const nodes = [json.Self, ...Object.values(record(json.Peer))].map(record);
  const taken = nodes.map((node) => dnsName(node).split(".")[0] ?? "").filter(Boolean);
  const peers = magicDns ? nodes.slice(1).flatMap((node) => peerOf(node) ?? []) : [];
  return { kind: "up", name: text(current.Name) || suffix, suffix, peers, taken };
}

export async function readTailnet(
  env: NodeJS.ProcessEnv,
  fallbacks?: readonly string[],
  timeout = READ_TIMEOUT,
): Promise<Tailnet> {
  const binary = tailscaleBinary(env, fallbacks);
  if (binary === undefined) return { kind: "missing" };

  const answer = await read([binary, "status", "--json"], { deadline: timeout, env });
  if (!answer.ok)
    return {
      kind: "unknown",
      reason:
        answer.failure.kind === "spawn"
          ? answer.failure.detail.replace(/^Error: /, "")
          : "tailscale status did not answer in time",
    };

  const status = parseStatus(answer.stdout);
  if (answer.code === 0 || status.kind === "down") return status;
  if (DAEMON_GONE.test(answer.stderr)) return { kind: "down", state: "daemon unreachable" };

  return { kind: "unknown", reason: `tailscale status exited ${answer.code}` };
}
