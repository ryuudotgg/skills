import type { Database } from "bun:sqlite";
import {
  LAYOUT,
  PROTOCOL,
  canonicalRequest,
  toBase32,
  verify,
  type Bytes,
  type Id,
} from "skills-core";
import { blobRoutes } from "./blobs.ts";
import {
  ChainMemo,
  chainRoutes,
  headOf,
  identify,
  sameHead,
  type Candidate,
  type Chain,
  type Principal,
} from "./chain.ts";
import { eventRoutes } from "./events.ts";
import { leaseRoutes } from "./leases.ts";
import { pairingRoutes } from "./pairing.ts";
import { asRefusal, protocolSentence, Refusal, refusalJson } from "./refusal.ts";
import type { Answer, Caller, Effect, HubState, Method, Route } from "./route.ts";
import { commit, openStore, savepoint, SKEW, spend, type Incarnations } from "./store.ts";
import { base64, idOf, malformed } from "./wire.ts";

export type HubOptions = {
  readonly data: string;
  readonly listen: string;
  readonly log: (line: string) => void;
};

export type RunningHub = {
  readonly url: string;
  readonly port: number;
  readonly incarnation: Id;
  readonly initCode: string | undefined;
  readonly stop: () => Promise<void>;
};

type Hub = HubState & {
  readonly db: Database;
  readonly memo: ChainMemo;
  readonly log: (line: string) => void;
};

type Trace = { method: string; path: string; device: string };

type Matched = {
  readonly route: Route;
  readonly params: Record<string, string>;
  readonly logged: string;
};

type Spent = { readonly digest: Bytes; readonly time: number };

const METHODS: readonly Method[] = ["GET", "POST", "PUT", "DELETE"];

const BODY_MAX = 48 * 1024 * 1024;

const VERSION: Route = {
  method: "GET",
  pattern: "/v1/version",
  access: { kind: "open" },
  limit: 0,
  prepare: async () => {
    throw new TypeError("the version route answers before prepare");
  },
};

const ROUTES: readonly Route[] = [
  VERSION,
  ...chainRoutes,
  ...pairingRoutes,
  ...eventRoutes,
  ...blobRoutes,
  ...leaseRoutes,
];

function isMethod(method: string): method is Method {
  return (METHODS as readonly string[]).includes(method);
}

function matchPattern(pattern: string, path: string): Record<string, string> | undefined {
  const want = pattern.split("/");
  const have = path.split("/");
  if (want.length !== have.length) return undefined;

  const params: Record<string, string> = {};
  for (const [index, part] of want.entries()) {
    const given = have[index] ?? "";
    if (part.startsWith(":")) {
      if (given === "") return undefined;
      params[part.slice(1)] = given;
    } else if (part !== given) return undefined;
  }

  return params;
}

function loggedPath(pattern: string, params: Record<string, string>): string {
  return pattern.replace(/:(\w+)/g, (whole, name: string) => {
    const value = params[name] ?? "";
    return /^[0-9a-f]{1,64}$/.test(value) ? value : whole;
  });
}

function match(method: string, path: string, trace: Trace): Matched {
  const candidates = ROUTES.flatMap((route) => {
    const params = matchPattern(route.pattern, path);
    return params === undefined ? [] : [{ route, params }];
  });

  const found = candidates.find((candidate) => candidate.route.method === method) ?? candidates[0];
  if (found === undefined) throw new Refusal("route");

  trace.path = loggedPath(found.route.pattern, found.params);
  if (found.route.method !== method) throw new Refusal("method");

  return { ...found, logged: trace.path };
}

function checkProtocol(headers: Headers): void {
  const spoken = headers.get("x-skills-protocol");
  if (spoken === null) return;
  if (!/^\d{1,6}$/.test(spoken)) malformed("x-skills-protocol");
  if (Number(spoken) !== PROTOCOL) throw new Refusal("protocol", { spoken });
}

class Aborted extends Error {
  override readonly name = "Aborted";
}

async function readBody(request: Request, limit: number): Promise<Bytes> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > limit) throw new Refusal("too-large");
  if (request.body === null) return new Uint8Array();

  const chunks: Uint8Array[] = [];

  let size = 0;
  try {
    for await (const chunk of request.body) {
      size += chunk.byteLength;
      if (size > limit) throw new Refusal("too-large");
      chunks.push(chunk);
    }
  } catch (error) {
    if (request.signal.aborted) throw new Aborted();
    throw error;
  }

  return new Uint8Array(Buffer.concat(chunks));
}

type Signed = {
  readonly device: Id | "recovery";
  readonly time: number;
  readonly signature: Bytes;
};

