import { blobId } from "skills-core";
import { deletedAmong, tombstone } from "./outbox.ts";
import { metaValue, projectMoves, setMeta, write, type Store } from "./store.ts";

export type PackKey = {
  readonly project: string;
  readonly plan: string;
  readonly sha256: string;
  readonly recorded?: readonly string[];
};

type SavedPack = {
  readonly sha256: string;
  readonly locators: readonly string[];
  readonly chunks: readonly string[];
};

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
  const value = metaValue(store.db, packKey(key));
  const saved: unknown = value === undefined ? undefined : JSON.parse(value);
  return typeof saved === "object" && saved !== null ? (saved as Partial<SavedPack>) : undefined;
}

function savedLocators(saved: Partial<SavedPack> | undefined): string[] {
  const locators: unknown = saved?.locators;
  return Array.isArray(locators)
    ? locators.filter((locator) => typeof locator === "string" && LOCATOR.test(locator))
    : [];
}

function unchangedOr(saved: Partial<SavedPack> | undefined, chunks: readonly string[]): string[] {
  const locators: unknown = saved?.locators;
  const digests: unknown = saved?.chunks;
  const usable = Array.isArray(locators) && Array.isArray(digests);

  return chunks.map((digest, index) => {
    const locator: unknown = usable ? locators[index] : undefined;
    const same = usable && digests[index] === digest;
    return same && typeof locator === "string" && LOCATOR.test(locator) ? locator : blobId();
  });
}

export function retirePack(
  store: Store,
  project: string,
  plan: string,
  locators: readonly string[],
  live: readonly string[] = [],
): void {
  const saved = savedLocators(savedPack(store, { project, plan }));
  setMeta(store.db, packKey({ project, plan }), undefined);
  tombstone(store, project, [...locators, ...saved], live);
}

export function claimLocators(
  store: Store,
  key: PackKey,
  chunks: readonly string[],
  retired: ReadonlySet<string> = new Set(),
): string[] {
  return write(store, () => {
    const saved = savedPack(store, key);
    const same = saved?.sha256 === key.sha256;
    const kept =
      (same ? fitting(saved.locators, chunks.length) : undefined) ??
      fitting(key.recorded, chunks.length) ??
      unchangedOr(saved, chunks);

    if (saved !== undefined && !same)
      tombstone(
        store,
        key.project,
        savedLocators(saved).filter((locator) => !kept.includes(locator)),
        projectMoves(store, key.project).get(key.plan)?.blobs,
      );

    const deleted = deletedAmong(store, kept);
    const dead = (locator: string) => retired.has(locator) || deleted.has(locator);
    const locators = kept.map((locator) => (dead(locator) ? blobId() : locator));
    const claimed: SavedPack = { sha256: key.sha256, locators, chunks };
    setMeta(store.db, packKey(key), JSON.stringify(claimed));

    return locators;
  });
}
