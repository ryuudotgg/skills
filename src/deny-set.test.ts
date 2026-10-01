import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readDenySet } from "./deny-set.ts";
import { runCommand } from "./test/process.ts";

const repo = resolve(import.meta.dir, "..");
const directories: string[] = [];

function fixture(content: string): string {
  const root = mkdtempSync(join(tmpdir(), "deny-set-"));
  directories.push(root);
  mkdirSync(join(root, "playbook/references"), { recursive: true });
  writeFileSync(join(root, "playbook/references/delivery.md"), content);

  return root;
}

afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe("deny set", () => {
  test("shipped rows match deny-set.sh", async () => {
    const result = await runCommand(["sh", "skills/playbook/scripts/deny-set.sh"], { cwd: repo });
    expect(result.code).toBe(0);

    const rows = result.stdout.replace(/\n$/, "").split("\n").map((line) => {
      const [handsOff, prs, ...entries] = line.split("\t");
      return { handsOff, prs, entries };
    });

    expect(rows).toEqual(readDenySet(join(repo, "skills")));
  });

  test("reads a CRLF table", () => {
    const root = fixture("## Deny set per mode\r\n| `entry` | deny | allow |\r\n## Next\r\n");
    expect(readDenySet(root)).toEqual([{ handsOff: "deny", prs: "allow", entries: ["entry"] }]);
  });

  test.each([
    "| `entry` | invalid | allow |",
    "| `entry` | deny | invalid |",
  ])("refuses an invalid action: %s", (row) => {
    const root = fixture(`## Deny set per mode\n${row}\n`);

    expect(() => readDenySet(root)).toThrow(
      `deny-set: delivery.md deny row is neither deny nor allow: ${row}`,
    );
  });

  test("refuses a row without backticked entries", () => {
    const row = "| missing backticks | deny | allow |";
    const root = fixture(`## Deny set per mode\n${row}\n`);

    expect(() => readDenySet(root)).toThrow(
      `deny-set: delivery.md deny row has no backticked entry: ${row}`,
    );
  });

  test("refuses an empty table and stops at the next heading", () => {
    const root = fixture(
      "## Deny set per mode\n| entry | hands-off | prs |\n| --- | --- | --- |\n## Next\n| `entry` | deny | allow |\n",
    );

    expect(() => readDenySet(root)).toThrow(
      "deny-set: no deny rows under ## Deny set per mode in delivery.md",
    );
  });
});
