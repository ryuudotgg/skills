import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const tools: Area = {
  verbs: [
    {
      name: ["log"],
      usage: "skills log <file> <project> <plan> <branch> <evidence> <result>",
      grammar: [],
      async run(args) {
        const { logDecision } = await import("../decision-log.ts");
        return logDecision(args);
      },
    },
    {
      name: ["audit"],
      usage: "skills audit [--days N] [--json] [--project-dir D]",
      grammar: ["<JSON object>\\n", "Session audit, last <days> days through <iso>"],
      async run(args) {
        const { audit } = await import("../audit/audit.ts");
        const result = audit(args, { env: process.env, now: new Date(), cwd: process.cwd() });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
  ],
  ports: [],
  suites: [
    {
      name: "test-run",
      argv: ["bash", "evals/test-run.sh"],
      files: ["evals/test-run.sh"],
      watch: [...legacyWatch, "evals/**"],
      seconds: 8.7,
    },
  ],
};
