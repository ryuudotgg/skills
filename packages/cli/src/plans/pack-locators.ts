import { blobId } from "skills-core";
import { deletedAmong, tombstone } from "./outbox.ts";
import { projectMoves, write, type Store } from "./store.ts";

export type PackKey = {
  readonly project: string;
  readonly plan: string;
  readonly sha256: string;
  readonly recorded?: readonly string[];
};

type SavedPack = { readonly sha256: string; readonly locators: readonly string[] };

const LOCATOR = /^[0-9a-f]{32}$/;

type PlanKey = Pick<PackKey, "project" | "plan">;

function packKey(key: PlanKey): string {
  return `hub_pack:${JSON.stringify([key.project, key.plan])}`;
}

function fitting(locators: unknown, count: number): readonly string[] | undefined {
  const usable =
    Array.isArray(locators) &&
    locators.length === count &&
    locators.every((locator) => typeof locator === "string" && LOCATOR.test(locator));

  return usable ? locators : undefined;
}

function savedPack(store: Store, key: PlanKey): Partial<SavedPack> | undefined {
  const row = store.db.query("SELECT value FROM meta WHERE key = ?").get(packKey(key)) as {
    value: string;
  } | null;

  const saved: unknown = row === null ? undefined : JSON.parse(row.value);
  return typeof saved === "object" && saved !== null ? (saved as Partial<SavedPack>) : undefined;
}

function savedLocators(saved: Partial<SavedPack> | undefined): string[] {
  const locators: unknown = saved?.locators;
  return Array.isArray(locators)
    ? locators.filter((locator) => typeof locator === "string" && LOCATOR.test(locator))
    : [];
}

export function retirePack(
  store: Store,
  project: string,
  plan: string,
  locators: readonly string[],
  live: readonly string[] = [],
): void {
  const saved = savedLocators(savedPack(store, { project, plan }));
  store.db.run("DELETE FROM meta WHERE key = ?", [packKey({ project, plan })]);
  tombstone(store, project, [...locators, ...saved], live);
}

export function claimLocators(
  store: Store,
  key: PackKey,
  count: number,
  retired: ReadonlySet<string> = new Set(),
): string[] {
  return write(store, () => {
    const saved = savedPack(store, key);
    if (saved !== undefined && saved.sha256 !== key.sha256)
      tombstone(
        store,
        key.project,
        savedLocators(saved),
        projectMoves(store, key.project).get(key.plan)?.blobs,
      );

    const kept =
      (saved?.sha256 === key.sha256 ? fitting(saved.locators, count) : undefined) ??
      fitting(key.recorded, count) ??
      Array.from({ length: count }, () => blobId());

    const deleted = deletedAmong(store, kept);
    const dead = (locator: string) => retired.has(locator) || deleted.has(locator);
    const locators = kept.map((locator) => (dead(locator) ? blobId() : locator));
    const claimed: SavedPack = { sha256: key.sha256, locators };
    store.db.run(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
      [packKey(key), JSON.stringify(claimed)],
    );

    return locators;
  });
}
