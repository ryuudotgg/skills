import { timingSafeEqual } from "node:crypto";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { feedLines } from "skills-core";
import { blobBytes, eventsAfter, openReadOnly } from "../plans/store.ts";
import { sessionDigest, withheldSessions } from "../sessions/show.ts";

export type Site = { token: string; dist: string; plansDb: string; env: NodeJS.ProcessEnv };

const PRIVATE = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

const PAGE_POLICY =
  "default-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const CURSOR = /^[0-9a-f-]{1,64}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function text(status: number, body: string): Response {
  return new Response(`${body}\n`, {
    status,
    headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function bearer(request: Request, token: string): boolean {
  const header = request.headers.get("Authorization") ?? "";
  const given = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${token}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

function withStore<T>(site: Site, read: (db: ReturnType<typeof openReadOnly>) => T): T | undefined {
  if (!existsSync(site.plansDb)) return undefined;

  const db = openReadOnly(site.plansDb);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

const GONE = "unknown cursor, read the feed from the start";
function feed(site: Site, url: URL): Response {
  const after = url.searchParams.get("after") || undefined;
  if (after !== undefined && !CURSOR.test(after)) return text(400, "not a cursor");

  const page = withStore(site, (db) => eventsAfter(db, after));
  if (page?.kind === "unknown" || (page === undefined && after !== undefined))
    return text(410, GONE);

  return new Response(feedLines(page?.events ?? []), {
    headers: { ...PRIVATE, "Content-Type": "application/x-ndjson; charset=utf-8" },
  });
}

function blob(site: Site, sha256: string): Response {
  if (!SHA256.test(sha256)) return text(404, "no such blob");

  const bytes = withStore(site, (db) => blobBytes(db, sha256));
  if (bytes === undefined) return text(404, "no such blob");

  return new Response(new Uint8Array(bytes), {
    headers: { ...PRIVATE, "Content-Type": "application/octet-stream" },
  });
}

const NO_DIGEST = "no digest for this session";
function digest(site: Site, session: string): Response {
  const root = dirname(site.plansDb);
  const found = withStore(site, (db) => sessionDigest(db, root, site.env, session));
  if (found?.kind === "refused") return text(403, found.policy);
  if (found?.kind !== "shown") return text(404, NO_DIGEST);

  return new Response(found.text, {
    headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function withheld(site: Site): Response {
  const keys = withStore(site, (db) => withheldSessions(db, dirname(site.plansDb))) ?? [];
  return new Response(keys.map((key) => `${key}\n`).join(""), {
    headers: { ...PRIVATE, "Content-Type": "text/plain; charset=utf-8" },
  });
}

type Endpoint = (site: Site, url: URL) => Response;

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function endpoint(segments: readonly string[]): Endpoint | undefined {
  const [area, first, second, ...extra] = segments;
  if (area === "feed") return first === undefined ? feed : () => text(404, "not found");
  if (area === "withheld") return first === undefined ? withheld : () => text(404, "not found");
  if (area === "blobs")
    return second === undefined ? (site) => blob(site, first ?? "") : () => text(404, "not found");

  if (area === "sessions" && first && second === "digest" && extra.length === 0)
    return (site) => {
      const session = decoded(first);
      return session === undefined ? text(404, NO_DIGEST) : digest(site, session);
    };

  return undefined;
}

function inside(root: string, path: string): string | undefined {
  try {
    const real = realpathSync(path);
    return real.startsWith(root + sep) ? real : undefined;
  } catch {
    return undefined;
  }
}

export function dashHandler(site: Site): (request: Request, host: string) => Response {
  const root = realpathSync(site.dist);
  const assets = new Set(readdirSync(root).filter((name) => name !== "index.html"));

  const shell = () => {
    const page = inside(root, join(root, "index.html"));
    if (!page) return text(404, "no index.html in the build");

    return new Response(Bun.file(page), {
      headers: {
        ...PRIVATE,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": PAGE_POLICY,
      },
    });
  };

  return (request, host) => {
    if (request.headers.get("Host") !== host) return text(403, "wrong host");
    if (request.method !== "GET") return text(405, "only GET");

    const url = new URL(request.url);
    const [, area = "", ...rest] = url.pathname.split("/");
    const api = endpoint([area, ...rest]);
    if (api) {
      if (!bearer(request, site.token)) return text(401, "missing or wrong token");

      try {
        return api(site, url);
      } catch (error) {
        return text(503, error instanceof Error ? error.message : String(error));
      }
    }

    const asset =
      rest.length === 0 && assets.has(area) ? inside(root, join(root, area)) : undefined;

    if (asset) return new Response(Bun.file(asset), { headers: PRIVATE });

    return shell();
  };
}
