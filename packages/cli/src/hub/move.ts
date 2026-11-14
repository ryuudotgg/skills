import { dirname, join } from "node:path";
import { CHUNK_SIZE, factsFrom, MACHINE_EVENT, type Id } from "skills-core";
import type { Io } from "../io.ts";
import type { Store } from "../plans/store.ts";
import { HubRefusal, type Fetch } from "./client.ts";
import { fetchOne, holdings, putSealed } from "./blobs.ts";
import { enrolled, labelOf, type Deps, type Enrolled } from "./enroll.ts";
import { withLock } from "../lock.ts";
import { hubLeases, keyFor, leaserOf, type Leaser } from "./leases.ts";
import { hubSetting } from "./network.ts";
import { Budget, Keys, type Run } from "./run.ts";
import { emptyReport, hubDeps, LONG_BUDGET, syncOnce } from "./sync.ts";
import { acknowledged, claimLocators, stopped, type PackKey } from "../plans/outbox.ts";
import { readLocal } from "./vault.ts";

export type Party = { readonly device: string; readonly label: string };

export type Target = Party | { readonly refusal: string };

export type MoveWire = { readonly fetch: Fetch; readonly syncBudget: number };

export type MoveIo = Io & { readonly wire?: MoveWire };

export type MoveHub = {
  readonly self: Party;
  target(wanted: string): Target;
  holder(project: string, id: string): Promise<Party | undefined>;
  upload(key: PackKey, bytes: Uint8Array): Promise<string[]>;
  download(locators: readonly string[]): Promise<Uint8Array>;
  pull(): Promise<void>;
  publish(project: string, id: string, commit: () => string): Promise<boolean>;
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
    budget: new Budget(Number.POSITIVE_INFINITY),
    keys: new Keys(current.epochKeys),
    current,
    report: emptyReport(),
  };
}

async function putChunk(run: Run, locator: string, bytes: Uint8Array): Promise<void> {
  try {
    await putSealed(run, { locator, bytes });
  } catch (error) {
    const reason = error instanceof HubRefusal ? error.reason : undefined;
    if (reason === "blob-conflict") return;
    if (reason === "too-large")
      throw new Error("the hub refuses the pack chunks as too large, pass --file <path>");

    throw error;
  }
}

export async function openMoveHub(store: Store, io: MoveIo): Promise<MoveHub> {
  const url = hubSetting(io.env, "HUB_URL") ?? "";
  const wire = io.wire ?? { fetch, syncBudget: LONG_BUDGET };
  const deps = { ...hubDeps(store, io.env, () => {}, wire.fetch), quiet: true };
  const current = await enrolled(deps, url, false);
  const sync = { budget: wire.syncBudget, publishQuarantine: false, quiet: true } as const;

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
    async upload(key, bytes) {
      const count = Math.max(1, Math.ceil(bytes.length / CHUNK_SIZE));
      const run = runOf(deps, current);
      const claimed = claimLocators(store, key, count);
      const { missing, deleted } = await holdings(run, claimed);
      const locators = deleted.size === 0 ? claimed : claimLocators(store, key, count, deleted);
      for (const [index, locator] of locators.entries()) {
        if (locator === claimed[index] && !missing.has(locator)) continue;
        await putChunk(run, locator, bytes.subarray(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE));
      }

      return locators;
    },
    async download(locators) {
      const fresh = await enrolled(deps, url, false);
      const run = runOf(deps, fresh);
      const parts: Uint8Array[] = [];
      for (const locator of locators) {
        const fetched = await fetchOne(run, locator);
        if (fetched.kind !== "bytes") throw new Error(`the hub has no pack chunk ${locator}`);
        parts.push(fetched.plain);
      }

      return new Uint8Array(Buffer.concat(parts));
    },
    pull() {
      return withLock(join(dirname(store.db.filename), "hub.lock"), "hub sync", async () => {
        if (stopped(store)?.device === current.device)
          throw new Error("sync is stopped on this machine, run skills hub sync");

        await syncOnce(deps, url, sync);
      });
    },
    publish(project, id, commit) {
      return withLock(join(dirname(store.db.filename), "hub.lock"), "hub sync", async () => {
        const event = commit();
        try {
          await syncOnce(deps, url, sync);
          if (!acknowledged(store, event)) return false;
          return (await lease(project, id))?.holder !== current.device;
        } catch {
          return false;
        }
      });
    },
  };
}
