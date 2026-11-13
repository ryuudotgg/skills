import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { hubUrl, isPrivateAddress, Offline, type Network } from "./network.ts";
import { PROTOCOL, canonicalRequest, parseId, sign, type Id, type SigningKeys } from "skills-core";

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
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    reason: string,
    status: number,
    message: string,
    detail: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.reason = reason;
    this.status = status;
    this.detail = detail;
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export type Resolve = (host: string) => Promise<readonly string[]>;

const TIMEOUT = 30_000;

const BUDGET_SPENT = "the hub did not answer within the sync's time budget";

let lastTime = 0;
function requestTime(): number {
  lastTime = Math.max(Date.now(), lastTime + 1);
  return lastTime;
}

async function systemResolve(host: string): Promise<readonly string[]> {
  const found = await lookup(host, { all: true, verbatim: true });
  return found.map((entry) => entry.address);
}

type Target = { readonly origins: readonly string[]; readonly host: string | undefined };

async function admitted(
  url: URL,
  network: Network,
  resolve: Resolve,
  deadline: number,
): Promise<Target> {
  if (url.protocol === "https:") return { origins: [url.origin], host: undefined };
  if (network !== "local")
    throw new Offline(`HUB_NETWORK=${network} takes an https hub URL, not ${url.origin}`);

  const host = url.hostname.replace(/^\[|\]$/g, "");

  let addresses: readonly string[];
  try {
    addresses = isIP(host) === 0 ? await withinDeadline(resolve(host), deadline) : [host];
  } catch (error) {
    if (error instanceof Offline) throw error;
    throw new Offline(`${host} does not resolve`);
  }

  const outside = addresses.find((address) => !isPrivateAddress(address));
  const [first] = addresses;
  if (first === undefined || outside !== undefined)
    throw new Offline(
      `HUB_NETWORK=local takes only private addresses, and ${host} is ${outside ?? "nothing"}`,
    );

  if (first === host) return { origins: [url.origin], host: undefined };

  const origins = addresses.map(
    (address) => `http://${isIP(address) === 6 ? `[${address}]` : address}:${url.port || "80"}`,
  );

  return { origins, host: url.host };
}

async function bodyOf(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw timedOut(error) ? unreachable(error) : error;
  }
}

async function parsed(response: Response): Promise<Record<string, unknown>> {
  const text = await bodyOf(response);
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
  throw new HubRefusal(reason, response.status, message, body);
}

function timedOut(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

function unreachable(error: unknown): Offline {
  if (timedOut(error)) return new Offline("the hub did not answer in time");

  return new Offline(
    `the hub is unreachable: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function refusedConnection(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ECONNREFUSED";
}

function withinDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const left = timeLeft(deadline);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Offline(BUDGET_SPENT)), left);
  });

  return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}

function timeLeft(deadline: number): number {
  const left = Math.min(TIMEOUT, deadline - Date.now());
  if (left <= 0) throw new Offline(BUDGET_SPENT);
  return left;
}

async function send(
  fetcher: Fetch,
  target: Target,
  path: string,
  init: RequestInit,
  deadline: number,
): Promise<Response> {
  const headers = {
    ...(init.headers as Record<string, string>),
    ...(target.host === undefined ? {} : { host: target.host }),
  };

  let response: Response | undefined;
  let failure: unknown;
  for (const origin of target.origins) {
    const left = timeLeft(deadline);
    try {
      response = await fetcher(`${origin}${path}`, {
        ...init,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(left),
      });

      break;
    } catch (error) {
      failure = error;
      if (!refusedConnection(error)) break;
    }
  }

  if (response === undefined) throw unreachable(failure);
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
  deadline = Number.POSITIVE_INFINITY,
): Promise<HubClient> {
  const url = hubUrl(raw);
  const origin = url.origin;
  async function version(): Promise<Id> {
    const reply = await send(
      fetcher,
      await admitted(url, network, resolve, deadline),
      "/v1/version",
      {},
      deadline,
    );

    const spoken = versionOf(await parsed(reply));
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
    const target = await admitted(url, network, resolve, deadline);
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

    return send(
      fetcher,
      target,
      path,
      { method, headers, body: text === "" ? undefined : text },
      deadline,
    );
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
