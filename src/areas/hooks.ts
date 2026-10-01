import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const hooks: Area = {
  verbs: [
    {
      name: ["hook", "session-start"],
      usage: "skills hook session-start",
      grammar: [
        '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}',
      ],
      async run(args, ctx) {
        const { sessionStart } = await import("../hooks/session-start.ts");
        return sessionStart(args, ctx);
      },
    },
  ],
  ports: [],
  suites: [
    {
      name: "test_hooks",
      argv: ["python3", "-B", "hooks/test_hooks.py"],
      files: ["hooks/test_hooks.py"],
      watch: [...legacyWatch, "hooks/**"],
      seconds: 30.3,
    },
  ],
};
