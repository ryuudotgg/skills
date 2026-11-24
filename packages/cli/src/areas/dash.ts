import type { Area } from "../registry.ts";

export const dashFetchUsage = "skills dash fetch";

export const dashUsage = "skills dash [--no-open] [--dist <dir>]";

export const dash: Area = {
  verbs: [
    {
      name: ["dash", "fetch"],
      allow: true,
      usage: dashFetchUsage,
      grammar: ["dash: no dashboard build for <version>: <reason>"],
      async run(args) {
        const { dashFetchVerb } = await import("../dash/verb.ts");
        const { processIo } = await import("../io.ts");
        return dashFetchVerb(args, processIo());
      },
    },
    {
      name: ["dash"],
      allow: true,
      usage: dashUsage,
      grammar: [
        "http://127.0.0.1:<port>/#token=<token>",
        "dash: no dashboard build for <version>: <reason>",
        "dash: no dashboard build at <dir>: <reason>",
        "dash: no plans.db at <path>, run skills plans import",
        "dash: <reason>",
        "dash: hub sync failed: <message>",
        "dash: no opener on <platform>, open the URL by hand",
        "dash: <command> failed, open the URL by hand",
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
        "packages/cli/src/plans/**",
        "packages/cli/src/hub/**",
        "packages/cli/src/sessions/**",
        "packages/cli/src/test/hub-live.ts",
        "packages/cli/src/test/process.ts",
        "packages/cli/src/read.ts",
        "apps/hub/src/**",
        "skills/playbook/bin/skills",
      ],
      seconds: 20,
    },
  ],
};