function signatureHeaders(headers: Headers): Signed {
  const values = [
    "x-skills-protocol",
    "x-skills-device",
    "x-skills-time",
    "x-skills-signature",
  ].map((name) => headers.get(name));

  const [, device, time, signature] = values;
  if (values.some((value) => value === null) || device == null || time == null || signature == null)
    throw new Refusal("unsigned");

  if (!/^\d{1,16}$/.test(time)) malformed("x-skills-time");

  return {
    device: device === "recovery" ? device : idOf(device, "x-skills-device"),
    time: Number(time),
    signature: base64(signature, "x-skills-signature", LAYOUT.signature),
  };
}

async function signedUnder(
  signing: Bytes,
  parts: Parameters<typeof canonicalRequest>[0],
  signature: Bytes,
): Promise<boolean> {
  try {
    await verify("request", signing, await canonicalRequest(parts), signature);
    return true;
  } catch {
    return false;
  }
}

async function authenticate(
  candidate: Candidate,
  chain: Chain,
  parts: Omit<Parameters<typeof canonicalRequest>[0], "incarnation">,
  signature: Bytes,
  incarnations: Incarnations,
): Promise<Principal> {
  const current = { ...parts, incarnation: incarnations.current };
  if (await signedUnder(candidate.signing, current, signature)) return candidate.principal;

  if (candidate.principal.kind === "recovery" && chain.kind === "founded")
    for (const retired of chain.retired)
      if (await signedUnder(retired, current, signature)) return { kind: "retired-recovery" };

  const { previous } = incarnations;
  if (
    previous !== undefined &&
    (await signedUnder(candidate.signing, { ...parts, incarnation: previous }, signature))
  )
    throw new Refusal("incarnation");

  throw new Refusal("signature");
}

function admitCaller(route: Route, principal: Principal, params: Record<string, string>): Caller {
  if (principal.kind === "revoked") throw new Refusal("device-revoked");
  if (principal.kind === "retired-recovery") throw new Refusal("recovery-revoked");

  const callers = route.access.kind === "signed" ? route.access.callers : [];
  if (!callers.includes(principal.kind)) {
    if (principal.kind === "pending") throw new Refusal("device-pending");
    if (principal.kind === "recovery") throw new Refusal("recovery-route");
    throw new Refusal("member-route");
  }

  if (principal.kind === "pending" && params.invite !== principal.invite)
    throw new Refusal("device-pending");

  return principal;
}

async function settle(prepare: () => Promise<Effect | Refusal>): Promise<Effect | Refusal> {
  try {
    return await prepare();
  } catch (error) {
    const refusal = asRefusal(error);
    if (refusal === undefined) throw error;
    return refusal;
  }
}

function settled(
  hub: Hub,
  spent: Spent | undefined,
  chain: Chain,
  prepared: Effect | Refusal,
): Answer {
  const answer = commit(hub.db, (tx) => {
    const now = hub.now();
    if (spent !== undefined && Math.abs(now - spent.time) > SKEW) return new Refusal("clock");
    if (spent !== undefined && spend(tx, spent.digest, spent.time, now) === "replayed")
      return new Refusal("replayed");

    if (!sameHead(headOf(tx), chain))
      return new Refusal(chain.kind === "empty" ? "vault-exists" : "chain-moved");

    if (prepared instanceof Refusal) return prepared;

    try {
      return savepoint(tx, (inner) => {
        const answer = prepared(inner);
        if (answer instanceof Refusal) throw answer;
        return answer;
      });
    } catch (error) {
      const refusal = asRefusal(error);
      if (refusal === undefined) throw error;
      return refusal;
    }
  });

  if (!(answer instanceof Refusal) && answer.chain !== undefined) hub.memo.adopt(answer.chain);

  return answer;
}

async function answered(
  hub: Hub,
  spent: Spent | undefined,
  chain: Chain,
  against: (chain: Chain) => Promise<Effect | Refusal>,
): Promise<Answer> {
  const prepared = await against(chain);
  if (sameHead(headOf(hub.db), chain)) return settled(hub, spent, chain, prepared);

  const moved = await hub.memo.current(hub.db);
  return settled(hub, spent, moved, await settle(() => against(moved)));
}

function candidateOf(hub: Hub, chain: Chain, device: Id | "recovery"): Candidate {
  const candidate = identify(hub.db, chain, device);
  if (candidate === undefined) throw new Refusal("device-unknown");
  return candidate;
}

