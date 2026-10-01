import type { Area } from "../registry.ts";
import { legacyWatch } from "../test/watch.ts";

export const hooks: Area = {
  verbs: [],
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
