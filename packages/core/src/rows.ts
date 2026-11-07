export const COLUMNS = [
  "id",
  "slug",
  "status",
  "pri",
  "effort",
  "blocked_by",
  "ctx",
  "branch",
  "updated",
  "note",
] as const;

export const STATUSES = ["TODO", "DOING", "DONE", "DROPPED", "BLOCKED", "REVIEW"] as const;

export type Status = (typeof STATUSES)[number];
export type IndexRow = Record<(typeof COLUMNS)[number], string>;

export function flatten(value: string): string {
  return value.replace(/[\t\r\n]/g, " ");
}

export function isStatus(value: string): value is Status {
  return (STATUSES as readonly string[]).includes(value);
}

export function flatRow(row: IndexRow): IndexRow {
  return Object.fromEntries(
    COLUMNS.map((column) => [column, flatten(row[column] ?? "")]),
  ) as IndexRow;
}

export function formatRow(row: IndexRow): string {
  return COLUMNS.map((column) => flatten(row[column])).join("\t");
}

export function rowKey(row: Pick<IndexRow, "id" | "slug">): string {
  return `${row.id}\t${row.slug}`;
}

export function renderIndex(rows: Iterable<IndexRow>): string {
  return [COLUMNS.join("\t"), ...Array.from(rows, formatRow)].map((line) => `${line}\n`).join("");
}