function respond(answer: Answer, incarnation: Id): Response {
  const headers = { "x-skills-incarnation": incarnation };
  if (!(answer instanceof Refusal))
    return Response.json(answer.body, { status: answer.status, headers });

  if (answer.reason === "protocol")
    return new Response(protocolSentence(String(answer.detail.spoken)), {
      status: answer.status,
      headers: { ...headers, "content-type": "text/plain; charset=utf-8" },
    });

  return Response.json(refusalJson(answer), { status: answer.status, headers });
}

async function admit(hub: Hub, request: Request, trace: Trace): Promise<Answer> {
  const url = new URL(request.url);
  const { route, params } = match(request.method, url.pathname, trace);
  if (route.access.kind === "open")
    return {
      status: 200,
      body: { min: PROTOCOL, max: PROTOCOL, incarnation: hub.incarnations.current },
    };

  checkProtocol(request.headers);
  const base = { params, query: url.searchParams, hub };

  if (route.access.kind === "unsigned") {
    const body = await readBody(request, route.limit);
    const chain = await hub.memo.current(hub.db);
    return answered(hub, undefined, chain, (current) =>
      settle(() => route.prepare({ ...base, body, chain: current, caller: { kind: "anonymous" } })),
    );
  }

  const signed = signatureHeaders(request.headers);
  if (Math.abs(hub.now() - signed.time) > SKEW) throw new Refusal("clock");

  const chain = await hub.memo.current(hub.db);
  const first = candidateOf(hub, chain, signed.device);

  const body = await readBody(request, route.limit);
  const method = request.method as Method;
  const parts = {
    method,
    path: url.pathname + url.search,
    body,
    time: signed.time,
    device: signed.device,
  };

  const digest = new Uint8Array(new Bun.CryptoHasher("sha256").update(signed.signature).digest());
  return answered(hub, { digest, time: signed.time }, chain, async (current) => {
    const candidate = current === chain ? first : candidateOf(hub, current, signed.device);
    const principal = await authenticate(
      candidate,
      current,
      parts,
      signed.signature,
      hub.incarnations,
    );

    trace.device = "device" in principal ? principal.device : "recovery";

    return settle(async () =>
      route.prepare({
        ...base,
        body,
        chain: current,
        caller: admitCaller(route, principal, params),
      }),
    );
  });
}

async function handle(hub: Hub, request: Request): Promise<Response> {
  const trace: Trace = {
    method: isMethod(request.method) ? request.method : "-",
    path: "-",
    device: "-",
  };

  let answer: Answer;
  try {
    answer = await admit(hub, request, trace);
  } catch (error) {
    const refusal = asRefusal(error);
    if (refusal === undefined && !(error instanceof Aborted))
      process.stderr.write(
        `hub internal error: ${error instanceof Error ? error.name : "unknown"}\n`,
      );

    answer = refusal ?? new Refusal("internal");
  }

  const response = respond(answer, hub.incarnations.current);
  const status = request.signal.aborted ? "aborted" : response.status;
  hub.log(`${trace.method} ${trace.path} ${status} ${trace.device}`);

  return response;
}

function listenOn(listen: string): { hostname: string; port: number } {
  const found = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]*):(\d{1,5})$/.exec(listen);
  const port = Number(found?.[2]);
  if (found === null || port > 65535)
    throw new RangeError(`HUB_LISTEN is host:port, not ${listen}`);

  const host = found[1] ?? "";
  return { hostname: host === "" ? "0.0.0.0" : host.replace(/^\[|\]$/g, ""), port };
}

export async function startHub(options: HubOptions): Promise<RunningHub> {
  const { hostname, port } = listenOn(options.listen);
  const { db, incarnations } = openStore(options.data);

  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const memo = new ChainMemo();
    const chain = await memo.current(db);
    const initCode =
      chain.kind === "empty" ? toBase32(crypto.getRandomValues(new Uint8Array(16))) : undefined;

    const hub: Hub = { db, memo, incarnations, initCode, now: Date.now, log: options.log };
    server = Bun.serve({
      hostname,
      port,
      maxRequestBodySize: BODY_MAX,
      fetch: (request) => handle(hub, request),
    });

    const shown = hostname.includes(":") ? `[${hostname}]` : hostname;
    const url = `http://${shown}:${server.port}`;

    options.log(`listening ${url}`);
    if (initCode !== undefined) options.log(`init code ${initCode}`);

    const running = server;
    let stopping: Promise<void> | undefined;
    const stop = () => {
      stopping ??= running.stop().then(() => db.close());
      return stopping;
    };

    return { url, port: running.port ?? port, incarnation: incarnations.current, initCode, stop };
  } catch (error) {
    await server?.stop(true);
    db.close();
    throw error;
  }
}
