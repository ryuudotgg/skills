import type { Area } from "../registry.ts";

export const round: Area = {
  verbs: [
    {
      name: ["round", "drive"],
      allow: false,
      usage:
        "skills round drive <pr> <branch> [critical=true] [<reviewer>=fixed|<reviewer>=dismissed ...] (ROUND_DRIVE_CAP=<seconds>, default 570)",
      grammar: [
        "handoff [<round lines>] #<pr> green <sha>",
        "refused [<round lines>] <refusal>",
        "triage [<round lines>] [<failing or blocked lines>] <review read stdout>",
        "red [<round lines>] #<pr> failing <check> <link> | #<pr> blocked <rollup>",
        "conflict [<round lines>] #<pr> conflicts with <base> <mergeable> <mergeStateStatus>",
        "wait [<round lines>] [<pending lines>]",
        "outcomes <reviewer>=<outcome> ...",
      ],
      async run(args, ctx) {
        const { driveDependencies, runDrive } = await import("../round/drive.ts");

        let deps;
        try {
          deps = driveDependencies(ctx.root);
        } catch (error) {
          process.stdout.write(
            `refused\n${error instanceof Error ? error.message : String(error)}\n`,
          );

          return 1;
        }

        const result = await runDrive(args, deps);
        process.stderr.write(result.stderr);
        process.stdout.write(result.stdout);

        return result.code;
      },
    },
    {
      name: ["reviewers"],
      allow: true,
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
      allow: true,
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
      allow: true,
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
  suites: [],
};
