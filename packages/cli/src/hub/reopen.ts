import {
  malformedFileEvents,
  markRecheckedFiles,
  markRetried,
  recheckedFiles,
  retriedUnder,
  unopenedEvents,
  type Retried,
} from "../plans/outbox.ts";
import { applyRemoteEvents, type AuthoredEvent, type Verifier } from "../plans/sync.ts";
import type { Run } from "./run.ts";

type Reopened = { readonly events: readonly AuthoredEvent[]; readonly recheck: boolean };

async function reopen(run: Run, verifier: Verifier, { events, recheck }: Reopened): Promise<void> {
  if (events.length === 0) return;
  const applied = await applyRemoteEvents(run.root, { events, blobs: [], recheck }, verifier);
  run.report.refusedPaths.push(...applied.refusedPaths);
}

export async function recheckFiles(run: Run, verifier: Verifier): Promise<void> {
  const { store } = run.deps;
  if (recheckedFiles(store)) return;

  await reopen(run, verifier, { events: malformedFileEvents(store), recheck: true });
  markRecheckedFiles(store);
}

export async function retryUnopened(run: Run, verifier: Verifier, under: Retried): Promise<void> {
  const { store } = run.deps;
  const last = retriedUnder(store);
  if (last?.length === under.length && last.epoch === under.epoch) return;

  await reopen(run, verifier, { events: unopenedEvents(store), recheck: false });
  markRetried(store, under);
}
