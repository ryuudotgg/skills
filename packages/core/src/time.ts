const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
export const DAY_MS = 86_400_000;
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

export function isoWeek(at: number): string {
  const date = new Date(at);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const thursday = midnight + (3 - ((date.getUTCDay() + 6) % 7)) * DAY_MS;

  const year = new Date(thursday).getUTCFullYear();
  const week = 1 + Math.floor((thursday - Date.UTC(year, 0, 1)) / (7 * DAY_MS));
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export function instantText(at: number): string {
  const iso = new Date(at).toISOString();
  return iso.endsWith(".000Z") ? `${iso.slice(0, 19)}Z` : iso;
}

export function durationText(milliseconds: number): string {
  if (milliseconds < 59_500) return `${Math.round(milliseconds / 1000)} s`;

  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;

  const rest = minutes % 60;
  const hours = `${Math.floor(minutes / 60)} h`;
  return rest === 0 ? hours : `${hours} ${rest} min`;
}
