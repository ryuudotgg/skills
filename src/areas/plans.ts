import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const plans: Area = {
  verbs: [],
  ports: [],
  suites: [
    {
      name: "test-lint",
      argv: ["sh", "skills/plans/scripts/test-lint.sh"],
      files: ["skills/plans/scripts/test-lint.sh"],
      watch: legacyWatch,
      seconds: 0.2,
    },
    {
      name: "test-frontier",
      argv: ["sh", "skills/plans/scripts/test-frontier.sh"],
      files: ["skills/plans/scripts/test-frontier.sh"],
      watch: legacyWatch,
      seconds: 0.5,
    },
    {
      name: "test-handoff",
      argv: ["sh", "skills/plans/scripts/test-handoff.sh"],
      files: ["skills/plans/scripts/test-handoff.sh"],
      watch: legacyWatch,
      seconds: 0.7,
    },
    {
      name: "test-preflight",
      argv: ["sh", "skills/plans/scripts/test-preflight.sh"],
      files: ["skills/plans/scripts/test-preflight.sh"],
      watch: legacyWatch,
      seconds: 3.1,
    },
    {
      name: "test-stack-base",
      argv: ["sh", "skills/plans/scripts/test-stack-base.sh"],
      files: ["skills/plans/scripts/test-stack-base.sh"],
      watch: legacyWatch,
      seconds: 4.7,
    },
  ],
};
