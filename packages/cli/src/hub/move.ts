import { dirname, join } from "node:path";
import { blobId, CHUNK_SIZE, factsFrom, MACHINE_EVENT, type Id } from "skills-core";
import type { Store } from "../plans/store.ts";
import { putEach } from "./blobs.ts";
import { enrolled, labelOf, type Deps, type Enrolled } from "./enroll.ts";
import { withLock } from "../lock.ts";
import { hubLeases, keyFor, leaserOf, type Leaser } from "./leases.ts";
import { hubSetting } from "./network.ts";
import { Budget, Keys, listOf, type Run } from "./run.ts";
import { hubDeps, LONG_BUDGET, syncOnce } from "./sync.ts";
import { counts } from "../plans/outbox.ts";
import { readLocal } from "./vault.ts";

export type Party = { readonly device: string; readonly label: string };

export type Target = Party | { readonly refusal: string };

export type MoveHub = {
  readonly self: Party;
  target(wanted: string): Target;
  holder(project: string, id: string): Promise<Party | undefined>;
  upload(bytes: Uint8Array, locators?: readonly string[]): Promise<string[]>;
  publish(project: string, id: string, commit: () => void): Promise<boolean>;
};

export function hubConfigured(store: Store, env: NodeJS.ProcessEnv): boolean {
  return hubSetting(env, "HUB_URL") !== undefined && readLocal(store).checkpoint !== undefined;
}

function factLabels(store: Store): Map<string, string> {
  const rows = store.db
    .query(
      `SELECT author, payload FROM events
       WHERE type = ? AND project = '-' AND plan = '-' AND author IS NOT NULL
         AND quarantined IS NULL
       ORDER BY wall DESC, counter DESC`,
    )
    .all(MACHINE_EVENT) as { author: string; payload: string }[];

  const labels = new Map<string, string>();
  for (const { author, payload } of rows) {
    if (labels.has(author)) continue;
    const label = factsFrom(JSON.parse(payload))?.label;
    if (label !== undefined) labels.set(author, label);
  }

  return labels;
}

async function devicesOf(store: Store, current: Enrolled): Promise<Party[]> {
  const facts = factLabels(store);
  const live = [...current.membership.devices.values()].filter(
    (member) => member.revoked === undefined,
  );

  return Promise.all(
    live.map(async (member) => ({
      device: member.id,
      label:
        facts.get(member.id) ??
        (await labelOf(current.membership, current.epochKeys, member.id as Id)),
    })),
  );
}

function pick(devices: readonly Party[], self: string, wanted: string): Target {
  const byId = devices.find((party) => party.device === wanted);
  const named = devices.filter((party) => party.label === wanted);
  const found = byId ?? named[0];

  if (byId === undefined && named.length > 1)
    return {
      refusal: `${named.length} machines are labelled ${wanted}: ${named.map((party) => party.device).join(", ")}, pass a device id`,
    };

  if (found === undefined) return { refusal: `no machine labelled ${wanted}` };
  if (found.device === self) return { refusal: `${found.label} is this machine` };
  return found;
}

function runOf(deps: Deps, current: Enrolled): Run {
  return {
    deps,
    root: dirname(deps.store.db.filename),
    budget: new Budget(LONG_BUDGET),
    keys: new Keys(current.epochKeys),
    current,
    report: {
      pushedEvents: 0,
      pushedBlobs: 0,
      pulledEvents: 0,
      pulledBlobs: 0,
      landed: [],
      conflicts: [],
      leaseConflicts: [],
      reconciled: false,
      refused: 0,
      skipped: [],
      refusedPaths: [],
    },
  };
}

export async function openMoveHub(store: Store, env: NodeJS.ProcessEnv): Promise<MoveHub> {
  const url = hubSetting(env, "HUB_URL") ?? "";
  const deps = { ...hubDeps(store, env, () => {}), quiet: true };
  const current = await enrolled(deps, url, false, undefined, Date.now() + LONG_BUDGET);
  const devices = await devicesOf(store, current);
  const self = devices.find((party) => party.device === current.device) ?? {
    device: current.device,
    label: current.device,
  };

  const call: Leaser["call"] = (method, path, body) =>
    current.client.call(method, path, body, current.signer);

  const leaser = await leaserOf(current, call);
  const lease = async (project: string, id: string) =>
    leaser && (await hubLeases(call)).get(await keyFor(leaser, project, id));

  return {
    self,
    target: (wanted) => pick(devices, current.device, wanted),
    async holder(project, id) {
      const found = await lease(project, id);
      if (found === undefined || found.holder === current.device) return undefined;

      return {
        device: found.holder,
        label: await labelOf(current.membership, current.epochKeys, found.holder as Id),
      };
    },
    async upload(bytes, locators) {
      const blobs = Array.from(
        { length: Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE)) },
        (_, index) => ({
          sha256: "",
          locator: locators?.[index] ?? blobId(),
          bytes: bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE),
        }),
      );

      const missing =
        locators === undefined
          ? undefined
          : new Set(
              listOf(await call("POST", "/v1/blobs/have", { ids: locators }), "missing").map(
                String,
              ),
            );

      await putEach(
        runOf(deps, current),
        blobs.filter((blob) => missing?.has(blob.locator) ?? true),
      );

      return blobs.map((blob) => blob.locator);
    },
    publish(project, id, commit) {
      return withLock(join(dirname(store.db.filename), "hub.lock"), "hub sync", async () => {
        commit();

        try {
          await syncOnce(deps, url, { budget: LONG_BUDGET, publishQuarantine: false, quiet: true });
          if (counts(store).queue > 0) return false;
          return (await lease(project, id))?.holder !== current.device;
        } catch {
          return false;
        }
      });
    },
  };
}
