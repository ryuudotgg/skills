import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const tools: Area = {
  verbs: [],
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
