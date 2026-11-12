import { Component, useMemo, type FormEvent, type ReactElement, type ReactNode } from "react";
import { instantText, sceneFrom, screened, type FeedEvent } from "skills-core";
import type { FeedStatus } from "./client.ts";
import { hrefAt, momentOf, type Moment } from "./url.ts";
import type { ViewProps } from "./view.ts";
import { matchView, views, type Match } from "./views.ts";

export type ShellProps = {
  pathname: string;
  search: string;
  hash: string;
  events: readonly FeedEvent[];
  wall: number;
  feed: FeedStatus;
  read: ViewProps["read"];
  onTravel?: (text: string | undefined) => void;
};

function feedText(feed: FeedStatus, count: number): string {
  if (feed.kind === "loading") return "reading the feed";
  if (feed.kind === "unauthorized") return "no access: open the URL skills dash printed";
  if (feed.kind === "unreachable") return `feed unreachable: ${feed.reason}`;

  return count === 0 ? "empty store" : `${count} events`;
}

function TimeTravel({ moment, onTravel }: { moment: Moment; onTravel?: ShellProps["onTravel"] }) {
  const current =
    moment.kind === "cut" ? instantText(moment.at) : moment.kind === "invalid" ? moment.text : "";

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = new FormData(event.currentTarget).get("at");
    onTravel?.(typeof text === "string" && text.trim() !== "" ? text.trim() : undefined);
  };

  return (
    <form className="flex w-full flex-wrap items-center gap-2 sm:w-auto" onSubmit={submit}>
      <label className="text-sm whitespace-nowrap text-ink-secondary" htmlFor="at">
        Time travel
      </label>
      <input
        key={current}
        id="at"
        name="at"
        defaultValue={current}
        placeholder="2026-11-03T12:00:00Z"
        spellCheck={false}
        autoComplete="off"
        className="min-w-0 flex-1 rounded border border-hairline bg-surface px-2 py-1 font-mono text-sm tabular-nums focus:outline-2 focus:outline-focus sm:w-56 sm:flex-none"
      />
      <button
        type="submit"
        className="rounded border border-hairline px-2 py-1 text-sm hover:bg-surface focus-visible:outline-2 focus-visible:outline-focus"
      >
        Go
      </button>
      {moment.kind === "live" ? null : (
        <button
          type="button"
          onClick={() => onTravel?.(undefined)}
          className="rounded px-2 py-1 text-sm whitespace-nowrap text-ink-secondary hover:text-ink focus-visible:outline-2 focus-visible:outline-focus"
        >
          Back to now
        </button>
      )}
    </form>
  );
}

class ViewBoundary extends Component<{ children: ReactNode }, { failure?: string }> {
  override state: { failure?: string } = {};

  static getDerivedStateFromError(error: unknown) {
    return { failure: error instanceof Error ? error.message : String(error) };
  }

  override render() {
    if (this.state.failure === undefined) return this.props.children;
    return <p className="text-accent">this view failed: {this.state.failure}</p>;
  }
}

type BodyProps = {
  match: Match;
  at: number | undefined;
  events: readonly FeedEvent[];
  wall: number;
  link: ViewProps["link"];
  read: ViewProps["read"];
};

function Body({ match, at, events, wall, link, read }: BodyProps) {
  const now = at ?? wall;
  const screen = useMemo(() => screened(events, at), [events, at]);
  const scene = useMemo(() => sceneFrom(screen, now), [screen, now]);
  const { view, params } = match;
  return (
    <section aria-labelledby="view-name">
      <h1 id="view-name" className="mb-4 text-lg font-semibold">
        {view.name}
      </h1>
      {view.Component ? (
        <view.Component scene={scene} params={params} link={link} read={read} />
      ) : (
        <p className="text-ink-secondary">{view.empty}</p>
      )}
    </section>
  );
}

export function Shell(props: ShellProps): ReactElement {
  const { pathname, search, hash, events, wall, feed, read, onTravel } = props;
  const moment = momentOf(search);
  const match = matchView(pathname);
  const link = (path: string) => `${hrefAt(path, moment)}${hash}`;

  const body =
    moment.kind === "invalid" ? (
      <p className="text-accent">not a time: {moment.text}</p>
    ) : !match ? (
      <p className="text-ink-secondary">no such view</p>
    ) : (
      <ViewBoundary key={pathname}>
        <Body
          match={match}
          at={moment.kind === "cut" ? moment.at : undefined}
          events={events}
          wall={wall}
          link={link}
          read={read}
        />
      </ViewBoundary>
    );

  return (
    <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-6 py-5">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-hairline pb-4">
        <div className="flex items-baseline gap-3">
          <span className="font-semibold">Skills dashboard</span>
          <span className="text-sm text-ink-secondary">local only</span>
          <span className="text-sm text-ink-muted" role="status">
            {feedText(feed, events.length)}
          </span>
        </div>
        <TimeTravel moment={moment} onTravel={onTravel} />
      </header>
      {moment.kind === "cut" ? (
        <p className="text-sm">
          Showing the store as of{" "}
          <time className="font-mono tabular-nums">{instantText(moment.at)}</time>
        </p>
      ) : null}
      <div className="flex flex-col gap-6 sm:flex-row">
        <nav aria-label="Views" className="flex flex-wrap gap-1 sm:w-40 sm:flex-col">
          {views.map((view) => (
            <a
              key={view.path}
              href={link(view.path)}
              aria-current={match?.view === view ? "page" : undefined}
              className="rounded px-2 py-1 text-sm text-ink-secondary hover:bg-surface hover:text-ink focus-visible:outline-2 focus-visible:outline-focus aria-[current=page]:bg-surface aria-[current=page]:font-medium aria-[current=page]:text-ink"
            >
              {view.name}
            </a>
          ))}
        </nav>
        <main className="min-w-0 flex-1">{body}</main>
      </div>
    </div>
  );
}
