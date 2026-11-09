import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { lines } from "../delivery.ts";
import {
  hubKeys,
  hubUrl,
  isPrivateAddress,
  NETWORKS,
  Offline,
  type Network,
} from "../hub/network.ts";

export type HubTarget = { readonly url: string; readonly network: Network };

export type HubSetup =
  | { readonly kind: "flags"; readonly target: HubTarget }
  | { readonly kind: "new"; readonly target: HubTarget }
  | { readonly kind: "join"; readonly target: HubTarget; readonly invite: string };

export class HubTargetError extends Error {
  override name = "HubTargetError";
}

const JOIN = "skills hub join <url> <invite>";

export function hubNetwork(value: string): Network {
  if (!(NETWORKS as readonly string[]).includes(value))
    throw new HubTargetError(`--hub-network takes ${NETWORKS.join(", ")}, not ${value}`);

  return value as Network;
}

export function hubTarget(raw: string, network: Network): HubTarget {
  let url: URL;
  try {
    url = hubUrl(raw.trim());
  } catch (error) {
    if (error instanceof Offline) throw new HubTargetError(error.message);
    throw error;
  }

  if (network === "tailscale" && url.port !== "")
    throw new HubTargetError(
      `HUB_NETWORK=tailscale serves the hub on port 443, so its URL names no port, not ${url.port}`,
    );

  if (url.protocol === "https:") return { url: url.origin, network };
  if (network !== "local")
    throw new HubTargetError(`HUB_URL must be https for HUB_NETWORK=${network}, not ${url.origin}`);

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) !== 0 && !isPrivateAddress(host))
    throw new HubTargetError(
      `HUB_NETWORK=local takes http only on a private address, and ${host} is not private`,
    );

  return { url: url.origin, network };
}

export function inviteOf(line: string, target: HubTarget): string {
  const words = line.trim().split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0]!;

  const [skills, hub, verb, url, invite, ...extra] = words;
  if (skills !== "skills" || hub !== "hub" || verb !== "join" || !url || !invite || extra.length)
    throw new HubTargetError(`paste the ${JOIN} line skills hub invite printed, or its invite`);

  let origin: string;
  try {
    origin = hubUrl(url).origin;
  } catch {
    throw new HubTargetError(`${url} is not a hub URL`);
  }

  if (origin !== target.url)
    throw new HubTargetError(`this line names ${origin}, not the hub at ${target.url}`);

  return invite;
}

function isHubLine(line: string): boolean {
  return hubKeys.some((key) => line.startsWith(`${key}=`));
}

export function hubLines(content: string): string {
  return lines(content).filter(isHubLine).join("\n");
}

export function withHub(content: string, target: HubTarget | undefined): string {
  const rows = lines(content);
  const at = rows.findIndex(isHubLine);
  const kept = rows.filter((row) => !isHubLine(row));
  if (target)
    kept.splice(
      at === -1 ? kept.length : at,
      0,
      `HUB_URL=${target.url}`,
      `HUB_NETWORK=${target.network}`,
    );

  return kept.length ? `${kept.join("\n")}\n` : "";
}

function word(value: string): string {
  return /^[\w@%+=:,./<>-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function compose(repo: string, network: Network): string[] {
  const files = ["compose.yaml", `compose.${network}.yaml`]
    .map((name) => join(repo, "apps/hub", name))
    .filter((path) => existsSync(path));

  return ["docker", "compose", ...files.flatMap((path) => ["-f", word(path)])];
}

function startCommand(repo: string, target: HubTarget): string {
  const url = new URL(target.url);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const settings =
    target.network === "tailscale"
      ? ["TS_AUTHKEY=<auth key>", `TS_HOSTNAME=${url.hostname.split(".")[0]}`]
      : url.protocol === "http:"
        ? [
            `HUB_BIND=${isIP(host) ? url.hostname : "<private address>"}`,
            `HUB_PORT=${url.port || "80"}`,
          ]
        : [];

  return [...settings, ...compose(repo, target.network), "up", "-d"].join(" ");
}

function startLines(repo: string, target: HubTarget): string[] {
  const proxied = target.network !== "tailscale" && target.url.startsWith("https:");
  const logs = [...compose(repo, target.network), "logs", "hub"].join(" ");
  return [
    `next   on the hub's host: ${startCommand(repo, target)}`,
    ...(proxied
      ? [`next   serve ${target.url} from 127.0.0.1:8080 through an HTTPS proxy you run`]
      : []),
    `next   skills hub init ${target.url} --code <init code>, with the init code from ${logs}`,
  ];
}

export function hubReport(repo: string, setup: HubSetup): string[] {
  const { target } = setup;
  const head = `hub    ${target.url} (${target.network})`;
  if (setup.kind === "join") return [head];
  if (setup.kind === "new") return [head, ...startLines(repo, target)];

  return [
    head,
    `next   to join it: skills hub join ${target.url} <invite>, with the line skills hub invite prints on an enrolled machine`,
    "next   to start it instead:",
    ...startLines(repo, target),
  ];
}
