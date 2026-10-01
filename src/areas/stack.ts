import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const stack: Area = {
  verbs: [],
  ports: [],
  suites: [
    {
      name: "test-lease-rebase",
      argv: ["sh", "skills/playbook/scripts/test-lease-rebase.sh"],
      files: ["skills/playbook/scripts/test-lease-rebase.sh"],
      watch: legacyWatch,
      seconds: 49.9,
    },
    {
      name: "test-publish",
      argv: ["sh", "skills/playbook/scripts/test-publish.sh"],
      files: ["skills/playbook/scripts/test-publish.sh"],
      watch: legacyWatch,
      seconds: 20.8,
    },
    {
      name: "test-delivery-mode",
      argv: ["sh", "skills/playbook/scripts/test-delivery-mode.sh"],
      files: ["skills/playbook/scripts/test-delivery-mode.sh"],
      watch: legacyWatch,
      seconds: 0.8,
    },
  ],
};
