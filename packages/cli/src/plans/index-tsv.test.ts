import { expect, test } from "bun:test";
import { COLUMNS } from "skills-core";
import { decodeUtf8, parseIndexText } from "./index-tsv.ts";

test.each(["\r\n", "\r", "\n"])("index text splits %j and skips blank lines", (separator) => {
  const text = ["", COLUMNS.join("\t"), "", "001\tfirst\tDOING", "002", ""].join(separator);

  expect(parseIndexText(text)).toEqual([
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

test("decodeUtf8 rejects invalid UTF-8", () => {
  expect(() => decodeUtf8(new Uint8Array([0xff]))).toThrow(TypeError);
});
