import { useId, useMemo, type ReactNode } from "react";
import {
  frontiers,
  issueRef,
  type GraphEdge,
  type GraphNode,
  type Issue,
  type IndexRow,
  type ProjectFrontier,
} from "skills-core";
import type { View, ViewProps } from "../view.ts";

const EMPTY = "no plans";

const NODE_WIDTH = 188;

const NODE_HEIGHT = 40;

const COLUMN_PITCH = 236;

const ROW_PITCH = 56;

const MARGIN = 4;

const LABEL_LIMIT = 26;

type Link = ViewProps["link"];

function planHref(link: Link, project: string, id: string): string {
  return link(`/plan/${encodeURIComponent(project)}/${encodeURIComponent(id)}`);
}

function orEmpty(text: string): string {
  return text === "-" ? "" : text;
}

function Name({ project, row, link }: { project: string; row: IndexRow; link: Link }) {
  return (
    <span className="flex items-baseline gap-2">
      <a
        href={planHref(link, project, row.id)}
        className="font-mono underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-focus"
      >
        {row.id}
      </a>
      <span className="font-medium">{row.slug}</span>
    </span>
  );
}

function Detail({ children }: { children: ReactNode }) {
  return <span className="font-mono text-ink-secondary">{children}</span>;
}

type Item = { key: string; row: IndexRow; detail: string[] };

