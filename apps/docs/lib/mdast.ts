import type { InlineCode, PhrasingContent, Table, TableCell, TableRow, Text } from "mdast";

export function text(value: string): Text {
  return { type: "text", value };
}

export function code(value: string): InlineCode {
  return { type: "inlineCode", value };
}

function cell(children: PhrasingContent[]): TableCell {
  return { type: "tableCell", children };
}

export function row(cells: PhrasingContent[][]): TableRow {
  return { type: "tableRow", children: cells.map((children) => cell(children)) };
}

export function table(headers: string[], rows: TableRow[]): Table {
  return { type: "table", children: [row(headers.map((header) => [text(header)])), ...rows] };
}
