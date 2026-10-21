import { expect, test } from "bun:test";
import { editJsoncArrays, parseJsonc } from "./jsonc.ts";
import { JsonNumber } from "./json.ts";

test("JSONC preserves comments, trailing commas, number text and CRLF", () => {
  const text =
    '{\r\n\t// personal settings\r\n\t"number": 1e+02,\r\n\t"permissions": [\r\n\t\t{ "action": "shell", "resource": "rm -rf *", "effect": "ask" },\r\n\t],\r\n}\r\n';

  const written = editJsoncArrays(parseJsonc(text), {
    permissions: {
      keep: [0],
      append: [{ action: "shell", resource: "gh pr merge *", effect: "ask" }],
    },
  });

  expect(written).toContain('\t// personal settings\r\n\t"number": 1e+02,\r\n');
  expect(written).toContain(
    '\t\t{ "action": "shell", "resource": "rm -rf *", "effect": "ask" },\r\n',
  );

  expect(written).toContain(
    '\t\t{ "action": "shell", "resource": "gh pr merge *", "effect": "ask" },\r\n',
  );

  expect(written.replaceAll("\r\n", "")).not.toContain("\n");
  expect(
    editJsoncArrays(parseJsonc(written), {
      permissions: {
        keep: [0],
        append: [{ action: "shell", resource: "gh pr merge *", effect: "ask" }],
      },
    }),
  ).toBe(written);
});

test.each([
  "[1,2,3]",
  "[1,2,3,]",
  "[\n  1,\n  2,\n  3\n]",
  "[\n  1,\n  2,\n  3,\n]",
  "[1 /*first*/, /*second*/ 2, 3 /*last*/]",
  "[1,2,3, // tail\n]",
])("JSONC removes any subset of owned items in %s", (array) => {
  for (let mask = 0; mask < 8; mask++)
    for (const append of [[], [new JsonNumber("4")]]) {
      const keep = [0, 1, 2].filter((index) => mask & (1 << index));
      const original = `{"permissions":${array}}`;
      const result = editJsoncArrays(parseJsonc(original), { permissions: { keep, append } });

      expect(parseJsonc(result).data.permissions).toEqual([
        ...keep.map((index) => new JsonNumber(String(index + 1))),
        ...append,
      ]);

      for (const comment of original.match(/\/\*.*?\*\/|\/\/[^\n]*/g) ?? [])
        expect(result).toContain(comment);
    }
});

test("JSONC strings containing comment markers, escaped quotes and delimiters stay intact", () => {
  const text = '{"url":"https://host/a/*b*/", "permissions":["\\\"],//", {"nested":[1,2,],},],}';
  const parsed = parseJsonc(text);

  expect(parsed.data.url).toBe("https://host/a/*b*/");
  expect(editJsoncArrays(parsed, { permissions: { keep: [0, 1], append: [] } })).toBe(text);
});

test.each(["{}", "{\n}", '{"number":2.00}', '{\n  "number":2.00, // keep\n}\n'])(
  "JSONC adds missing arrays without rewriting other properties in %s",
  (text) => {
    const result = editJsoncArrays(parseJsonc(text), {
      permissions: { keep: [], append: [{ effect: "ask" }] },
      policies: { keep: [], append: [{ effect: "deny" }] },
    });

    const parsed = parseJsonc(result);

    expect(parsed.data.permissions).toEqual([{ effect: "ask" }]);
    expect(parsed.data.policies).toEqual([{ effect: "deny" }]);
    if (text.includes('"number":2.00')) expect(result).toContain('"number":2.00');
    if (text.includes("// keep")) expect(result).toContain("// keep");
    expect(result.endsWith("\n")).toBe(text.endsWith("\n"));
  },
);

test.each([
  "\uFEFF{}",
  '{"x":1,"x":2}',
  '{"nested":{"x":1,"x":2}}',
  "[]",
  '{"x": /* unfinished',
  '{"x": [1,,]}',
  '{"other":{"bad":[,]}}',
  '{"x":{,}}',
  '{"x":[,]}',
  '{"x":undefined}',
])("JSONC refuses malformed or ambiguous documents: %s", (text) => {
  expect(() => parseJsonc(text)).toThrow();
});

test("JSONC does not create an empty array", () => {
  expect(editJsoncArrays(parseJsonc("{}"), { policies: { keep: [], append: [] } })).toBe("{}");
});

test.each(["\n", "\r\n"])(
  "JSONC removes owned lines and their trailing comments with %j",
  (newline) => {
    const before = [
      "{",
      '  "permissions": [',
      '    "owned", // belongs to owned',
      '    "personal", // keep personal',
      '    "removed"  ',
      "  ],",
      '  "untouched": [1,],',
      "}",
      "",
    ].join(newline);

    const expected = [
      "{",
      '  "permissions": [',
      '    "personal" // keep personal',
      "  ],",
      '  "untouched": [1,],',
      "}",
      "",
    ].join(newline);

    const after = editJsoncArrays(parseJsonc(before), { permissions: { keep: [1], append: [] } });

    expect(after).toBe(expected);
    expect(parseJsonc(after).data.permissions).toEqual(["personal"]);
  },
);

test("JSONC value equality ignores object prototypes and property order", () => {
  const text = '{"permissions":[{ "effect":"ask", "nested":{"value":1e+02} }]}';
  const append = [{ nested: { value: new JsonNumber("1e+02") }, effect: "ask" }];
  expect(editJsoncArrays(parseJsonc(text), { permissions: { keep: [], append } })).toBe(text);
});
