import { expect, test } from "bun:test";
import { BLOB_MAX, randomId, type Id } from "skills-core";
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
import { recordStatements } from "./statements.ts";

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

test("a blob holds a one line transcript chunk past a mebibyte, up to the shared cap", async () => {
  const v = await vault();
  const [line, full, over] = [randomId(), randomId(), randomId()];
  const put = async (id: Id, size: number) =>
    send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
      envelope: await sealBlob(currentKey(v), id, "x".repeat(size)),
    });

  const one = await put(line, 1_100_000);
  const capped = await put(full, BLOB_MAX);
  const past = await put(over, BLOB_MAX + 1);

  expect([one.status, capped.status]).toEqual([201, 201]);
  expect([past.status, past.json.reason]).toEqual([413, "too-large"]);
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

test("a blob is deleted only on a signed request from a current member", async () => {
  const v = await vault();
  const laptop = await enroll(v, "laptop");
  const id = randomId();
  await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "transcript chunk"),
  });

  const deletion = await authored(v.founder, currentKey(v), { type: "blob-deleted", blob: id });
  await push(v, v.founder, [deletion]);
  await revoke(v, laptop);

  const unsigned = await send(v.hub, undefined, "DELETE", `/v1/blobs/${id}`, {
    event: deletion.id,
  });

  const revoked = await send(v.hub, laptop, "DELETE", `/v1/blobs/${id}`, { event: deletion.id });
  const kept = await send(v.hub, v.founder, "GET", `/v1/blobs/${id}`);
  const member = await send(v.hub, v.founder, "DELETE", `/v1/blobs/${id}`, { event: deletion.id });

  expect(unsigned.status).toBe(401);
  expect(revoked.status).toBe(403);
  expect(kept.status).toBe(200);
  expect([member.status, member.json.event]).toEqual([200, deletion.id]);
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

test("have loads no envelope", async () => {
  const v = await vault();
  const [id, unknown] = [randomId(), randomId()];
  await send(v.hub, v.founder, "PUT", `/v1/blobs/${id}`, {
    envelope: await sealBlob(currentKey(v), id, "plan text"),
  });

  const recording = recordStatements();
  const have = await send(v.hub, v.founder, "POST", "/v1/blobs/have", {
    ids: [id, id, unknown],
  }).finally(recording.stop);

  expect(have.json).toEqual({ missing: [unknown], deleted: [] });
  const blobRows = recording.rows.filter(
    (row) => typeof row === "object" && row !== null && "id" in row && row.id === id,
  );

  expect(recording.sql.filter((text) => text.includes("envelope"))).toEqual([]);
  expect(blobRows).toHaveLength(2);
  expect(blobRows.filter((row) => "envelope" in (row as object))).toEqual([]);
});
