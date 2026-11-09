import type { HubVerb } from "../hub/verbs.ts";
import { processIo } from "../io.ts";
import type { Area, Verb } from "../registry.ts";

function verb(name: HubVerb, allow: boolean, usage: string, grammar: readonly string[]): Verb {
  return {
    name: ["hub", ...name.split(" ")],
    allow,
    usage,
    grammar,
    async run(args) {
      const { hubVerb } = await import("../hub/verbs.ts");
      return hubVerb(name, args, usage, processIo());
    },
  };
}

const ENTRIES = [
  "device <label> added by <label>",
  "epoch <n> started by <label>",
  "device <label> revoked by <label>",
];

const REFUSAL = "hub <verb>: <reason>";

export const hub: Area = {
  verbs: [
    verb("init", false, "skills hub init <url> [--code <code>] [--label <label>]", [
      "This recovery code is never shown again. It is full vault authority: whoever holds it reads every plan and can enroll devices.",
      "recovery code <XXXX> <XXXX> ... (20 groups)",
      "device <label> <id> enrolled",
      "chain <n> entries pushed",
      REFUSAL,
    ]),
    verb(
      "invite",
      false,
      "skills hub invite [--label <label>] [--for <hours>h|<days>d] [--no-wait]",
      [...ENTRIES, "skills hub join <url> <invite>", "invite expired", REFUSAL],
    ),
    verb("join", true, "skills hub join <url> <invite>", ["enrolled", REFUSAL]),
    verb("devices", true, "skills hub devices", [
      "<id> <label> enrolled|revoked <first>..<last>",
      REFUSAL,
    ]),
    verb("revoke", false, "skills hub revoke <device id or label>", [
      ...ENTRIES,
      "revoked <label>, epoch <n>, cutoff <sequence>",
      REFUSAL,
    ]),
    verb("recover", false, "skills hub recover <url> [--label <label>] < recovery code", [
      "device <label> <id> enrolled",
      REFUSAL,
    ]),
    verb("recovery rotate", false, "skills hub recovery rotate", [
      ...ENTRIES,
      "recovery code <XXXX> <XXXX> ... (20 groups)",
      "epoch <n>",
      REFUSAL,
    ]),
    verb("sync", true, "skills hub sync", [...ENTRIES, REFUSAL]),
    verb("status", true, "skills hub status", [
      ...ENTRIES,
      "devices <n>",
      "epoch <n>",
      "chain <n> entries",
      "head <hash>",
      "incarnation <id>",
      "offline: <reason>",
      "not enrolled",
    ]),
  ],
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
