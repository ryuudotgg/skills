export class Cache {
  constructor() { this.entries = new Map(); }
  set(key, value, ttlMs, now = Date.now()) {
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }
  get(key, now = Date.now()) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= now) { this.entries.delete(key); return undefined; }
    return entry.value;
  }
}
