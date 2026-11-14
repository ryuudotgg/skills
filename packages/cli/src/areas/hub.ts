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

const FOUNDING = "vault founded by <label>";

const RECOVERY_WARNING =
  "This recovery code is never shown again. It is full vault authority: whoever holds it reads every plan and can enroll devices.";

const JOIN_REFUSED = "join refused for invite <label>: <reason>";

const LOST_ROTATION =
  "a recovery rotation landed without its code being shown, run skills hub recovery rotate again";

const REFUSAL = "hub <verb>: <reason>";

export const hub: Area = {
  verbs: [
    verb("init", false, "skills hub init <url> [--code <code>] [--label <label>]", [
      RECOVERY_WARNING,
      "recovery code <XXXX> <XXXX> ... (20 groups)",
      "device <label> <id> enrolled",
      "chain 1 entry pushed",
      "chain <n> entries pushed",
      "reseeded, <n> events, <n> blobs",
      "if no recovery code was printed, run skills hub recovery rotate",
      ...ENTRIES,
      LOST_ROTATION,
      REFUSAL,
    ]),
    verb(
      "invite",
      false,
      "skills hub invite [--label <label>] [--for <hours>h|<days>d] [--no-wait]",
      [
        ...ENTRIES,
        "skills hub join <url> <invite>",
        JOIN_REFUSED,
        "invite expired",
        LOST_ROTATION,
        REFUSAL,
      ],
    ),
    verb("join", true, "skills hub join <url> <invite>", [
      FOUNDING,
      ...ENTRIES,
      "head <hash>",
      "enrolled",
      REFUSAL,
    ]),
    verb("devices", true, "skills hub devices", [
      "<id> <label> enrolled|revoked <first>..<last>",
      REFUSAL,
    ]),
    verb("revoke", false, "skills hub revoke <device id or label>", [
      ...ENTRIES,
      "revoked <label>, epoch <n>, cutoff <sequence>",
      LOST_ROTATION,
      REFUSAL,
    ]),
    verb("recover", false, "skills hub recover <url> [--label <label>]", [
      FOUNDING,
      ...ENTRIES,
      "head <hash>",
      "device <id> has no keys here, revoke it from an enrolled device",
      "device <label> <id> enrolled",
      REFUSAL,
    ]),
    verb("recovery rotate", false, "skills hub recovery rotate", [
      ...ENTRIES,
      RECOVERY_WARNING,
      "recovery code <XXXX> <XXXX> ... (20 groups)",
      "epoch <n>",
      "if the hub took the rotation, the old code no longer works: run skills hub recovery rotate again",
      LOST_ROTATION,
      REFUSAL,
    ]),
    verb("sync", true, "skills hub sync [--publish-quarantine]", [
      ...ENTRIES,
      LOST_ROTATION,
      JOIN_REFUSED,
      "landed <path> from <label>",
      "skipped symlink <path>",
      "skipped <path>, larger than <n> MiB",
      "conflict <path>, run skills plans show --conflict <Project> <id>",
      "conflict <path>, kept the local file",
      "conflict <Project> <id> lease held by <label>, run skills plans lease break <Project> <id>",
      "quarantined <n> events wait, run skills hub sync --publish-quarantine to publish them",
      "refused path <path>: <reason>",
      "refused <n> events that do not verify",
      "published <n> quarantined events",
      "deleted <n> blobs",
      "held <n> blobs the hub refuses as too large, upgrade the hub to send them",
      "pushed <n> events, <n> blobs, pulled <n> events, <n> blobs, conflicts <n>",
      "left <n> events, <n> blobs, <n> transcript bytes uncut[, next <kind> <size>]",
      "reconciled",
      REFUSAL,
    ]),
    verb("status", true, "skills hub status", [
      ...ENTRIES,
      "hub <url> (<mode>)",
      "tailnet <name>",
      "tailnet unread: <reason>",
      "device <label> <id>",
      "devices <n>",
      "epoch <n>",
      "chain 1 entry",
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
      "the hub refuses this device as revoked, enroll this machine again with an invite from another machine",
      "the hub does not know this device, so it was restored from a backup older than this enrollment: run skills hub sync on a machine enrolled before that backup, which repairs the hub's chain, then sync here again",
      "fork detected",
      "no hub configured",
      "not enrolled",
      "joining as device <id>",
      REFUSAL,
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
