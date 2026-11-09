import { expect, test } from "bun:test";
import { randomId } from "skills-core";
import {
  authored,
  currentKey,
  enroll,
  hubPool,
  push,
  revoke,
  sealBlob,
  send,
  wire,
} from "./harness.ts";

const { vault } = hubPool();

test("a blob is stored once and answers what it holds", async () => {
  const v = await vault();
  const id = randomId();
  const envelope = await sealBlob(currentKey(v), id, "plan text");

  const stored = await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, { envelope });
  const again = await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, { envelope });
  const other = await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "other text"),
  });

  const fetched = await send(v.hub, v.founder, "GET", `/v1/blobs/${id}`);
  const missing = await send(v.hub, v.founder, "GET", `/v1/blobs/${randomId()}`);

  expect([stored.status, again.status]).toEqual([201, 200]);
  expect([other.status, other.json.reason]).toEqual([409, "blob-conflict"]);
  expect(fetched.json.envelope).toBe(envelope);
  expect([missing.status, missing.json.reason]).toEqual([404, "blob-missing"]);
});

test("a deleted blob answers 410 with its blob-deleted event", async () => {
  const v = await vault();
  const id = randomId();
  await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "transcript"),
  });

  const deletion = await authored(v.founder, currentKey(v), { type: "blob-deleted", blob: id });
  expect((await push(v, v.founder, [deletion])).status).toBe(200);

  const deleted = await send(v.hub, v.founder, "DELETE", `/v1/blobs/${id}`, { event: deletion.id });
  const fetched = await send(v.hub, v.founder, "GET", `/v1/blobs/${id}`);
  const reupload = await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "transcript"),
  });

  const have = await send(v.hub, v.founder, "POST", "/v1/blobs/have", { ids: [id, randomId()] });

  expect(deleted.status).toBe(200);
  expect([fetched.status, fetched.json.reason]).toEqual([410, "blob-deleted"]);
  expect(fetched.json.event).toEqual(wire(deletion));
  expect(reupload.status).toBe(410);

  expect(have.json.deleted).toEqual([id]);
  expect((have.json.missing as string[]).length).toBe(1);
});

test("a surviving member restores a deletion another device authored", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");
  const id = randomId();
  const deletion = await authored(laptop, currentKey(v), { type: "blob-deleted", blob: id });

  await push(v, laptop, [deletion]);
  await revoke(v, laptop);

  const restored = await send(v.hub, v.founder, "DELETE", `/v1/blobs/${id}`, {
    event: deletion.id,
  });

  const fetched = await send(v.hub, v.founder, "GET", `/v1/blobs/${id}`);
  const unknown = await send(v.hub, v.founder, "DELETE", `/v1/blobs/${randomId()}`, {
    event: Bun.randomUUIDv7("hex"),
  });

  expect(restored.status).toBe(200);
  expect([fetched.status, fetched.json.event]).toEqual([410, wire(deletion)]);
  expect([unknown.status, unknown.json.reason]).toEqual([409, "tombstone-event"]);
});
