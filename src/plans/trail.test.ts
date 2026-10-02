import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTrail, readTrailTolerant, TRAIL_COLUMNS, trailIn } from "./trail.ts";

const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function directory(): string {
  const path = mkdtempSync(join(tmpdir(), "skills-trail-"));
  temporary.push(path);
  return path;
}

test.each(["\r\n", "\r", "\n"])("tolerant trail splits %j and fills short rows", (separator) => {
  const path = trailIn(directory());
  const line = "2026-10-02T00:00:00Z\tSkills\t134\tstart\tfeat/topic";
  writeFileSync(path, ["", TRAIL_COLUMNS.join("\t"), "", line, "short", ""].join(separator));

  expect(readTrailTolerant(path)).toEqual({ kind: "rows", rows: [
    { ts: "2026-10-02T00:00:00Z", project: "Skills", id: "134", event: "start", detail: "feat/topic", line },
    { ts: "short", project: "", id: "", event: "", detail: "", line: "short" },
  ] });
});

test("tolerant trail rejects invalid UTF-8", () => {
  const path = trailIn(directory());
  writeFileSync(path, new Uint8Array([0xc3, 0x28]));
  expect(readTrailTolerant(path)).toEqual({ kind: "failed" });
});

test("tolerant trail reports missing files and directories as absent", () => {
  const path = directory();
  expect(readTrailTolerant(trailIn(path))).toEqual({ kind: "absent" });
  expect(readTrailTolerant(path)).toEqual({ kind: "absent" });
});

test("strict trail preserves stored record text and trailing blank row", () => {
  const path = trailIn(directory());
  const line = "stamp\tSkills\t134\tstart\tfeat/topic\r";
  writeFileSync(path, `${TRAIL_COLUMNS.join("\t")}\n${line}\n`);

  expect(readTrail(path).map((entry) => entry.line)).toEqual([line, ""]);
});
