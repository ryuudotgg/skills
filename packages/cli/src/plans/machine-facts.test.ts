import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Facts, MACHINE_EVENT, SESSION_EVENT, TOOLS } from "skills-core";
import { sessionLines } from "../sessions/ledger.ts";
import { importStore } from "./import.ts";
import { newestFacts, otherMachineFacts } from "./machine.ts";
import { appendEvent, openStore, write, type Store } from "./store.ts";

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

async function plansStore(): Promise<Store> {
  const root = mkdtempSync(join(tmpdir(), "machine-facts-"));
  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  cleanup.push(() => {
    store.db.close();
    rmSync(root, { recursive: true, force: true });
  });

  return store;
}

function facts(label: string): Facts {
  return {
    label,
    environment: null,
    os: { platform: "darwin", version: "27.2.0" },
    arch: "arm64",
    tools: Object.fromEntries(TOOLS.map((name) => [name, { version: "1.0.0" }])) as Facts["tools"],
    checkouts: {},
    captured: "2026-11-17T12:00:00.000Z",
  };
}

function appendFacts(store: Store, label: string, machine = store.machine): string {
  const id = write(store, () =>
    appendEvent(store, {
      kind: "stored",
      type: MACHINE_EVENT,
      at: Date.now(),
      project: "-",
      plan: "-",
      payload: facts(label),
    }),
  );

  store.db.run("UPDATE events SET machine = ? WHERE id = ?", [machine, id]);
  return id;
}

function quarantine(store: Store, id: string): void {
  store.db.run("UPDATE events SET quarantined = 'revoked' WHERE id = ?", [id]);
}

test("quarantined machine events supply no facts", async () => {
  const store = await plansStore();

  const ownOlder = appendFacts(store, "Own older");
  const ownNewer = appendFacts(store, "Own newer");
  const otherOlder = appendFacts(store, "Other older", "other");
  const otherNewer = appendFacts(store, "Other newer", "other");

  quarantine(store, ownNewer);
  quarantine(store, otherNewer);

  expect(newestFacts(store)?.label).toBe("Own older");
  expect(otherMachineFacts(store).map((other) => other.label)).toEqual(["Other older"]);

  quarantine(store, ownOlder);
  quarantine(store, otherOlder);

  expect(newestFacts(store)).toBeUndefined();
  expect(otherMachineFacts(store)).toEqual([]);
});

test("a session label comes from visible machine events only", async () => {
  const store = await plansStore();

  write(store, () =>
    appendEvent(store, {
      kind: "stored",
      type: SESSION_EVENT,
      at: Date.now(),
      project: "Alpha",
      plan: "001",
      payload: {
        host: "claude",
        session: "claude-fixture",
        branch: "feat/one",
        plans: ["001"],
        source: "startup",
        started: "2026-11-07T10:00:00Z",
      },
    }),
  );

  const older = appendFacts(store, "Older label");
  const newer = appendFacts(store, "Newer label");
  quarantine(store, newer);

  expect(sessionLines(store).map((line) => line.machine)).toEqual(["Older label"]);

  quarantine(store, older);

  expect(sessionLines(store).map((line) => line.machine)).toEqual(["-"]);
});
