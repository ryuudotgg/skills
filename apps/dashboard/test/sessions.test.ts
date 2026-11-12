import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { machineLabels, sceneAt, sessionList, type FeedEvent } from "skills-core";
import { Shell } from "../src/shell.tsx";
import { readDigest, SessionDetail } from "../src/views/sessions.tsx";
import { blobs, events, now, stored } from "./fixture.ts";

const HASH = "#token=fixture";

const link = (path: string) => `${path}${HASH}`;

const DIGEST_TEXT = [
  "Implement the feed",
  "Feed served on 127.0.0.1",
  "Bash 20, Edit 10",
  "[redacted:env]",
];

function policy(value: "off" | "stats"): FeedEvent {
  return stored("11-06T11:00", "Alpha", "-", "policy", { policy: value });
}

function page(pathname: string, feed: readonly FeedEvent[] = events): string {
  return renderToStaticMarkup(
    createElement(Shell, {
      pathname,
      search: "",
      hash: HASH,
      events: feed,
      wall: now,
      feed: { kind: "live" },
      read: async () => ({ status: 404, text: "" }),
    }),
  );
}

function rows(html: string): { session: string; cells: string[]; plans: string[] }[] {
  const bodies = [...html.matchAll(/<tr data-session="([^"]+)"[^>]*>(.*?)<\/tr>/gs)];
  return bodies.map(([, session = "", inner = ""]) => ({
    session,
    cells: [...inner.matchAll(/<span data-cell="(\w+)"[^>]*>(\d+)<\/span>/g)].map(
      ([, name, value]) => `${name} ${value}`,
    ),
    plans: [...inner.matchAll(/<a href="(\/plan\/[^"#]+)/g)].map(([, href = ""]) => href),
  }));
}

function summaryOf(session: string, feed: readonly FeedEvent[] = events) {
  const scene = sceneAt(feed, undefined, now);
  const found = sessionList(scene.events, scene.sessions).find((each) => each.session === session);
  if (!found) throw new Error(`no session ${session} in the fixture`);
  return { summary: found, labels: machineLabels(scene.events) };
}

test("without a time the list holds s-2 then s-1, both linking Alpha 002", () => {
  const html = page("/sessions");
  const listed = rows(html);

  expect(listed.map((row) => row.session)).toEqual(["s-2", "s-1"]);
  expect(listed.map((row) => row.plans)).toEqual([["/plan/Alpha/002"], ["/plan/Alpha/002"]]);
  expect(listed.map((row) => row.cells)).toEqual([
    ["in 40000", "out 3000", "tools 12"],
    ["in 80000", "out 5000", "tools 30"],
  ]);

  const [second, first] = html.split('<tr data-session="s-1"');
  expect(second).toContain(">sonnet</td>");
  expect(first).toContain(">opus</td>");
  expect(first).toContain(">laptop</td>");
});

test("an off policy for Alpha leaves no trace of Alpha in any view", () => {
  const feed = [...events, policy("off")];
  const routes = ["/sessions", "/board", "/frontier", "/stats", "/plan/Alpha/002", "/digests"];
  for (const route of routes) expect(page(route, feed)).not.toContain("Alpha");
  expect(page("/sessions", feed)).toContain(">no sessions</p>");
});

test("s-1 from laptop shows its pulled digest blob under the redacted policy", async () => {
  const { summary, labels } = summaryOf("s-1");
  const asked: string[] = [];
  const served = async (path: string) => {
    asked.push(path);
    const text = path.startsWith("/blobs/") ? blobs.get(path.slice("/blobs/".length)) : undefined;
    return text === undefined ? { status: 404, text: "not found" } : { status: 200, text };
  };

  const digest = await readDigest(summary, served, true);

  const html = renderToStaticMarkup(
    createElement(SessionDetail, { summary, labels, digest, link }),
  );

  expect(summary.policy).toBe("redacted");
  for (const text of DIGEST_TEXT) expect(html).toContain(text);
  expect(asked).toEqual(["/sessions/s-1/digest", `/blobs/${summary.digest}`]);
});

test("under the stats policy s-1 shows its stats row and no digest text", () => {
  const html = page("/sessions/s-1", [...events, policy("stats")]);

  expect(rows(html).map((row) => row.cells)).toEqual([["in 80000", "out 5000", "tools 30"]]);
  expect(html).toContain("digest not synced under policy stats");
  for (const text of DIGEST_TEXT) expect(html).not.toContain(text);
});

test("s-2 from studio asks this machine for its digest and says so when it answers 404", async () => {
  const { summary, labels } = summaryOf("s-2");
  const asked: string[] = [];
  const digest = await readDigest(
    summary,
    async (path) => {
      asked.push(path);
      return { status: 404, text: "no digest for this session" };
    },
    true,
  );

  const html = renderToStaticMarkup(
    createElement(SessionDetail, { summary, labels, digest, link }),
  );

  expect(asked).toEqual(["/sessions/s-2/digest"]);
  expect(html).toContain("no digest for this session");
});

test("a 403 from this machine names the policy and skips the pulled blob", async () => {
  const { summary } = summaryOf("s-1");
  const asked: string[] = [];
  const digest = await readDigest(
    summary,
    async (path) => {
      asked.push(path);
      return { status: 403, text: "stats\n" };
    },
    true,
  );

  expect(digest).toEqual({ kind: "withheld", policy: "stats" });
  expect(asked).toEqual(["/sessions/s-1/digest"]);
});

test("a digest neither source can serve for a reason other than 404 says why", async () => {
  const { summary } = summaryOf("s-1");
  const digest = await readDigest(
    summary,
    async (path) =>
      path.startsWith("/blobs/")
        ? { status: 404, text: "no such blob" }
        : { status: 503, text: "database is locked\n" },
    true,
  );

  expect(digest).toEqual({ kind: "failed", reason: "database is locked" });
});

test("with a time selected the page reads only the digest synced by then, never this machine", async () => {
  const { summary } = summaryOf("s-1");
  const asked: string[] = [];
  const digest = await readDigest(
    summary,
    async (path) => {
      asked.push(path);
      return { status: 200, text: "Prompt: later work" };
    },
    false,
  );

  expect(asked).toEqual([`/blobs/${summary.digest}`]);
  expect(digest).toEqual({ kind: "shown", text: "Prompt: later work" });
});

test("a session this machine withholds through a local link lists nowhere", () => {
  const html = renderToStaticMarkup(
    createElement(Shell, {
      pathname: "/sessions",
      search: "",
      hash: HASH,
      events,
      wall: now,
      feed: { kind: "live" },
      read: async () => ({ status: 404, text: "" }),
      withheld: ["claude\ts-1"],
    }),
  );

  expect(rows(html).map((row) => row.session)).toEqual(["s-2"]);
});

test("a session the store does not hold says so", () => {
  expect(page("/sessions/s-9")).toContain(">no such session</p>");
});
