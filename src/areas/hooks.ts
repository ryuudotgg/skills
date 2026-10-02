import type { Area } from "../registry.ts";
import { MATCHERS } from "../hooks/payload.ts";

export const hooks: Area = {
  verbs: [
    {
      name: ["hook", "stop"],
      usage: "skills hook stop",
      grammar: ['{"decision": "block", "reason": <text>}'],
      async run() {
        const { stop } = await import("../hooks/stop.ts");
        return stop();
      },
    },
    {
      name: ["hook", "pre-tool-use"],
      usage: "skills hook pre-tool-use",
      grammar: [
        '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": <reason>}}',
      ],
      matcher: { claude: "^Bash$", codex: "^Bash$" },
      async run(_args, ctx) {
        const { preToolUse } = await import("../hooks/pre-tool-use.ts");
        return preToolUse(ctx);
      },
    },
    {
      name: ["hook", "session-start"],
      usage: "skills hook session-start",
      matcher: { claude: "startup|resume|clear|compact", codex: "startup|resume|clear|compact" },
      grammar: [
        '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":<text>}}',
      ],
      async run(args, ctx) {
        const { sessionStart } = await import("../hooks/session-start.ts");
        return sessionStart(args, ctx);
      },
    },
    {
      name: ["hook", "post-tool-use"],
      usage: "skills hook post-tool-use",
      grammar: ['{"decision": "block", "reason": <text>}'],
      matcher: MATCHERS,
      async run() {
        const { postToolUse } = await import("../hooks/post-tool-use.ts");
        return postToolUse();
      },
    },
  ],
  suites: [],
};
