import type { Area } from "../registry.ts";

export const pr: Area = {
  verbs: [],
  ports: [],
  suites: [
    {
      name: "watch-pr",
      argv: [
        "sh",
        "-c",
        "bun install --frozen-lockfile --silent && bun test watch-pr && bun run typecheck",
      ],
      cwd: "skills/playbook/scripts",
      files: ["skills/playbook/scripts/watch-pr/**/*.test.ts"],
      watch: [
        "skills/playbook/scripts/watch-pr/**",
        "skills/playbook/scripts/package.json",
        "skills/playbook/scripts/bun.lock",
        "skills/*/reviewer.conf",
      ],
      seconds: 0.8,
    },
  ],
};
