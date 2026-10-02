import { processIo } from "../io.ts";
import type { Area } from "../registry.ts";

export const stack: Area = {
  verbs: [
    {
      name: ["fix-round"],
      usage: 'skills fix-round -P <Project> -m "<message>" <file>...',
      grammar: [
        "committed <short> on <branch>",
        "pushed <branch>",
        "rebased <branch> and pushed",
        "rebased <branch> (not on origin, not pushed)",
      ],
      async run(args, ctx) {
        const { fixRoundVerb } = await import("../stack/fix-round.ts");
        return fixRoundVerb(args, this.usage, ctx.root, processIo());
      },
    },
    {
      name: ["restack-layer"],
      usage: "skills restack-layer -P <Project> [--push] [--onto <parent> <old parent tip>]",
      grammar: [
        "<branch> already sits on <base>",
        "rebased <branch> onto <base>, run the standing checks, then skills restack-layer --push",
        "<branch> is rebased, run the standing checks, then skills restack-layer --push",
        "pushed <branch>",
        "rebased <branch> and pushed",
        "rebased <branch> (not on origin, not pushed)",
      ],
      async run(args, ctx) {
        const { restackLayerVerb } = await import("../stack/restack-layer.ts");
        return restackLayerVerb(args, this.usage, ctx.root, processIo());
      },
    },
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
        return leaseRebaseVerb(args, this.usage, ctx.root, processIo());
      },
    },
  ],
  suites: [],
};
