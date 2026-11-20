import test from "node:test";
import assert from "node:assert/strict";
import { permalink } from "../src/permalink.js";

test("builds a dated permalink", () => {
  assert.equal(permalink({ year: 2026, title: "Hello World" }), "/2026/hello-world");
});

test("numbered posts keep their number", () => {
  assert.equal(permalink({ year: 2026, title: "Top 10 Tips!" }), "/2026/top-10-tips");
  assert.notEqual(
    permalink({ year: 2026, title: "Top 10 Tips!" }),
    permalink({ year: 2026, title: "Top 5 Tips!" }),
  );
});
