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
    {
      name: ["lease-rebase"],
      usage: "skills lease-rebase <parent> <parent-old-tip> <branch>...",
      grammar: ["<branch> <old tip> <new tip>"],
      async run(args, ctx) {
        const { leaseRebaseVerb } = await import("../stack/lease-rebase.ts");
        return leaseRebaseVerb(args, this.usage, ctx.root);
      },
    },
  ],
  ports: [{ legacy: "skills/playbook/scripts/lease-rebase.sh", verb: ["lease-rebase"] }],
  suites: [
    {
      name: "test-delivery-mode",
      argv: ["sh", "skills/playbook/scripts/test-delivery-mode.sh"],
      files: ["skills/playbook/scripts/test-delivery-mode.sh"],
      watch: legacyWatch,
      seconds: 0.8,
    },
  ],
};
