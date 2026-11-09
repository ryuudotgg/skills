import assert from "node:assert/strict";
import { test } from "node:test";
import { createShareLink, openShareLink } from "../src/share.js";

const documents = [{ id: "doc" }];

test("a signed link opens its document", () => {
  const link = createShareLink(documents[0], "secret", 0);
  assert.equal(openShareLink(link, documents, "secret", 1), documents[0]);
});

test("an altered token does not open", () => {
  const link = { ...createShareLink(documents[0], "secret", 0), token: "0".repeat(64) };
  assert.equal(openShareLink(link, documents, "secret", 1), null);
});

test("a link expires after seven days", () => {
  const link = createShareLink(documents[0], "secret", 0);
  assert.equal(openShareLink(link, documents, "secret", 7 * 24 * 60 * 60 * 1000), null);
});

test("a link edited to name another document does not open", () => {
  const link = { ...createShareLink(documents[0], "secret", 0), documentId: "other" };
  assert.equal(openShareLink(link, [...documents, { id: "other" }], "secret", 1), null);
});
