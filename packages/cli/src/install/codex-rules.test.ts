import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readDeliveryConfig } from "../delivery.ts";
import { applyCodexRules } from "./codex-rules.ts";

const directories: string[] = [];
const root = resolve(import.meta.dir, "../../../../skills");

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

test("an invalid skills.conf names the conf path", () => {
  const home = mkdtempSync(join(tmpdir(), "skills-codex-rules-"));
  directories.push(home);

  const codex = join(home, ".codex");
  const conf = join(home, "skills.conf");
  mkdirSync(conf);

  const output = applyCodexRules({
    root,
    home,
    codex,
    agents: join(home, ".agents/skills"),
    mode: "prs",
    current: {
      claude: join(home, ".claude"),
      agents: join(home, ".agents/skills"),
      conf,
      codex,
      checkout: "/checkout",
    },
    config: readDeliveryConfig({ SKILLS_CONF: conf }),
    env: {},
    stdin: {},
    stdout: {},
  });

  expect(output).toEqual([`skip   ${join(codex, "rules/skills.rules")} (${conf} is invalid)`]);
});
