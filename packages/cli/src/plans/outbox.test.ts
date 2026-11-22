import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COLUMNS, ISSUE_FILED, issuePlan, LOG_HEADER } from "skills-core";
import { importStore } from "./import.ts";
import { held, hold, publishQuarantine, quarantinedCount, release, unsealed } from "./outbox.ts";
import { appendEvent, openStore, type Store } from "./store.ts";

const A = "a".repeat(32);
const B = "b".repeat(32);
const C = "c".repeat(32);

const cleanup: (() => void)[] = [];

afterEach(() => {
  for (const step of cleanup.splice(0).reverse()) step();
});

async function plans(): Promise<{ root: string; store: Store }> {
  const root = mkdtempSync(join(tmpdir(), "plans-outbox-"));
  mkdirSync(join(root, "Skills"), { recursive: true });
  writeFileSync(join(root, "Skills", "index.tsv"), `${COLUMNS.join("\t")}\n`);
  writeFileSync(join(root, "log.tsv"), LOG_HEADER);
  await importStore({ PLANS_DIR: root });

  const store = openStore(join(root, "plans.db"));
  cleanup.push(() => {
    try {
      store.db.close();
    } catch {}

    rmSync(root, { recursive: true, force: true });
  });

  return { root, store };
}

const FILED_AT = Date.UTC(2026, 10, 1);
function file(store: Store, n: number): string {
  return appendEvent(store, {
    kind: "stored",
    at: FILED_AT + n * 1000,
    project: "Skills",
    plan: issuePlan(n),
    type: ISSUE_FILED,
    payload: { n, title: `issue ${n}`, body: null, from: null },
  });
}

function revoke(store: Store, author: string, ids: readonly string[]): void {
  for (const [index, id] of ids.entries())
    store.db.run(
      "UPDATE events SET author = ?, sequence = ?, quarantined = 'revoked' WHERE id = ?",
      [author, index + 1, id],
    );
}

function seqOf(store: Store, id: string): number {
  return (store.db.query("SELECT seq FROM events WHERE id = ?").get(id) as { seq: number }).seq;
}

type TwoDevices = {
  root: string;
  store: Store;
  revoked: string[];
  below: string;
  above: string;
};

async function heldUnderTwoDevices(): Promise<TwoDevices> {
  const { root, store } = await plans();

  const first = [file(store, 1), file(store, 2)];
  revoke(store, A, first);
  hold(store, A);

  const second = [file(store, 3)];
  revoke(store, B, second);
  const below = file(store, 4);
  hold(store, B);

  const above = file(store, 5);
  return { root, store, revoked: [...first, ...second], below, above };
}

test("a store held under two devices counts and republishes both", async () => {
  const { root, store, revoked } = await heldUnderTwoDevices();
  expect(quarantinedCount(store, C)).toBe(4);

  expect(await publishQuarantine(root, store, C)).toBe(4);
  expect(held(store)).toBeUndefined();

  for (const id of revoked) {
    const { project, plan, type } = store.db
      .query("SELECT project, plan, type FROM events WHERE id = ?")
      .get(id) as { project: string; plan: string; type: string };

    const copies = store.db
      .query(
        `SELECT id FROM events WHERE project = ? AND plan = ? AND type = ?
           AND author IS NULL AND quarantined IS NULL`,
      )
      .all(project, plan, type);

    expect(copies).toHaveLength(1);
  }
});

test("a marked device that is current holds its whole outbox", async () => {
  const { store, below, above } = await heldUnderTwoDevices();
  const through = seqOf(store, below);

  expect(unsealed(store, B, 100)).toEqual([]);
  expect(unsealed(store, C, 100).map((event) => event.record.id)).toEqual([above]);

  release(store, B);
  expect(held(store)).toEqual({ devices: [A], through });
});
