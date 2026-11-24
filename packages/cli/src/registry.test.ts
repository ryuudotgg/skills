import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { areas } from "./cli.ts";
import { readRuleGroups } from "./deny-set.ts";

function grammarPattern(line: string): RegExp {
  return new RegExp(
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
  );
}

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

test("sessions writers sync after they write", () => {
  const synced = new Map(
    areas
      .flatMap((area) => area.verbs)
      .filter((verb) => verb.name[0] === "sessions")
      .map((verb) => [verb.name.join(" "), verb.sync === true]),
  );

  expect(Object.fromEntries(synced)).toEqual({
    "sessions scan": true,
    "sessions list": false,
    "sessions show": false,
    "sessions policy": true,
    "sessions restore": false,
  });
});

test("store writers sync after they write", () => {
  const verbs = areas.flatMap((area) => area.verbs).map((verb) => verb.name.join(" "));
  const synced = areas
    .flatMap((area) => area.verbs)
    .filter((verb) => verb.sync === true)
    .map((verb) => verb.name.join(" "));

  expect(synced.toSorted()).toEqual(
    [
      "plans set-row",
      "plans add",
      "plans log",
      "plans import",
      "plans checkout",
      "plans close",
      "plans sweep",
      "plans start",
      "plans pin",
      "plans lease break",
      "plans move",
      "plans adopt",
      "plans wave",
      "threads log",
      "issues file",
      "issues close",
      "issues link",
      "issues renumber",
      "machine label",
      "machine refresh",
      "digest",
      "brief",
      "sessions scan",
      "sessions policy",
      "pr green",
      "round decide",
      "round drive",
      "eval",
    ].toSorted(),
  );

  for (const name of [
    "round gate",
    "plans frontier",
    "plans lint",
    "recall",
    "hook stop",
    "hook pre-tool-use",
    "hook session-start",
    "hook post-tool-use",
  ]) {
    expect(verbs).toContain(name);
    expect(synced).not.toContain(name);
  }
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
      "left 0 events, 0 blobs, 0 transcript bytes uncut, to pull 120 events, 4 blobs",
      "left 3 events, 2 blobs, 0 transcript bytes uncut, to pull 1 events, 0 blobs, next blob 3.0 MiB",
      "skipped symlink Skills/a",
      "skipped Skills/b, larger than 128 MiB",
      "conflict Skills/c.txt, kept the local file",
      "refused path Skills/d: the event names a path outside its project",
      "refused 2 events that do not verify",
      "join refused for invite A: invite expired",
      lost,
    ],
    join: [
      "vault founded by A",
      head,
      "device d1 has no keys here, revoke it from an enrolled device",
    ],
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
      "conflict Skills/001-one.md, run skills plans show --conflict Skills 001",
      "conflict Skills/c.txt, kept the local file",
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
      .map((verb) => [verb.name.slice(1).join(" "), verb.grammar.map(grammarPattern)]),
  );

  for (const [verb, lines] of Object.entries(printed))
    for (const line of lines)
      expect(
        grammars.get(verb)?.some((pattern) => pattern.test(line)),
        `hub ${verb} grammar misses: ${line}`,
      ).toBe(true);
});

test("grammars match sample printed lines", () => {
  const conflict =
    "Skills#4 conflict: Fix the hook | Drop the hook, run skills issues renumber Skills#4";

  const printed: Record<string, readonly string[]> = {
    eval: [
      "opencode:   /tmp/out/opencode.log",
      "codex:      /tmp/out/codex.log",
      "  reachable at: /usr/local/bin/gh",
      "  command: command -v gh",
      "  result: /usr/local/bin/gh",
    ],
    audit: ["Note: gh pr list failed"],
    dash: [
      "dash: no plans.db at /home/a/Plans/plans.db, run skills plans import",
      "dash: database disk image is malformed",
      "dash: hub sync failed: fetch failed",
      "dash: no opener on win32, open the URL by hand",
      "dash: open failed, open the URL by hand",
    ],
    "pr green": [
      "waiting: #12 pending build",
      "#12 auto-merge armed SQUASH",
      "#12 in merge queue",
      "unreadable gh: not logged in",
    ],
    "pr watch": [
      "QUEUE: captured 2 PRs bottom-to-top: #12,#13",
      "QUEUE: captured 1 PR bottom-to-top: #12",
      "WAITING: frontier=#12; 3 checks pending",
      "WAITING: frontier=#12; 1 check pending",
      "WAITING: frontier=#12; no checks yet on abc1234",
      "WAITING: frontier=#12 is blocker-free; waiting for merge queue (2 PRs unmerged)",
      "ADVANCE: merged #12; next=#13; remaining=1",
      "RETRY: GitHub status query failed; retrying in 30s",
      "detail=gh exited 1",
      "COMPLETE: queued stack merged (2 PRs): #12,#13",
      "TIMEOUT: checks still pending",
      "TIMEOUT: no checks yet on abc1234",
      "TIMEOUT: GitHub status remained unavailable",
      "TIMEOUT: queued stack still has 1 PR unmerged; frontier=#13",
    ].map((line) => `--pretty: ${line}`),
    "round drive": [
      "#18 head moved to abc1234",
      "#18 green not confirmed before the cap",
      "#18 unreadable gh: timeout",
      "#18 merged",
      "#18 closed",
      "#18 draft",
    ],
    "review read": ["empty", "found in: reviews, PR comments"],
    "plans frontier": [conflict],
    "plans history": [`2026-11-17T10:00:00Z\t${"ab".repeat(32)}\tdevice1\t812\t(fetching)`],
  };

  const verbs = new Map(
    areas.flatMap((area) => area.verbs).map((verb) => [verb.name.join(" "), verb]),
  );

  for (const [verb, lines] of Object.entries(printed)) {
    const patterns = verbs.get(verb)?.grammar.map(grammarPattern) ?? [];
    for (const line of lines)
      expect(
        patterns.some((pattern) => pattern.test(line)),
        `${verb} grammar misses: ${line}`,
      ).toBe(true);
  }

  const shadowed: Record<string, readonly string[]> = {
    dash: [
      "dash: no plans.db at <path>, run skills plans import",
      "dash: hub sync failed: <message>",
      "dash: no opener on <platform>, open the URL by hand",
      "dash: <command> failed, open the URL by hand",
    ],
    "plans frontier": [
      "<Project>#<n> conflict: <title> | <title>, run skills issues renumber <Project>#<n>",
    ],
    "plans history": ["<recorded>\t<sha256>\t<machine>\t<bytes>[\t(fetching)]"],
  };

  for (const [verb, entries] of Object.entries(shadowed))
    for (const entry of entries) expect(verbs.get(verb)?.grammar).toContain(entry);
});
