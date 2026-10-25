export function createShareLink(document, now = Date.now()) {
  return { id: `${document.id}-${now}`, documentId: document.id, createdAt: now };
}

export function openShareLink(link, documents) {
  return documents.find((document) => document.id === link.documentId) ?? null;
}
