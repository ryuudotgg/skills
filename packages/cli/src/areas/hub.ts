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
      "reseeded, <n> events, <n> blobs",
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
    verb("recover", false, "skills hub recover <url> [--label <label>]", [
      "device <label> <id> enrolled",
      REFUSAL,
    ]),
    verb("recovery rotate", false, "skills hub recovery rotate", [
      ...ENTRIES,
      "recovery code <XXXX> <XXXX> ... (20 groups)",
      "epoch <n>",
      REFUSAL,
    ]),
    verb("sync", true, "skills hub sync [--publish-quarantine]", [
      ...ENTRIES,
      "landed <path> from <label>",
      "conflict <path>, run skills plans show --conflict <Project> <id>",
      "conflict <Project> <id> lease held by <label>, run skills plans lease break <Project> <id>",
      "quarantined <n> events wait, run skills hub sync --publish-quarantine to publish them",
      "published <n> quarantined events",
      "deleted <n> blobs",
      "held <n> blobs the hub refuses as too large, upgrade the hub to send them",
      "pushed <n> events, <n> blobs, pulled <n> events, <n> blobs, conflicts <n>",
      "reconciled",
      REFUSAL,
    ]),
    verb("status", true, "skills hub status", [
      ...ENTRIES,
      "hub <url> (<mode>)",
      "device <label> <id>",
      "devices <n>",
      "epoch <n>",
      "chain <n> entries",
      "head <hash>",
      "incarnation <id>",
      "queue <n>",
      "quarantined <n>",
      "fetching <n>",
      "history <n>",
      "conflicts <n>",
      "leases <n>",
      "transcripts: <n> chunks pending, <n> withheld",
      "last sync <time> | never",
      "reconciled <time>",
      "offline: <reason>",
      "fork detected",
      "no hub configured",
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
