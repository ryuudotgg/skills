import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const round: Area = {
  verbs: [
    ...(["gate", "decide"] as const).map((phase) => ({
      name: ["round", phase],
      usage:
        phase === "gate"
          ? "skills round gate <pr> [--wait] [critical=true]"
          : "skills round decide <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...]",
      grammar: [
        "<reviewer> <verdict>",
        "done",
        "wait",
        "triage",
        "rereview",
        "handback <reviewer> <reason>[, <reviewer> <reason> ...]",
      ],
      async run(args: readonly string[], ctx: import("../registry.ts").Context) {
        const { dependencies, runRound } = await import("../round/round.ts");
        const deps = dependencies(ctx.root);
        deps.stderr = (text) => { process.stderr.write(text); };
        const result = await runRound([phase, ...args], deps);
        process.stdout.write(result.stdout);

        return result.code;
      },
    })),
    {
      name: ["settings"],
      usage: "skills settings <reviewer>",
      grammar: ["<setting>=<value>"],
      async run(args, ctx) {
        const { runSettings } = await import("../reviewers/settings.ts");
        const { dependencies } = await import("../round/round.ts");
        const result = await runSettings(args, dependencies(ctx.root));
        process.stderr.write(result.stderr);
        process.stdout.write(result.stdout);

        return result.code;
      },
    },
  ],
  ports: [
    { legacy: "skills/playbook/scripts/round.sh", verb: ["round"] },
    { legacy: "skills/playbook/scripts/settings.sh", verb: ["settings"] },
  ],
  suites: [
    {
      name: "test-reviewers",
      argv: ["sh", "skills/playbook/scripts/test-reviewers.sh"],
      files: ["skills/playbook/scripts/test-reviewers.sh"],
      watch: legacyWatch,
      seconds: 19.1,
    },
    {
      name: "test-review-round",
      argv: ["sh", "skills/playbook/scripts/test-review-round.sh"],
      files: ["skills/playbook/scripts/test-review-round.sh"],
      watch: legacyWatch,
      seconds: 100.6,
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
