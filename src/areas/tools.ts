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
