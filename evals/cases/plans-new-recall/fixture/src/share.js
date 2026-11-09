import { createHmac, timingSafeEqual } from "node:crypto";

const WEEK = 7 * 24 * 60 * 60 * 1000;

function sign(link, secret) {
  return createHmac("sha256", secret)
    .update(`${link.id}\n${link.documentId}\n${link.expiresAt}`)
    .digest("hex");
}

export function createShareLink(document, secret, now = Date.now()) {
  const link = { id: `${document.id}-${now}`, documentId: document.id, expiresAt: now + WEEK };
  return { ...link, token: sign(link, secret) };
}

export function openShareLink(link, documents, secret, now = Date.now()) {
  const expected = Buffer.from(sign(link, secret));
  const given = Buffer.from(String(link.token ?? ""));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (now >= link.expiresAt) return null;
  return documents.find((document) => document.id === link.documentId) ?? null;
}
