import test from "node:test";
import assert from "node:assert/strict";
import { slugify } from "../src/slug.js";

test("lowercases and hyphenates", () => {
  assert.equal(slugify("Hello World"), "hello-world");
});

test("collapses runs of separators", () => {
  assert.equal(slugify("hello   world"), "hello-world");
  assert.equal(slugify("a -- b"), "a-b");
});

test("trims leading and trailing separators", () => {
  assert.equal(slugify("  hello!  "), "hello");
});
