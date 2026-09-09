export class Cache {
  constructor(maxEntries = 100) { this.entries = new Map(); this.maxEntries = maxEntries; }
  set(key, value, ttlMs, now = Date.now()) {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }
  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt < now) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
}
