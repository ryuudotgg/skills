import { expect, test } from "bun:test";
import { readFrontmatter } from "./frontmatter.ts";

test.each([
  ["", "missing"],
  [" ---\n---", "missing"],
  ["--- x\n---", "missing"],
  ["---\r\r\n---", "missing"],
  ["---", "unclosed"],
  ["---\nname: demo\n----", "unclosed"],
  ["---\nname: demo\n--- x", "unclosed"],
  ["---\n---", "not-mapping"],
  ["---\nnull\n---", "not-mapping"],
  ["---\nplain\n---", "not-mapping"],
  ["---\n- demo\n---", "not-mapping"],
  ["---\nname: [\n---", "invalid"],
] as const)("reads %j as %s", (text, kind) => {
  expect(readFrontmatter(text, Bun.YAML.parse).kind).toBe(kind);
});

test("passes only normalized frontmatter to the parser", () => {
  const inputs: string[] = [];
  const result = readFrontmatter("---\r\nname: demo\r\n---\r\nbody\n---", (yaml) => {
    inputs.push(yaml);
    return { name: "demo" };
  });

  expect(inputs).toEqual(["name: demo"]);
  expect(result).toEqual({
    kind: "mapping",
    data: { name: "demo" },
    lines: new Map([["name", 2]]),
  });
});

test("retains the full parse exception message", () => {
  const result = readFrontmatter("---\nname: demo\n---", () => {
    throw new Error("first line\nsecond line");
  });

  expect(result).toEqual({ kind: "invalid", message: "first line\nsecond line" });
});

test.each([
  "requires: other\nrequires: prs",
  "requires: other\n'requires': prs",
  'requires: other\n"requires" : prs',
  'requires: other\n"requ\\u0069res": prs',
])("rejects duplicate keys in %j", (yaml) => {
  expect(readFrontmatter(`---\n${yaml}\n---`, Bun.YAML.parse)).toEqual({
    kind: "invalid",
    message: "duplicate key requires",
  });
});

test.each([
  ["optional: true\nrequires: other\n? requires\n: prs", "line 4 is not a plain key"],
  ["{optional: true, requires: other, requires: prs}", "line 2 is not a plain key"],
  ["base: &base {requires: other}\n<<: *base\noptional: true", "line 3 is not a plain key"],
])("rejects key forms the duplicate scan cannot compare in %j", (yaml, message) => {
  expect(readFrontmatter(`---\n${yaml}\n---`, Bun.YAML.parse)).toEqual({
    kind: "invalid",
    message,
  });
});

test("reads a block sequence written at column zero as its key's value", () => {
  const result = readFrontmatter("---\ntags:\n- example\n-\noptional: true\n---", Bun.YAML.parse);

  expect(result).toEqual({
    kind: "mapping",
    data: { tags: ["example", null], optional: true },
    lines: new Map([
      ["tags", 2],
      ["optional", 5],
    ]),
  });
});

test("records file lines for unquoted and quoted top level keys", () => {
  const result = readFrontmatter(
    "---\n# comment: ignored\nname: demo\n\n'optional' : true\nmetadata:\n  requires: other\n\"requires\": prs\ndescription: |\n  requires: a token\n---",
    Bun.YAML.parse,
  );

  expect(result.kind).toBe("mapping");
  if (result.kind !== "mapping") throw new Error("expected mapping");

  expect([...result.lines]).toEqual([
    ["name", 3],
    ["optional", 5],
    ["metadata", 6],
    ["requires", 8],
    ["description", 9],
  ]);

  expect(result.data.description).toBe("requires: a token\n");
});
