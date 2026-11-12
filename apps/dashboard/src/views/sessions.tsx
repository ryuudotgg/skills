import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  durationText,
  isSessionPolicy,
  machineLabel,
  machineLabels,
  policyAllows,
  sessionList,
  type SessionPolicy,
  type SessionSummary,
} from "skills-core";
import type { Reply, View, ViewProps } from "../view.ts";

const EMPTY = "no sessions";

const MISSING = "no such session";

const NO_DIGEST = "no digest for this session";

const RETRY_MS = 5_000;

const COLUMNS = [
  "Time",
  "Session",
  "Host",
  "Project",
  "Branch",
  "Plan",
  "Models",
  "Tokens in",
  "Tokens out",
  "Tool calls",
  "Duration",
  "Machine",
];

export type DigestState =
  | { kind: "reading" }
  | { kind: "shown"; text: string }
  | { kind: "none" }
  | { kind: "failed"; reason: string }
  | { kind: "withheld"; policy: SessionPolicy };

type Labels = ReadonlyMap<string, string>;

const encoded = (segment: string) => encodeURIComponent(segment);
function sessionPath(summary: Pick<SessionSummary, "session">): string {
  return `/sessions/${encoded(summary.session)}`;
}

function planPath(link: string): string {
  const [project = "", id = ""] = link.split("/");
  return `/plan/${encoded(project)}/${encoded(id)}`;
}

function request(read: ViewProps["read"], path: string): Promise<Reply> {
  return read(path).catch((error: unknown) => ({
    status: 0,
    text: error instanceof Error ? error.message : String(error),
  }));
}

function failure(reply: Reply): string | undefined {
  if (reply.status === 200 || reply.status === 404) return undefined;
  return reply.text.trim() || `HTTP ${reply.status}`;
}

export async function readDigest(
  summary: Pick<SessionSummary, "session" | "digest">,
  read: ViewProps["read"],
): Promise<DigestState> {
  const local = await request(read, `${sessionPath(summary)}/digest`);
  if (local.status === 200) return { kind: "shown", text: local.text };

  const policy = local.text.trim();
  if (local.status === 403 && isSessionPolicy(policy)) return { kind: "withheld", policy };

  const pulled =
    summary.digest === null ? undefined : await request(read, `/blobs/${summary.digest}`);

  if (pulled?.status === 200) return { kind: "shown", text: pulled.text };

  const reason = (pulled && failure(pulled)) ?? failure(local);
  return reason === undefined ? { kind: "none" } : { kind: "failed", reason };
}

function Cell({ children, wraps = false }: { children: ReactNode; wraps?: boolean }) {
  const flow = wraps ? "min-w-24 [overflow-wrap:anywhere]" : "whitespace-nowrap";
  return <td className={`py-1.5 pr-4 align-baseline ${flow}`}>{children}</td>;
}

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a
      href={href}
      className="font-mono underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
    >
      {children}
    </a>
  );
}

function Row({
  summary,
  labels,
  link,
}: {
  summary: SessionSummary;
  labels: Labels;
  link: ViewProps["link"];
}) {
  return (
    <tr data-session={summary.session} className="border-b border-hairline">
      <Cell>
        <time dateTime={summary.start} className="font-mono text-ink-secondary tabular-nums">
          {summary.start}
        </time>
      </Cell>
      <Cell wraps>
        <Anchor href={link(sessionPath(summary))}>{summary.session}</Anchor>
      </Cell>
      <Cell>{summary.host}</Cell>
      <Cell>{summary.project}</Cell>
      <Cell wraps>
        <span className="font-mono">{summary.branch}</span>
      </Cell>
      <Cell>
        {summary.plans.length === 0 ? (
          "-"
        ) : (
          <span className="flex flex-wrap gap-x-2">
            {summary.plans.map((plan) => (
              <Anchor key={plan} href={link(planPath(plan))}>
                {plan}
              </Anchor>
            ))}
          </span>
        )}
      </Cell>
      <Cell>{summary.models.join(" ") || "-"}</Cell>
      <Cell>
        <span data-cell="in" className="font-mono tabular-nums">
          {summary.in}
        </span>
      </Cell>
      <Cell>
        <span data-cell="out" className="font-mono tabular-nums">
          {summary.out}
        </span>
      </Cell>
      <Cell>
        <span data-cell="tools" className="font-mono tabular-nums">
          {summary.tools}
        </span>
      </Cell>
      <Cell>
        <span className="tabular-nums">
          {summary.duration === null ? "-" : durationText(summary.duration)}
        </span>
      </Cell>
      <Cell>{machineLabel(labels, summary.machine)}</Cell>
    </tr>
  );
}

