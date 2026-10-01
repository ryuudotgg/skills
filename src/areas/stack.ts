import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const stack: Area = {
  verbs: [
    {
      name: ["publish"],
      usage: 'skills publish -m "<message>" [-t "<title>"] <file>...',
      grammar: ["<pr url>"],
      async run(args, ctx) {
        const { publishVerb } = await import("../publish/publish.ts");
        return publishVerb(args, this.usage, ctx.root);
      },
    },
  ],
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
      name: "test-delivery-mode",
      argv: ["sh", "skills/playbook/scripts/test-delivery-mode.sh"],
      files: ["skills/playbook/scripts/test-delivery-mode.sh"],
      watch: legacyWatch,
      seconds: 0.8,
    },
  ],
};
