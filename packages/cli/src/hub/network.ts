import { isIP } from "node:net";
import { lines, readDeliveryConfig } from "../delivery.ts";

export const NETWORKS = ["public", "tailscale", "local"] as const;

export type Network = (typeof NETWORKS)[number];

export const hubKeys = ["HUB_URL", "HUB_NETWORK"] as const;

export class Offline extends Error {
  override name = "Offline";
}

function confValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const config = readDeliveryConfig(env);
  if (!config.path) return undefined;

  return lines(config.content)
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1))
    .at(-1);
}

export function hubSetting(
  env: NodeJS.ProcessEnv,
  key: (typeof hubKeys)[number],
): string | undefined {
  const value = env[key] ?? confValue(env, key);
  return value === "" ? undefined : value;
}

export function networkOf(env: NodeJS.ProcessEnv): Network {
  const value = hubSetting(env, "HUB_NETWORK") ?? "public";
  if (!(NETWORKS as readonly string[]).includes(value))
    throw new Offline(`HUB_NETWORK takes public, tailscale or local, not ${value}`);

  return value as Network;
}

function v4(address: string): number[] {
  return address.split(".").map(Number);
}

export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped !== undefined) return isPrivateAddress(mapped);

  if (isIP(address) === 4) {
    const [a = 0, b = 0] = v4(address);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    );
  }

  if (isIP(address) === 6) {
    const first = Number.parseInt(address.split(":")[0] || "0", 16);
    return address === "::1" || (first & 0xfe00) === 0xfc00;
  }

  return false;
}

export function hubUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Offline(`${raw} is not a URL`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Offline(`the hub URL takes http or https, not ${url.protocol}`);

  if (url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "")
    throw new Offline("the hub URL carries no credentials, query or fragment");

  if (url.pathname !== "/" && url.pathname !== "")
    throw new Offline("the hub URL names the hub's root, with no path");

  return url;
}
