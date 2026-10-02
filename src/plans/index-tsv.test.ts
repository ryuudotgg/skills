import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, indexIn, readIndexTolerant } from "./index-tsv.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "skills-index-tsv-"));
  temporary.push(path);
  return path;
}

test.each(["\r\n", "\r", "\n"])("tolerant index splits %j and skips blank lines", (separator) => {
  const path = indexIn(directory());
  writeFileSync(path, ["", COLUMNS.join("\t"), "", "001\tfirst\tDOING", "002", ""].join(separator));

  const table = readIndexTolerant(path);
  expect(table.kind).toBe("rows");
  if (table.kind !== "rows") throw new Error("expected rows");

  expect(table.rows).toEqual([
    {
      id: "001",
      slug: "first",
      status: "DOING",
      pri: "",
      effort: "",
      blocked_by: "",
      ctx: "",
      branch: "",
      updated: "",
      note: "",
    },
    {
      id: "002",
      slug: "",
      status: "",
      pri: "",
      effort: "",
      blocked_by: "",
      ctx: "",
      branch: "",
      updated: "",
      note: "",
    },
  ]);
});

test("tolerant index rejects invalid UTF-8", () => {
  const path = indexIn(directory());
  writeFileSync(path, new Uint8Array([0xff]));
  expect(readIndexTolerant(path)).toEqual({ kind: "failed" });
});

test("tolerant index distinguishes absent files and directories", () => {
  const path = directory();
  expect(readIndexTolerant(indexIn(path))).toEqual({ kind: "absent" });
  expect(readIndexTolerant(path)).toEqual({ kind: "absent" });
});
