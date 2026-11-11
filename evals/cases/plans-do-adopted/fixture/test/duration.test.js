import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../src/duration.js";

test("minutes and seconds", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(59), "0:59");
});
