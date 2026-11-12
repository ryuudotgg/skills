import assert from "node:assert/strict";
import { test } from "node:test";
import { formatDuration } from "../src/duration.js";

test("minutes and seconds", () => {
  assert.equal(formatDuration(65), "1:05");
  assert.equal(formatDuration(59), "0:59");
});

test("hours once a duration reaches an hour", () => {
  assert.equal(formatDuration(3600), "1:00:00");
  assert.equal(formatDuration(3725), "1:02:05");
});
