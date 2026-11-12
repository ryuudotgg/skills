import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DIGEST_SECTIONS, digestOf, eventFrom, type FeedEvent } from "skills-core";
import { Shell } from "../src/shell.tsx";
import { blobs, cut, digestMarkdown, events, machines, now, stored } from "./fixture.ts";

function shell(search: string, feed: readonly FeedEvent[] = events): string {
  return renderToStaticMarkup(
    createElement(Shell, {
      pathname: "/digests",
      search,
      hash: "#token=fixture",
      events: feed,
      wall: now,
      feed: { kind: "live" },
      read: async () => ({ status: 404, text: "" }),
    }),
  );
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function digests(html: string): { week: string; html: string }[] {
  return [...html.matchAll(/<section data-week="([^"]+)"[^>]*>(.*?)<\/section>/gs)].map(
    ([, week = "", body = ""]) => ({ week, html: body }),
  );
}

function headings(html: string, level: number): string[] {
  const pattern = new RegExp(`<h${level}[^>]*>(.*?)</h${level}>`, "gs");
  return [...html.matchAll(pattern)].map(([, inner = ""]) => text(inner));
}

function digest(at: string, markdown: string, from: string = machines.studio): FeedEvent {
  return stored(at, "-", "-", "digest", { week: "2026-W45", markdown }, { from });
}

test("without a time the fixture renders its one digest, headed by its week, with the eight sections", () => {
  const found = digests(shell(""));

  expect(found.map((entry) => entry.week)).toEqual(["2026-W45"]);
  expect(headings(found[0]?.html ?? "", 2)).toEqual(["2026-W45"]);
  expect(headings(found[0]?.html ?? "", 3)).toEqual([...DIGEST_SECTIONS]);
  expect(text(found[0]?.html ?? "")).toContain("partial, written 2026-11-06T08:00:00Z on studio");
  expect(text(found[0]?.html ?? "")).toContain("Alpha 001 shell");
});

test("at the cut time there is no digest yet", () => {
  const html = shell(`?at=${cut}`);
  expect(digests(html)).toEqual([]);
  expect(html).toContain("no digests");
});

test("the fold over the store as the digest was written reproduces the stored markdown", () => {
  const written = Date.parse("2026-11-06T08:00:00Z");
  const held = events.filter((event) => event.wall < written).map(eventFrom);
  const landed = (revision: string) =>
    blobs.get(revision)?.split("## Landed\n")[1]?.trim().split("\n")[0];

  expect(digestOf(held, written, landed)).toEqual({ week: "2026-W45", markdown: digestMarkdown });
});

test("a digest written after the week ended replaces the partial one", () => {
  const final = digest("11-09T09:00", "## Closes\n\n- final\n");
  const found = digests(shell("", [...events, final]));

  expect(found).toHaveLength(1);
  expect(text(found[0]?.html ?? "")).toContain("written 2026-11-09T09:00:00Z on studio");
  expect(text(found[0]?.html ?? "")).not.toContain("partial");
  expect(text(found[0]?.html ?? "")).toContain("final");
});

test("of two final digests for one week the first in store order wins", () => {
  const first = digest("11-09T09:00", "## Closes\n\n- from laptop\n", machines.laptop);
  const second = digest("11-09T10:00", "## Closes\n\n- from studio\n");
  const found = digests(shell("", [...events, first, second]));

  expect(found).toHaveLength(1);
  expect(text(found[0]?.html ?? "")).toContain("from laptop");
});
