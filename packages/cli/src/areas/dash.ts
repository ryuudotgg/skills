import type { Area } from "../registry.ts";

export const dash: Area = {
  verbs: [
    {
      name: ["dash"],
      allow: true,
      usage: "skills dash [--no-open] [--dist <dir>]",
      grammar: [
        "http://127.0.0.1:<port>/#token=<token>",
        "dash: no dashboard build for <version>: <reason>",
        "dash: no dashboard build at <dir>: <reason>",
      ],
      async run(args) {
        const { dashVerb } = await import("../dash/verb.ts");
        const { processIo } = await import("../io.ts");
        return dashVerb(args, processIo());
      },
    },
  ],
  suites: [
    {
      name: "dashboard",
      cwd: "apps/dashboard",
      argv: ["bun", "test", "--timeout=60000"],
      files: ["apps/dashboard/test/*.test.ts"],
      watch: [
        "apps/dashboard/**",
        "packages/core/src/**",
        "packages/cli/src/dash/**",
        "packages/cli/src/plans/store.ts",
        "skills/playbook/bin/skills",
      ],
      seconds: 20,
    },
  ],
};