function Table({
  sessions,
  labels,
  link,
}: {
  sessions: readonly SessionSummary[];
  labels: Labels;
  link: ViewProps["link"];
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-hairline text-ink-secondary">
            {COLUMNS.map((name) => (
              <th key={name} scope="col" className="py-1.5 pr-4 font-normal whitespace-nowrap">
                {name}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sessions.map((summary) => (
            <Row
              key={`${summary.host} ${summary.session}`}
              summary={summary}
              labels={labels}
              link={link}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Digest({ state }: { state: DigestState }) {
  if (state.kind === "reading") return <p className="text-ink-secondary">reading digest</p>;
  if (state.kind === "none") return <p className="text-ink-secondary">{NO_DIGEST}</p>;
  if (state.kind === "failed")
    return <p className="text-accent">digest unreadable: {state.reason}</p>;

  if (state.kind === "withheld")
    return <p className="text-ink-secondary">digest not synced under policy {state.policy}</p>;

  return (
    <pre
      data-digest=""
      className="overflow-x-auto rounded border border-hairline bg-surface p-3 font-mono text-sm whitespace-pre-wrap [overflow-wrap:anywhere]"
    >
      {state.text}
    </pre>
  );
}

type SessionDetailProps = {
  summary: SessionSummary;
  labels: Labels;
  digest: DigestState;
  link: ViewProps["link"];
};

export function SessionDetail({ summary, labels, digest, link }: SessionDetailProps) {
  return (
    <div className="flex flex-col gap-8">
      <Table sessions={[summary]} labels={labels} link={link} />
      <section aria-labelledby="session-digest" className="flex min-w-0 flex-col gap-3">
        <h2 id="session-digest" className="text-base font-semibold">
          Digest
        </h2>
        <Digest state={digest} />
      </section>
    </div>
  );
}

function withheld(summary: SessionSummary): DigestState | undefined {
  return policyAllows(summary.policy, "redacted")
    ? undefined
    : { kind: "withheld", policy: summary.policy };
}

function SessionPage({
  summary,
  labels,
  link,
  read,
}: Omit<SessionDetailProps, "digest"> & {
  read: ViewProps["read"];
}) {
  const [state, setState] = useState<DigestState>({ kind: "reading" });
  const [attempt, setAttempt] = useState(0);

  const held = withheld(summary);
  const { session, digest } = summary;
  const fetches = held === undefined;
  const version = [summary.end, summary.in, summary.out, summary.tools].join(" ");

  useEffect(() => {
    if (!fetches) return;

    let current = true;
    let retry: ReturnType<typeof setTimeout> | undefined;
    void readDigest({ session, digest }, read).then((next) => {
      if (!current) return;

      setState(next);

      if (next.kind === "failed" || (next.kind === "none" && digest !== null))
        retry = setTimeout(() => setAttempt((count) => count + 1), RETRY_MS);
    });

    return () => {
      current = false;
      clearTimeout(retry);
    };
  }, [fetches, session, digest, version, read, attempt]);

  return <SessionDetail summary={summary} labels={labels} digest={held ?? state} link={link} />;
}

function SessionsView({ scene, params, link, read }: ViewProps) {
  const sessions = useMemo(() => sessionList(scene.events, scene.sessions), [scene]);
  const labels = useMemo(() => machineLabels(scene.events), [scene.events]);
  const [id] = params;

  if (params.length > 1) return <p className="text-ink-secondary">{MISSING}</p>;
  if (id !== undefined) {
    const summary = sessions.find((each) => each.session === id);
    if (!summary) return <p className="text-ink-secondary">{MISSING}</p>;
    return (
      <SessionPage
        key={summary.session}
        summary={summary}
        labels={labels}
        link={link}
        read={read}
      />
    );
  }

  if (sessions.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;
  return <Table sessions={sessions} labels={labels} link={link} />;
}

export const sessions: View = {
  name: "Sessions",
  path: "/sessions",
  empty: EMPTY,
  detail: true,
  Component: SessionsView,
};
