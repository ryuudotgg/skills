import type { Area } from "../registry.ts";

export const tools: Area = {
  verbs: [
    {
      name: ["eval"],
      usage: "skills eval <case> [--grade]",
      grammar: [
        "transcript: <path>",
        "status:     <path>",
        "diff:       <path>",
        "remote:     <path>",
        "gh:         <path>",
        "expectations:",
        "LEAKED <name>",
        "HIDDEN <name>",
        "UNCHECKED <name>",
      ],
      async run(args, ctx) {
        const { runEval } = await import("../evals/run.ts");
        return runEval(args, ctx);
      },
    },
    {
      name: ["log"],
      usage: "skills log <file> <project> <plan> <branch> <evidence> <result>",
      grammar: [],
      async run(args) {
        const { logDecision } = await import("../decision-log.ts");
        return logDecision(args);
      },
    },
    {
      name: ["audit"],
      usage: "skills audit [--days N] [--json] [--project-dir D]",
      grammar: ["<JSON object>\\n", "Session audit, last <days> days through <iso>"],
      async run(args) {
        const { audit } = await import("../audit/audit.ts");
        const result = audit(args, { env: process.env, now: new Date(), cwd: process.cwd() });
        process.stdout.write(result.stdout);
        process.stderr.write(result.stderr);

        return result.code;
      },
    },
  ],
  ports: [],
  suites: [],
};
