import { processIo } from "../io.ts";
import type { Area } from "../registry.ts";

export const stack: Area = {
  verbs: [
    {
      name: ["fix-round"],
      allow: false,
      usage: 'skills fix-round [-P <Project>] -m "<message>" <file>...',
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
      allow: false,
      usage: "skills restack-layer [-P <Project>] [--push] [--onto <parent> <old parent tip>]",
      grammar: [
        "<branch> already sits on <base>",
        "dropped <sha> <subject>",
        "changed <sha> <subject>",
        "series not compared: <first line of the git error>",
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
      allow: false,
      usage: 'skills publish -m "<message>" [-t "<title>"] [--body <file>] <file>...',
      grammar: ["<pr url>"],
      async run(args, ctx) {
        const { publishVerb } = await import("../publish/publish.ts");
        return publishVerb(args, this.usage, ctx.root);
      },
    },
    {
      name: ["takeover"],
      allow: false,
      usage: "skills takeover <pr> [<sha>...] | --continue | --abort",
      grammar: [
        "left <short sha> <subject>, by <login>",
        "carried <short sha> <subject>",
        "skipped <short sha> <subject>, already on <branch>",
        "skipped <short sha> <subject>, resolved to no change",
        "dropped <short sha> <subject>",
        "discarded <path>",
        "<branch> back at <short sha>",
      ],
      async run(args, ctx) {
        const { takeoverVerb } = await import("../stack/takeover.ts");
        return takeoverVerb(args, this.usage, ctx.root, processIo());
      },
    },
    {
      name: ["lease-rebase"],
      allow: false,
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
