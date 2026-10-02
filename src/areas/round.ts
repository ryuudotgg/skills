import type { Area } from "../registry.ts";

export const round: Area = {
  verbs: [
    {
      name: ["reviewers"],
      usage: "skills reviewers [--active] (<KEY> | --settings)",
      grammar: ["<name>\t<value>", "<reviewer>\t<setting>\t<default>\t<pattern>"],
      async run(args, ctx) {
        const { runReviewers } = await import("../reviewers/command.ts");
        const result = runReviewers(args, ctx.root, process.env);
        process.stderr.write(result.stderr);
        process.stdout.write(result.stdout);

        return result.code;
      },
    },
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
        deps.stderr = (text) => {
          process.stderr.write(text);
        };

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
  ports: [],
  suites: [],
};
