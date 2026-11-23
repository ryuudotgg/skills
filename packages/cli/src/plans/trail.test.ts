import { expect, test } from "bun:test";
import { TRAIL_COLUMNS } from "skills-core";
import { parseTrailText } from "./trail.ts";

test.each(["\r\n", "\r", "\n"])("trail text splits %j and fills short rows", (separator) => {
  const line = "2026-10-02T00:00:00Z\tSkills\t134\tstart\tfeat/topic";
  const text = ["", TRAIL_COLUMNS.join("\t"), "", line, "short", ""].join(separator);

  expect(parseTrailText(text)).toEqual([
    {
      ts: "2026-10-02T00:00:00Z",
      project: "Skills",
      id: "134",
      event: "start",
      detail: "feat/topic",
      line,
    },
    { ts: "short", project: "", id: "", event: "", detail: "", line: "short" },
  ]);
});
