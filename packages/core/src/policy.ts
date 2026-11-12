import { parseBlockers, type BlockerRef } from "./blockers.ts";
import { DIGEST_EVENT, withholdLines } from "./digest.ts";
import type { EventRecord } from "./events.ts";
import { ISSUE_CLOSED, ISSUE_FILED, ISSUE_LINK, linkedFrom } from "./issues.ts";
import {
  DEFAULT_POLICY,
  isSessionPolicy,
  POLICY_EVENT,
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  strictestPolicy,
  TRANSCRIPT_EVENT,
  type SessionPolicy,
} from "./sessions.ts";
import { AD_HOC_ID } from "./trail.ts";

export type Placed = Pick<EventRecord, "project" | "plan" | "type" | "payload" | "wall">;

export type Policies = ReadonlyMap<string, SessionPolicy>;

export const WITHHELD_REF = "withheld";

const SESSION_TYPES: ReadonlySet<string> = new Set([
  SESSION_EVENT,
  SESSION_STATS_EVENT,
  TRANSCRIPT_EVENT,
]);

const RELEASED: ReadonlySet<unknown> = new Set(["DONE", "DROPPED"]);

const BLOB_DELETED = "blob-deleted";

function fields(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function sessionKeyOf(event: Pick<Placed, "type" | "payload">): string | undefined {
  if (!SESSION_TYPES.has(event.type)) return undefined;

  const { host, session } = fields(event.payload) ?? {};
  return typeof host === "string" && typeof session === "string" && session !== ""
    ? `${host}\t${session}`
    : undefined;
}

export function policiesOf(events: Iterable<Pick<Placed, "project" | "type" | "payload">>) {
  const policies = new Map<string, SessionPolicy>();
  for (const event of events) {
    const policy = event.type === POLICY_EVENT ? fields(event.payload)?.policy : undefined;
    if (isSessionPolicy(policy)) policies.set(event.project, policy);
  }

  return policies;
}

export function projectPolicy(policies: Policies, project: string): SessionPolicy {
  if (project === AD_HOC_ID) return "off";
  return policies.get(project) ?? DEFAULT_POLICY;
}

class Screen {
  readonly sessions = new Map<string, SessionPolicy>();
  readonly #silenced: ReadonlySet<string>;
  readonly #projects = new Set<string>();
  readonly #released = new Set<string>();
  readonly #deleted = new Set<string>();
  readonly #quiet: Set<string>;

  constructor(
    events: readonly Placed[],
    policies: Policies,
    at: number,
    withheld: Iterable<string>,
  ) {
    this.#quiet = new Set(withheld);
    const off = [...policies].filter(
      ([project, policy]) => policy === "off" && project !== AD_HOC_ID,
    );

    this.#silenced = new Set(off.map(([project]) => project));

    const linked = new Map<string, Set<string>>();
    for (const event of events) {
      this.#projects.add(event.project);

      const key = sessionKeyOf(event);
      if (key !== undefined) linked.set(key, (linked.get(key) ?? new Set()).add(event.project));

      this.#learn(event, at);
    }

    for (const [key, projects] of linked) {
      if (this.#quiet.has(key) || [...projects].some((project) => this.#hidden(project))) {
        this.#quiet.add(key);
        continue;
      }

      const each = [...projects].map((project) => projectPolicy(policies, project));
      this.sessions.set(key, strictestPolicy(each) ?? "off");
    }
  }

  get active(): boolean {
    return this.#silenced.size > 0 || this.#deleted.size > 0 || this.#quiet.size > 0;
  }

  #learn(event: Placed, at: number): void {
    const payload = fields(event.payload);
    if (event.type === BLOB_DELETED && typeof payload?.blob === "string")
      this.#deleted.add(payload.blob);

    if (!this.#hidden(event.project) || event.wall > at) return;
    if (event.type === ISSUE_CLOSED) this.#released.add(`${event.project}${event.plan}`);

    const row = fields(payload?.row);
    if (typeof row?.id !== "string") return;

    const ref = `${event.project}/${row.id}`;
    if (RELEASED.has(row.status)) this.#released.add(ref);
    else this.#released.delete(ref);
  }

  #hidden(project: string | undefined): boolean {
    return project !== undefined && this.#silenced.has(project);
  }

  #hiddenRef(ref: string): boolean {
    return this.#hidden(/^([^/#]+)[/#]/.exec(ref)?.[1]);
  }

  keeps(event: Placed): boolean {
    if (this.#hidden(event.project)) return false;

    const key = sessionKeyOf(event);
    if (key !== undefined) return !this.#quiet.has(key);
    if (event.type !== ISSUE_LINK) return true;

    const ref = linkedFrom(event.payload)?.ref;
    return ref === undefined || !this.#hiddenRef(ref);
  }

  payload(event: Placed): unknown {
    const payload = fields(event.payload);
    if (!payload) return event.payload;

    if (event.type === TRANSCRIPT_EVENT && this.#deleted.has(String(payload.digestBlob)))
      return { ...payload, digest: null };

    if (event.type === DIGEST_EVENT && typeof payload.markdown === "string")
      return {
        ...payload,
        markdown: withholdLines(payload.markdown, this.#silenced, this.#projects),
      };

    if (event.type === ISSUE_FILED && typeof payload.from === "string")
      return this.#hiddenRef(payload.from) ? { ...payload, from: null } : payload;

    const row = fields(payload.row);
    if (typeof row?.blocked_by !== "string") return payload;

    const refs = parseBlockers(row.blocked_by);
    const hides = (ref: BlockerRef) => "project" in ref && this.#hidden(ref.project);
    if (!refs.some(hides)) return payload;

    const column = refs.flatMap((ref) => {
      if (!hides(ref)) return [ref.text];
      return this.#released.has(ref.text) ? [] : [WITHHELD_REF];
    });

    const blocked = [...new Set(column)].join(",") || "-";
    return { ...payload, row: { ...row, blocked_by: blocked } };
  }
}

export type Screened<T> = { events: T[]; sessions: Policies };

export function screened<T extends Placed>(
  events: readonly T[],
  at = Infinity,
  withheld: Iterable<string> = [],
): Screened<T> {
  const screen = new Screen(events, policiesOf(events), at, withheld);
  const cut = at === Infinity ? events : events.filter((event) => event.wall <= at);
  if (!screen.active) return { events: [...cut], sessions: screen.sessions };

  const kept = cut.flatMap((event) => {
    if (!screen.keeps(event)) return [];
    const payload = screen.payload(event);
    return [payload === event.payload ? event : { ...event, payload }];
  });

  return { events: kept, sessions: screen.sessions };
}