function List({
  name,
  title,
  items,
  project,
  link,
}: {
  name: string;
  title: string;
  items: readonly Item[];
  project: string;
  link: Link;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm text-ink-secondary">
        {title} <span className="tabular-nums">{items.length}</span>
      </h3>
      <ol data-list={name} className="flex flex-col">
        {items.map((item) => (
          <li
            key={item.key}
            data-row={item.row.id}
            className="flex flex-wrap items-baseline gap-x-3 border-b border-hairline py-1 text-sm"
          >
            <Name project={project} row={item.row} link={link} />
            {item.detail
              .filter((text) => text !== "")
              .map((text, index) => (
                <Detail key={index}>{text}</Detail>
              ))}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Inbox({ issues }: { issues: readonly Issue[] }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <h3 className="text-sm text-ink-secondary">
        Inbox <span className="tabular-nums">{issues.length}</span>
      </h3>
      <ol data-list="inbox" className="flex flex-col">
        {issues.map((issue) => (
          <li
            key={issueRef(issue)}
            data-issue={issueRef(issue)}
            className="flex flex-wrap items-baseline gap-x-3 border-b border-hairline py-1 text-sm"
          >
            <span className="flex items-baseline gap-2">
              <span className="font-mono">{issueRef(issue)}</span>
              <span className="font-medium">{issue.title}</span>
            </span>
            {issue.links.map((one) => (
              <Detail key={`${one.kind} ${one.ref}`}>{`${one.kind} ${one.ref}`}</Detail>
            ))}
            {issue.from === null || issue.from === "-" ? null : (
              <Detail>{`from ${issue.from}`}</Detail>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function Project({ entry, link }: { entry: ProjectFrontier; link: Link }) {
  const { project, ready, held, blocked, review, doing, inbox } = entry;
  const heading = useId();
  const branchOf = (id: string) => review.find((row) => row.id === id)?.branch ?? "";
  const readyItems = ready.map(({ row, stacksOn }) => ({
    key: row.id,
    row,
    detail: [
      `${row.pri} ${row.effort}`,
      stacksOn === undefined ? orEmpty(row.note) : `stacks on ${stacksOn} (${branchOf(stacksOn)})`,
    ],
  }));

  const blockedItems = [
    ...held.map(({ row, blockers, twoStacks }) => ({
      key: row.id,
      row,
      detail: [row.pri, `waits on ${blockers.join(", ")}${twoStacks ? " (two stacks)" : ""}`],
    })),
    ...blocked.map((row) => ({
      key: row.id,
      row,
      detail: [row.pri, orEmpty(row.branch), orEmpty(row.note)],
    })),
  ];

  const branched = (rows: readonly IndexRow[]) =>
    rows.map((row) => ({ key: row.id, row, detail: [row.pri, orEmpty(row.branch)] }));

  const lists = [
    { name: "blocked", title: "Blocked", items: blockedItems },
    { name: "review", title: "Review", items: branched(review) },
    { name: "doing", title: "Doing", items: branched(doing) },
  ].filter((list) => list.items.length > 0);

  return (
    <section
      data-project={project}
      aria-labelledby={heading}
      className="flex min-w-0 flex-col gap-3"
    >
      <h2 id={heading} className="text-base font-semibold">
        {project}
      </h2>
      <List name="ready" title="Ready" items={readyItems} project={project} link={link} />
      {lists.map((list) => (
        <List key={list.name} {...list} project={project} link={link} />
      ))}
      {inbox.length > 0 ? <Inbox issues={inbox} /> : null}
    </section>
  );
}

function clipped(text: string): string {
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT - 3)}...` : text;
}

function left(node: GraphNode): number {
  return MARGIN + node.column * COLUMN_PITCH;
}

function top(node: GraphNode): number {
  return MARGIN + node.row * ROW_PITCH;
}

function Node({ node, link }: { node: GraphNode; link: Link }) {
  const x = left(node);
  const y = top(node);
  const body = (
    <>
      <title>{`${node.label}, ${node.status}`}</title>
      <rect
        x={x}
        y={y}
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={4}
        style={{ fill: "var(--surface)", stroke: "var(--chart-neutral)" }}
        strokeDasharray={node.kind === "issue" ? "4 3" : undefined}
      />
      <text x={x + 8} y={y + 16} fontSize={12} style={{ fill: "var(--chart-text)" }}>
        {clipped(node.label)}
      </text>
      <text
        x={x + 8}
        y={y + 32}
        fontSize={11}
        className="font-mono"
        style={{ fill: "var(--chart-text)" }}
      >
        {node.status}
      </text>
    </>
  );

  return (
    <g data-node={node.key} data-status={node.status} data-column={node.column}>
      {node.kind === "plan" ? <a href={planHref(link, node.project, node.id)}>{body}</a> : body}
    </g>
  );
}

function Edge({ edge, at }: { edge: GraphEdge; at: ReadonlyMap<string, GraphNode> }) {
  const from = at.get(edge.from);
  const to = at.get(edge.to);
  if (!from || !to) return null;

  return (
    <line
      data-edge={`${edge.from}->${edge.to}`}
      x1={left(from) + NODE_WIDTH}
      y1={top(from) + NODE_HEIGHT / 2}
      x2={left(to)}
      y2={top(to) + NODE_HEIGHT / 2}
      strokeWidth={1.5}
      style={{ stroke: "var(--chart-neutral)" }}
    />
  );
}

function FrontierGraph({
  nodes,
  edges,
  link,
}: {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  link: Link;
}) {
  const at = new Map(nodes.map((node) => [node.key, node]));
  const columns = Math.max(0, ...nodes.map((node) => node.column)) + 1;
  const rows = Math.max(0, ...nodes.map((node) => node.row)) + 1;
  const width = 2 * MARGIN + (columns - 1) * COLUMN_PITCH + NODE_WIDTH;
  const height = 2 * MARGIN + (rows - 1) * ROW_PITCH + NODE_HEIGHT;
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-sm text-ink-secondary">
        Blockers: each line runs from a blocker to the plan it holds, columns by the longest blocker
        chain below
      </figcaption>
      <div className="overflow-x-auto">
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          aria-label={`${nodes.length} plans and issues, ${edges.length} blocker lines`}
        >
          {nodes.map((node) => (
            <Node key={node.key} node={node} link={link} />
          ))}
          {edges.map((edge) => (
            <Edge key={`${edge.from}->${edge.to}`} edge={edge} at={at} />
          ))}
        </svg>
      </div>
    </figure>
  );
}

export function FrontierBoard({ scene, link }: Pick<ViewProps, "scene" | "link">) {
  const { projects, nodes, edges } = useMemo(() => frontiers(scene.events), [scene.events]);
  if (projects.length === 0) return <p className="text-ink-secondary">{EMPTY}</p>;

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-8 lg:grid-cols-2">
        {projects.map((entry) => (
          <Project key={entry.project} entry={entry} link={link} />
        ))}
      </div>
      <FrontierGraph nodes={nodes} edges={edges} link={link} />
    </div>
  );
}

export const frontier: View = {
  name: "Frontier",
  path: "/frontier",
  empty: EMPTY,
  Component: FrontierBoard,
};
