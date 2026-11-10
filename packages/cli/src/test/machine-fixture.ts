import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CAPABILITIES,
  COLUMNS,
  factsFrom,
  type Facts,
  HEARTBEAT,
  isCapability,
  MACHINE_EVENT,
  secondStamp,
  TOOLS,
  type Tool,
} from "skills-core";
import { appendEvent, openStore, write } from "../plans/store.ts";
import { runCommand, suiteEnvironment } from "./process.ts";

const MARKER = ".machine-fixture";
const repo = resolve(import.meta.dir, "../../../..");
const bin = join(repo, "skills/playbook/bin/skills");
const usage =
  "usage: bun packages/cli/src/test/machine-fixture.ts <dir> [--rows <slug>,<slug>] | <dir> --age-facts <hours> | <dir> --device <label> --caps <cap>,<cap> | <dir> --backdate-heartbeats <id> <minutes> | <dir> --hold <seconds>";

function fail(message: string): never {
  process.stderr.write(`machine-fixture: ${message}\n`);
  process.exit(1);
}

function quoted(value: string): string {
  return /^[\w./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function fixtureEnv(dir: string, plans: string): NodeJS.ProcessEnv {
  return {
    ...suiteEnvironment(),
    PLANS_DIR: plans,
    SKILLS_CONF: join(dir, "conf"),
    HOME: join(dir, "home"),
    SKILLS_AUTO_UPDATE: "0",
    SKILLS_MACHINE_REFRESH: "0",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  };
}

async function run(argv: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  const result = await runCommand(argv, { cwd, env, timeout: 60_000 });
  if (result.code !== 0 || result.timedOut)
    fail(`${argv.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);

  return result.stdout;
}

function planText(id: string, slug: string): string {
  return `---
id: ${id}
slug: ${slug}
project: Demo
pri: P2
effort: S
blocked_by: -
surface: the Demo fixture
critical: false
created: ${new Date().toISOString().slice(0, 10)}
---

# ${id} ${slug}

## Outcome

A fixture plan with nothing to build.

## Acceptance

1. Nothing to check.

## Probe

    rg -n "${slug}"
`;
}

function clearFixture(dir: string): void {
  if (!existsSync(dir)) return;
  if (readdirSync(dir).length > 0 && !existsSync(join(dir, MARKER)))
    fail(`${dir} holds files this script did not make; remove it first`);

  rmSync(dir, { recursive: true, force: true });
}

async function build(dir: string, slugs: readonly string[]): Promise<void> {
  clearFixture(dir);

  for (const path of ["home", "state", "plans-a/Demo", "plans-b/Demo", "a", "b"])
    mkdirSync(join(dir, path), { recursive: true });

  writeFileSync(join(dir, MARKER), "");
  writeFileSync(join(dir, "conf"), "");

  const env = fixtureEnv(dir, join(dir, "plans-a"));
  const origin = join(dir, "origin.git");
  await run(["git", "init", "-q", "--bare", "-b", "main", origin], dir, env);
  await run(["git", "clone", "-q", origin, join(dir, "a/Demo")], dir, env);
  await run(
    ["git", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "init"],
    join(dir, "a/Demo"),
    env,
  );

  await run(["git", "push", "-q", "origin", "main"], join(dir, "a/Demo"), env);
  await run(["git", "clone", "-q", origin, join(dir, "b/Demo")], dir, env);

  for (const side of ["plans-a", "plans-b"]) {
    const plans = join(dir, side);
    const sideEnv = fixtureEnv(dir, plans);
    writeFileSync(join(plans, "Demo/index.tsv"), `${COLUMNS.join("\t")}\n`);

    for (const slug of slugs) {
      const added = await run([bin, "plans", "add", "Demo", slug, "P2", "S"], dir, sideEnv);
      const id = added.split("\t", 1)[0] ?? "";
      writeFileSync(join(plans, `Demo/${id}-${slug}.md`), planText(id, slug));
    }

    await run([bin, "plans", "import"], dir, sideEnv);
  }

  process.stdout.write(
    [
      `export PLANS_DIR=${quoted(join(dir, "plans-a"))}`,
      `export SKILLS_CONF=${quoted(join(dir, "conf"))}`,
      `export HOME=${quoted(join(dir, "home"))}`,
      `export PATH=${quoted(join(repo, "skills/playbook/bin"))}:"$PATH"`,
      "",
    ].join("\n"),
  );
}

function targetStore(dir: string): string {
  const chosen = process.env.PLANS_DIR ? resolve(process.env.PLANS_DIR) : undefined;
  const plans = [join(dir, "plans-a"), join(dir, "plans-b")].find((side) => side === chosen);
  return join(plans ?? join(dir, "plans-a"), "plans.db");
}

function ageFacts(dir: string, hours: number): void {
  if (!existsSync(join(dir, MARKER))) fail(`${dir} is not a machine fixture`);

  const db = new Database(targetStore(dir), { readwrite: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");

    const { value: machine } = db.query("SELECT value FROM meta WHERE key = 'machine'").get() as {
      value: string;
    };

    const newest = db
      .query(
        `SELECT seq, payload FROM events WHERE project = '-' AND plan = '-' AND type = ? AND machine = ?
         ORDER BY seq DESC LIMIT 1`,
      )
      .get(MACHINE_EVENT, machine) as { seq: number; payload: string } | null;

    if (!newest) fail("this device has no machine facts yet, run skills machine refresh");

    const at = Date.now() - hours * 60 * 60 * 1000;
    const captured = new Date(at).toISOString();
    const payload = { ...(JSON.parse(newest.payload) as object), captured };
    db.run("UPDATE events SET ts = ?, payload = ? WHERE seq = ?", [
      secondStamp(at),
      JSON.stringify(payload),
      newest.seq,
    ]);

    process.stdout.write(`captured ${captured}\n`);
  } finally {
    db.close();
  }
}

function backdateHeartbeats(dir: string, id: string, minutes: number): void {
  if (!existsSync(join(dir, MARKER))) fail(`${dir} is not a machine fixture`);

  const db = new Database(targetStore(dir), { readwrite: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");

    const at = Date.now() - minutes * 60_000;
    const { changes } = db.run(
      "UPDATE events SET wall = ?, ts = ? WHERE project = 'Demo' AND plan = ? AND type = ?",
      [at, secondStamp(at), id, HEARTBEAT],
    );

    if (changes === 0) fail(`row ${id} has no heartbeat to backdate`);
    process.stdout.write(`backdated ${changes} to ${new Date(at).toISOString()}\n`);
  } finally {
    db.close();
  }
}

async function hold(dir: string, seconds: number): Promise<void> {
  if (!existsSync(join(dir, MARKER))) fail(`${dir} is not a machine fixture`);

  const db = new Database(join(dir, "plans-a/plans.db"), { readwrite: true, strict: true });
  try {
    db.run("PRAGMA busy_timeout = 10000");
    db.run("BEGIN IMMEDIATE");
    process.stdout.write(`holding ${seconds}s\n`);

    await Bun.sleep(seconds * 1000);
    db.run("ROLLBACK");
  } finally {
    db.close();
  }
}

function deviceFacts(dir: string, label: string, caps: readonly string[]): Facts {
  const platform = caps.includes("macos") ? "darwin" : caps.includes("linux") ? "linux" : "fixture";
  const tool = (name: string): Tool =>
    !isCapability(name) || caps.includes(name)
      ? { version: "fixture" }
      : { absent: true, reason: "fixture" };

  return {
    label,
    environment: null,
    os: { platform, version: null },
    arch: "arm64",
    tools: Object.fromEntries(TOOLS.map((name) => [name, tool(name)])) as Facts["tools"],
    checkouts: { Demo: { path: join(dir, "b/Demo"), origin: join(dir, "origin.git") } },
    captured: new Date().toISOString(),
  };
}

function addDevice(dir: string, label: string, caps: readonly string[]): void {
  if (!existsSync(join(dir, MARKER))) fail(`${dir} is not a machine fixture`);

  const unknown = caps.find((cap) => !isCapability(cap));
  if (unknown) fail(`unknown capability "${unknown}", one of ${CAPABILITIES.join(", ")}`);
  if (caps.includes("macos") && caps.includes("linux"))
    fail("a device is macos or linux, not both");

  const store = openStore(targetStore(dir));
  try {
    const machine = write(store, () => {
      const known = store.db
        .query(
          `SELECT machine, payload FROM events
           WHERE project = '-' AND plan = '-' AND type = ? AND machine != ? ORDER BY seq DESC`,
        )
        .all(MACHINE_EVENT, store.machine) as { machine: string; payload: string }[];

      const id =
        known.find(({ payload }) => factsFrom(JSON.parse(payload))?.label === label)?.machine ??
        crypto.randomUUID();

      const device = { ...store, machine: id };
      appendEvent(device, {
        kind: "stored",
        type: MACHINE_EVENT,
        at: Date.now(),
        project: "-",
        plan: "-",
        payload: deviceFacts(dir, label, caps),
      });

      store.clock = device.clock;
      return id;
    });

    process.stdout.write(`device ${label} ${machine}\n`);
  } finally {
    store.db.close();
  }
}

const [dir, ...flags] = process.argv.slice(2);
if (!dir || dir.startsWith("--")) fail(usage);

const root = resolve(dir);
if (flags[0] === "--age-facts") {
  const hours = Number(flags[1]);
  if (flags.length !== 2 || !Number.isFinite(hours) || hours < 0) fail(usage);
  ageFacts(root, hours);
} else if (flags[0] === "--backdate-heartbeats") {
  const [, id, raw] = flags;
  const minutes = Number(raw);
  if (flags.length !== 3 || !id || !Number.isFinite(minutes) || minutes < 0) fail(usage);
  backdateHeartbeats(root, id, minutes);
} else if (flags[0] === "--hold") {
  const seconds = Number(flags[1]);
  if (flags.length !== 2 || !Number.isFinite(seconds) || seconds <= 0) fail(usage);
  await hold(root, seconds);
} else if (flags[0] === "--device") {
  const [, label, caps, list] = flags;
  if (flags.length !== 4 || !label || caps !== "--caps" || !list) fail(usage);
  addDevice(root, label, list.split(",").filter(Boolean));
} else if (flags.length === 0 || (flags[0] === "--rows" && flags.length === 2 && flags[1]))
  await build(root, flags[1]?.split(",").filter(Boolean) ?? []);
else fail(usage);
