const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const DAY_MS = 86_400_000;
export function parseTime(text: string): number | undefined {
  const date = DATE.exec(text);
  if (date) {
    const start = Date.UTC(Number(date[1]), Number(date[2]) - 1, Number(date[3]));
    const valid = new Date(start).toISOString().startsWith(text);
    return valid ? start + DAY_MS - 1 : undefined;
  }

  if (!INSTANT.test(text)) return undefined;

  const at = Date.parse(text);
  if (Number.isNaN(at)) return undefined;

  return new Date(at).toISOString().slice(0, 19) === text.slice(0, 19) ? at : undefined;
}

export function instantText(at: number): string {
  const iso = new Date(at).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, 19)}Z` : iso;
}
