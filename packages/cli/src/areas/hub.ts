import type { Area } from "../registry.ts";

export const hub: Area = {
  verbs: [],
  suites: [
    {
      name: "hub",
      cwd: "apps/hub",
      argv: ["bun", "test", "--timeout=30000"],
      files: ["apps/hub/test/*.test.ts"],
      watch: ["apps/hub/**", "packages/core/src/**", "packages/cli/src/test/hub-fixture.ts"],
      seconds: 10,
    },
  ],
};
