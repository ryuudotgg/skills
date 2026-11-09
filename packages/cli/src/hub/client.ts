import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { lines, readDeliveryConfig } from "../delivery.ts";
import { PROTOCOL, canonicalRequest, parseId, sign, type Id, type SigningKeys } from "skills-core";

export const NETWORKS = ["public", "tailscale", "local"] as const;

export type Network = (typeof NETWORKS)[number];

export const hubKeys = ["HUB_URL", "HUB_NETWORK"] as const;

export type HubSigner = { readonly device: Id | "recovery"; readonly keys: SigningKeys };

export type Method = "GET" | "POST" | "PUT" | "DELETE";

export type HubClient = {
  readonly url: string;
  readonly incarnation: Id;
  readonly call: (
    method: Method,
    path: string,
    body: unknown,
    signer: HubSigner | undefined,
  ) => Promise<Record<string, unknown>>;
};

export class HubRefusal extends Error {
  override name = "HubRefusal";
  readonly reason: string;
  readonly status: number;

  constructor(reason: string, status: number, message: string) {
    super(message);
    this.reason = reason;
    this.status = status;
  }
}

export class Offline extends Error {
  override name = "Offline";
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Resolve = (host: string) => Promise<readonly string[]>;

const TIMEOUT = 30_000;

let lastTime = 0;
function requestTime(): number {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return lastTime;
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

async function systemResolve(host: string): Promise<readonly string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
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

async function admitted(url: URL, network: Network, resolve: Resolve): Promise<void> {
  if (url.protocol === "https:") return;
  if (network !== "local")
    throw new Offline(`HUB_NETWORK=${network} takes an https hub URL, not ${url.origin}`);

  const host = url.hostname.replace(/^\[|\]$/g, "");

  let addresses: readonly string[];
  try {
    addresses = isIP(host) === 0 ? await resolve(host) : [host];
  } catch {
    throw new Offline(`${host} does not resolve`);
  }

  const outside = addresses.find((address) => !isPrivateAddress(address));
  if (addresses.length === 0 || outside !== undefined)
    throw new Offline(
      `HUB_NETWORK=local takes only private addresses, and ${host} is ${outside ?? "nothing"}`,
    );
}

async function parsed(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (response.status === 426) throw new HubRefusal("protocol", 426, text.trim());

  let json: unknown;
  try {
    json = text === "" ? {} : JSON.parse(text);
  } catch {
    throw new Offline(`the hub answered ${response.status} with a body that is not JSON`);
  }

  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new Offline(`the hub answered ${response.status} with a body that is not an object`);

  const body = json as Record<string, unknown>;
  if (response.ok) return body;

  const reason = typeof body.reason === "string" ? body.reason : `status-${response.status}`;
  const message = typeof body.message === "string" ? body.message : `status ${response.status}`;
  throw new HubRefusal(reason, response.status, message);
}

async function send(fetcher: Fetch, url: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetcher(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "TimeoutError")
      throw new Offline(`the hub did not answer in ${TIMEOUT / 1000} seconds`);

    throw new Offline(
      `the hub is unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (response.status >= 300 && response.status < 400)
    throw new Offline(`the hub answered with a redirect, which this client never follows`);

  return response;
}

function versionOf(body: Record<string, unknown>): { min: number; max: number; incarnation: Id } {
  const { min, max, incarnation } = body;
  if (typeof min !== "number" || typeof max !== "number" || typeof incarnation !== "string")
    throw new Offline("the hub's version answer does not parse");

  try {
    return { min, max, incarnation: parseId(incarnation) };
  } catch {
    throw new Offline("the hub's version answer does not parse");
  }
}

export async function connect(
  raw: string,
  network: Network,
  fetcher: Fetch = fetch,
  resolve: Resolve = systemResolve,
): Promise<HubClient> {
  const url = hubUrl(raw);
  const origin = url.origin;
  async function version(): Promise<Id> {
    await admitted(url, network, resolve);

    const spoken = versionOf(await parsed(await send(fetcher, `${origin}/v1/version`, {})));
    if (PROTOCOL < spoken.min || PROTOCOL > spoken.max)
      throw new Offline(`hub speaks ${spoken.min}..${spoken.max}, this release speaks ${PROTOCOL}`);

    return spoken.incarnation;
  }

  async function once(
    method: Method,
    path: string,
    text: string,
    signer: HubSigner | undefined,
    incarnation: Id,
  ): Promise<Response> {
    await admitted(url, network, resolve);

    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-skills-protocol": String(PROTOCOL),
    };

    if (signer !== undefined) {
      const time = requestTime();
      const message = await canonicalRequest({
        method,
        path,
        body: new TextEncoder().encode(text),
        time,
        device: signer.device,
        incarnation,
      });

      headers["x-skills-device"] = signer.device;
      headers["x-skills-time"] = String(time);
      headers["x-skills-signature"] = Buffer.from(
        await sign("request", signer.keys, message),
      ).toString("base64");
    }

    return send(fetcher, `${origin}${path}`, {
      method,
      headers,
      body: text === "" ? undefined : text,
    });
  }

  let incarnation = await version();
  return {
    url: origin,
    get incarnation() {
      return incarnation;
    },
    async call(method, path, body, signer) {
      const text = body === undefined ? "" : JSON.stringify(body);
      const response = await once(method, path, text, signer, incarnation);
      const answered = response.headers.get("x-skills-incarnation");
      if (signer === undefined || answered === incarnation || response.ok) return parsed(response);

      incarnation = await version();
      return parsed(await once(method, path, text, signer, incarnation));
    },
  };
}
