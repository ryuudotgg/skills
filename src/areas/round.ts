import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const round: Area = {
  verbs: [],
  ports: [],
  suites: [
    {
      name: "test-reviewers",
      argv: ["sh", "skills/playbook/scripts/test-reviewers.sh"],
      files: ["skills/playbook/scripts/test-reviewers.sh"],
      watch: legacyWatch,
      seconds: 19.1,
    },
    {
      name: "test-round",
      argv: ["sh", "skills/playbook/scripts/test-round.sh"],
      files: ["skills/playbook/scripts/test-round.sh"],
      watch: legacyWatch,
      seconds: 63.3,
    },
    {
      name: "test-review-round",
      argv: ["sh", "skills/playbook/scripts/test-review-round.sh"],
      files: ["skills/playbook/scripts/test-review-round.sh"],
      watch: legacyWatch,
      seconds: 100.6,
    },
    {
      name: "test-settings",
      argv: ["sh", "skills/playbook/scripts/test-settings.sh"],
      files: ["skills/playbook/scripts/test-settings.sh"],
      watch: legacyWatch,
      seconds: 5.2,
    },
    {
      name: "test-greptile",
      argv: ["sh", "skills/greptile/scripts/test-greptile.sh"],
      files: ["skills/greptile/scripts/test-greptile.sh"],
      watch: legacyWatch,
      seconds: 149.7,
    },
    {
      name: "test-coderabbit",
      argv: ["sh", "skills/coderabbit/scripts/test-coderabbit.sh"],
      files: ["skills/coderabbit/scripts/test-coderabbit.sh"],
      watch: legacyWatch,
      seconds: 272.4,
    },
    {
      name: "test-macroscope",
      argv: ["sh", "skills/macroscope/scripts/test-macroscope.sh"],
      files: ["skills/macroscope/scripts/test-macroscope.sh"],
      watch: legacyWatch,
      seconds: 82.5,
    },
  ],
};
