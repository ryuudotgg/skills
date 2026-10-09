import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFastModes } from "./fast-mode.ts";
import { removeTemporary } from "./test/process.ts";

let temporary: string;
let conf: string;

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), "skills-fast-mode-"));
  conf = join(temporary, "skills.conf");
});

afterEach(async () => {
  await removeTemporary(temporary);
});

async function fastModes(content: string) {
  await writeFile(conf, content);
  return readFastModes({ SKILLS_CONF: conf });
}

test("no config leaves both providers off", () => {
  expect(readFastModes({ SKILLS_CONF: conf })).toEqual({
    modes: { codex: false, claude: false },
    notes: [],
  });
});

test("each provider reads its own key", async () => {
  expect((await fastModes("DELIVERY=prs\nCODEX_FAST_MODE=yes\n")).modes).toEqual({
    codex: true,
    claude: false,
  });

  expect((await fastModes("CODEX_FAST_MODE=no\nCLAUDE_FAST_MODE=yes\r\n")).modes).toEqual({
    codex: false,
    claude: true,
  });
});

test("invalid and repeated values are noted and stay off", async () => {
  const result = await fastModes(
    "CODEX_FAST_MODE=on\nCLAUDE_FAST_MODE=yes\nCLAUDE_FAST_MODE=yes\n",
  );

  expect(result.modes).toEqual({ codex: false, claude: false });
  expect(result.notes).toEqual([
    `${conf}: CODEX_FAST_MODE=on is not yes or no, skipped`,
    `${conf}: CLAUDE_FAST_MODE is set more than once, skipped`,
  ]);
});

test("a malformed config turns both off", async () => {
  expect((await fastModes("CODEX_FAST_MODE=yes\nnonsense\n")).modes).toEqual({
    codex: false,
    claude: false,
  });
});
