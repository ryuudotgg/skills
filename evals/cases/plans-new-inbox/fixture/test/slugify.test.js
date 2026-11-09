import assert from "node:assert/strict";
import { test } from "node:test";
import { slugify } from "../src/slugify.js";

test("joins words with one dash", () => {
  assert.equal(slugify("Hello,  World!"), "hello-world");
});
