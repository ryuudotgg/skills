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
        "packages/cli/src/areas/*.ts",
        "packages/cli/src/audit/compare.ts",
        "packages/cli/src/audit/numbers.ts",
        "packages/cli/src/hooks/payload.ts",
        "packages/cli/src/hooks/text.ts",
        "packages/cli/src/pr/github.ts",
        "packages/cli/src/pr/green.ts",
        "packages/cli/src/pr/policy.ts",
        "packages/cli/src/pr/types.ts",
        "packages/cli/src/review/threads.ts",
        "packages/cli/src/reviewers/declaration.ts",
        "packages/cli/src/stack/restack.ts",
        "packages/cli/src/stack/skills-base.ts",
        "packages/cli/src/update/auto-update.ts",
        "packages/cli/src/update/dashboard.ts",
        "packages/cli/src/update/notice.ts",
        "packages/cli/src/update/release.ts",
        "packages/cli/src/test/hub-live.ts",
        "packages/cli/src/test/process.ts",
        "packages/cli/src/arms.ts",
        "packages/cli/src/cli.ts",
        "packages/cli/src/delivery.ts",
        "packages/cli/src/deny-set.ts",
        "packages/cli/src/fast-mode.ts",
        "packages/cli/src/frontmatter.ts",
        "packages/cli/src/gh.ts",
        "packages/cli/src/io.ts",
        "packages/cli/src/lock.ts",
        "packages/cli/src/project.ts",
        "packages/cli/src/read.ts",
        "packages/cli/src/run.ts",
        "packages/cli/src/shell.ts",
        "packages/cli/src/write.ts",
        "apps/hub/src/**",
        "skills/playbook/bin/skills",
      ],
      seconds: 20,
    },
  ],
};
