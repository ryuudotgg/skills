import { afterEach, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { once } from "node:events";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { randomId, type Id } from "skills-core";
import type { HubFixture } from "../../../packages/cli/src/test/hub-fixture.ts";
import { blobRoutes } from "../src/blobs.ts";
import {
  currentKey,
  hubPool,
  prepare,
  sealBlob,
  send,
  type Prepared,
  type Vault,
} from "./harness.ts";

const { vault } = hubPool();

const restores: (() => void)[] = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

async function within<T>(promise: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 5000);
  });

  try {
    return await Promise.race([promise, late]);
  } finally {
    clearTimeout(timer);
  }
}

function captureStderr(): string[] {
  const written: string[] = [];
  const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  });

  restores.push(() => spy.mockRestore());
  return written;
}

function failingUploads(fault: () => Promise<void>): void {
  const route = blobRoutes.find((each) => each.method === "PUT");
  if (route === undefined) throw new TypeError("the hub routes blob uploads");

  const spy = spyOn(route, "prepare").mockImplementation(async () => {
    await fault();
    throw new Error("handler fault");
  });

  restores.push(() => spy.mockRestore());
}

function bodyReadStarts(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const proto = ReadableStream.prototype as unknown as Record<symbol, () => unknown>;
  const original = proto[Symbol.asyncIterator];
  if (original === undefined) throw new TypeError("ReadableStream is not async iterable here");

  const restore = () => {
    proto[Symbol.asyncIterator] = original;
  };

  proto[Symbol.asyncIterator] = function (this: unknown) {
    restore();
    resolve();
    return original.call(this);
  };

  restores.push(restore);
  return within(promise, "the hub to begin reading the body");
}

function accessLines(hub: HubFixture, prefix: string): string[] {
  return readFileSync(join(hub.dir, "hub.log"), "utf8")
    .split("\n")
    .filter((line) => line.startsWith(prefix));
}

async function loggedOnce(hub: HubFixture, prefix: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (accessLines(hub, prefix).length === 0) {
    if (Date.now() > deadline) throw new Error(`no access line for ${prefix}`);
    await Bun.sleep(10);
  }
}

async function upload(v: Vault, id: Id, size: number): Promise<Prepared> {
  return prepare(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "x".repeat(size)),
  });
}

async function sendThenDrop(
  hub: HubFixture,
  request: Prepared,
  sent: string,
  ready: Promise<void>,
): Promise<void> {
  const url = new URL(hub.url);
  const socket: Socket = connect(Number(url.port), url.hostname);
  try {
    await within(once(socket, "connect"), "the hub to accept the connection");

    const head = [
      `${request.method} ${request.path} HTTP/1.1`,
      `host: ${url.host}`,
      `content-length: ${Buffer.byteLength(request.body)}`,
      ...Object.entries(request.headers).map(([name, value]) => `${name}: ${value}`),
      "",
      "",
    ].join("\r\n");

    socket.write(head + sent);
    await ready;
  } finally {
    socket.destroy();
  }
}

test("an upload aborted mid body logs one aborted line and no internal error", async () => {
  const v = await vault();
  const id = randomId();
  const request = await upload(v, id, 512 * 1024);
  const errors = captureStderr();

  await sendThenDrop(
    v.hub,
    request,
    request.body.slice(0, request.body.length / 2),
    bodyReadStarts(),
  );

  await loggedOnce(v.hub, `PUT /v1/blobs/${id} `);

  const fetched = await send(v.hub, v.founder, "GET", `/v1/blobs/${id}`);

  expect(accessLines(v.hub, `PUT /v1/blobs/${id} `)).toEqual([`PUT /v1/blobs/${id} aborted -`]);
  expect(errors).toEqual([]);
  expect(fetched.status).toBe(404);
});

test("a fault after the client aborted still writes its diagnostic", async () => {
  const v = await vault();
  const id = randomId();
  const request = await upload(v, id, 1024);
  const entered = Promise.withResolvers<void>();
  const dropped = Promise.withResolvers<void>();
  failingUploads(async () => {
    entered.resolve();
    await dropped.promise;
  });

  const errors = captureStderr();
  await sendThenDrop(v.hub, request, request.body, within(entered.promise, "the handler"));
  await Bun.sleep(50);
  dropped.resolve();
  await loggedOnce(v.hub, `PUT /v1/blobs/${id} `);

  expect(accessLines(v.hub, `PUT /v1/blobs/${id} `)).toEqual([
    `PUT /v1/blobs/${id} aborted ${v.founder.id}`,
  ]);

  expect(errors).toEqual(["hub internal error: Error\n"]);
});

test("a plain Error is not aborted: it logs an internal error and a 500", async () => {
  const v = await vault();
  const id = randomId();
  failingUploads(async () => {});

  const errors = captureStderr();
  const reply = await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "plan text"),
  });

  expect(reply.status).toBe(500);
  expect(errors).toEqual(["hub internal error: Error\n"]);
  expect(accessLines(v.hub, `PUT /v1/blobs/${id} `)).toEqual([
    `PUT /v1/blobs/${id} 500 ${v.founder.id}`,
  ]);
});
