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
import { BATCH, type Run } from "./run.ts";

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

type Checkpoint = Pick<Retried, "length" | "epoch">;

export async function retryUnopened(
  run: Run,
  verifier: Verifier,
  { length, epoch }: Checkpoint,
): Promise<void> {
  const { store } = run.deps;
  const last = retriedUnder(store);
  const begun = last?.length === length && last.epoch === epoch ? last : undefined;
  if (begun !== undefined && begun.after === undefined) return;

  let after = begun?.after ?? 0;
  for (;;) {
    const events = unopenedEvents(store, after, BATCH);
    const tail = events.at(-1);
    if (tail === undefined) break;

    run.budget.check();
    await reopen(run, verifier, { events, recheck: false });
    after = tail.seq;
    markRetried(store, { length, epoch, after });
  }

  markRetried(store, { length, epoch });
}
