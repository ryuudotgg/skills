import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { areas } from "./cli.ts";
import { readRuleGroups } from "./deny-set.ts";

test("CLI allow rules match registry declarations at both paths", () => {
  const verbs = areas.flatMap((area) => area.verbs);
  const groups = readRuleGroups(resolve(import.meta.dir, "../../../skills"));
  const covered = new Set<string>();
  for (const entry of groups
    .filter((group) => group.kind === "allow")
    .flatMap((group) => group.entries)) {
    const match =
      /^Bash\((\{claude\}\/skills|\{agents\})\/playbook\/bin\/skills ([a-z-]+(?: [a-z-]+)*) \*\)$/.exec(
        entry,
      );

    expect(match, `Allow entry is not one CLI verb: ${entry}`).not.toBeNull();

    const verb = verbs.find((verb) => verb.name.join(" ") === match![2]);
    expect(verb, `Unknown CLI verb in allow entry: ${entry}`).toBeDefined();
    expect(verb!.allow, `CLI verb disallows allow entry: ${entry}`).toBe(true);
    covered.add(`${match![1]} ${match![2]}`);
  }

  for (const verb of verbs.filter((verb) => verb.allow))
    for (const prefix of ["{claude}/skills", "{agents}"])
      expect(
        covered.has(`${prefix} ${verb.name.join(" ")}`),
        `Missing ${prefix} allow for ${verb.name.join(" ")}`,
      ).toBe(true);
});

test("plans lease break carries no allow rule and plans pin does", () => {
  const allowed = new Map(
    areas.flatMap((area) => area.verbs).map((verb) => [verb.name.join(" "), verb.allow]),
  );

  expect(allowed.get("plans lease break")).toBe(false);
  expect(allowed.get("plans pin")).toBe(true);
});

test("hub verbs that change trust carry no allow rule", () => {
  const allowed = new Map(
    areas
      .flatMap((area) => area.verbs)
      .filter((verb) => verb.name[0] === "hub")
      .map((verb) => [verb.name.join(" "), verb.allow]),
  );

  expect(Object.fromEntries(allowed)).toEqual({
    "hub init": false,
    "hub invite": false,
    "hub join": true,
    "hub devices": true,
    "hub revoke": false,
    "hub recover": false,
    "hub recovery rotate": false,
    "hub sync": true,
    "hub status": true,
  });
});

test("hub grammar lists the lines each hub verb prints", () => {
  const head = `head ${"a1".repeat(32)}`;
  const lost =
    "a recovery rotation landed without its code being shown, run skills hub recovery rotate again";

  const printed: Record<string, readonly string[]> = {
    sync: [
      "left 3 events, 2 blobs, 0 transcript bytes uncut, next blob 3.0 MiB",
      "skipped symlink Skills/a",
      "skipped Skills/b, larger than 128 MiB",
      "conflict Skills/c.txt, kept the local file",
      "refused path Skills/d: the event names a path outside its project",
      "refused 2 events that do not verify",
      "join refused for invite A: invite expired",
      lost,
    ],
    join: ["vault founded by A", head],
    recover: [
      "vault founded by A",
      head,
      "device d1 has no keys here, revoke it from an enrolled device",
    ],
    invite: ["join refused for invite A: invite expired", lost],
    init: [
      "if no recovery code was printed, run skills hub recovery rotate",
      "device B added by A",
      lost,
      "chain 1 entry pushed",
    ],
    "recovery rotate": [
      "This recovery code is never shown again. It is full vault authority: whoever holds it reads every plan and can enroll devices.",
      "if the hub took the rotation, the old code no longer works: run skills hub recovery rotate again",
      lost,
    ],
    revoke: [lost],
    status: [
      "chain 1 entry",
      "hub status: HUB_NETWORK takes public, tailscale or local, not invalid",
      "tailnet x.ts.net",
      "tailnet unread: tailscale timed out",
      "joining as device d1",
      "the hub refuses this device as revoked, enroll this machine again with an invite from another machine",
      "the hub does not know this device, so it was restored from a backup older than this enrollment: run skills hub sync on a machine enrolled before that backup, which repairs the hub's chain, then sync here again",
    ],
  };

  const grammars = new Map(
    areas
      .flatMap((area) => area.verbs)
      .filter((verb) => verb.name[0] === "hub")
      .map((verb) => [
        verb.name.slice(1).join(" "),
        verb.grammar.map(
          (line) =>
            new RegExp(
              `^${line
                .split(/(<[^>]+>|\[|\])/)
                .map((part) =>
                  part === "["
                    ? "(?:"
                    : part === "]"
                      ? ")?"
                      : part.startsWith("<")
                        ? ".+"
                        : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
                )
                .join("")}$`,
            ),
        ),
      ]),
  );

  for (const [verb, lines] of Object.entries(printed))
    for (const line of lines)
      expect(
        grammars.get(verb)?.some((pattern) => pattern.test(line)),
        `hub ${verb} grammar misses: ${line}`,
      ).toBe(true);
});
