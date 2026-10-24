import test from "node:test";
import assert from "node:assert/strict";
import { greeting } from "../src/greeting.js";

test("greets a member by name", () => {
  assert.equal(greeting({ name: "Ada" }), "Hello, Ada");
});

test("greets a member who left the room as a guest", () => {
  assert.equal(greeting(null), "Hello, guest");
});
