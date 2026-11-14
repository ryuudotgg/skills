import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audit } from "../packages/cli/src/audit/audit.ts";
import { encodedName } from "../packages/cli/src/sessions/claude.ts";

const transcripts = 120;
const paddingEvents = 64;
const padding = "x".repeat(64 * 1024);
const limitMiB = 300;
const now = new Date("2026-11-01T00:00:00Z");

function transcript(cwd: string, index: number): string {
  const start = Date.parse("2026-10-25T00:00:00Z") + index * 3_600_000;
  const record = (second: number, fields: object) =>
    JSON.stringify({ ...fields, cwd, timestamp: new Date(start + second * 1000).toISOString() });

  const publish = {
    type: "tool_use",
    id: "publish",
    name: "Bash",
    input: { command: "skills publish" },
  };

  const url = `https://github.com/example/repo/pull/${index + 1}`;
  const lines = [
    record(0, { type: "user", message: { role: "user", content: `/plans do ${index}` } }),
    record(1, { type: "assistant", message: { content: [publish] } }),
    record(2, {
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "publish", content: url }] },
    }),
    ...Array.from({ length: paddingEvents }, (_, event) =>
      record(3 + event, {
        type: "assistant",
        message: { content: [{ type: "text", text: padding }] },
      }),
    ),
  ];

  return `${lines.join("\n")}\n`;
}

const root = realpathSync(mkdtempSync(join(tmpdir(), "audit-memory-")));
try {
  const home = join(root, "home");
  const cwd = join(root, "work");
  const folder = join(home, ".claude/projects", encodedName(cwd));

  mkdirSync(cwd, { recursive: true });
  mkdirSync(folder, { recursive: true });

  for (let index = 0; index < transcripts; index++)
    writeFileSync(join(folder, `session-${index}.jsonl`), transcript(cwd, index));

  const output = await audit(["--days", "14", "--prs", "--json"], {
    env: { HOME: home, PLANS_DIR: join(root, "plans"), PATH: process.env.PATH },
    now,
    cwd,
    gh: async () => undefined,
    git: async () => undefined,
  });

  const found = output.code === 0 ? JSON.parse(output.stdout).windows.found : null;
  const maxMiB = process.resourceUsage().maxRSS / 1024;
  if (found === transcripts && maxMiB < limitMiB) console.log("ok");
  else {
    console.log(`windows.found ${found}, maxRSS ${maxMiB.toFixed(1)} MiB`);
    process.exitCode = 1;
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
