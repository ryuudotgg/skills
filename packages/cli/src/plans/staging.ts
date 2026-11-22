import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

const NAME_MAX = 255;

export const STAGING = new RegExp(`(\\.\\d+\\.${UUID}|(^|/)\\.plans-${UUID})\\.tmp$`);

export function stagingName(path: string, { named = false } = {}): string {
  const tail = `.${process.pid}.${randomUUID()}.tmp`;
  if (named || Buffer.byteLength(basename(path)) + tail.length <= NAME_MAX) return `${path}${tail}`;
  return join(dirname(path), tail);
}
