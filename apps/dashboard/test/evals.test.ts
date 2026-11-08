import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sceneAt, type EvalFilter, type FeedEvent } from "skills-core";
import { Shell } from "../src/shell.tsx";
import { EvalHistory } from "../src/views/evals.tsx";
import { cut, events, now, stored } from "./fixture.ts";

function shell(search: string, feed: readonly FeedEvent[] = events): string {
  return renderToStaticMarkup(
    createElement(Shell, {
      pathname: "/evals",
      search,
      hash: "#token=fixture",
      events: feed,
      wall: now,
      feed: { kind: "live" },
      blob: async () => undefined,
    }),
  );
}

function history(filter: EvalFilter, feed: readonly FeedEvent[] = events): string {
  const scene = sceneAt(feed, undefined, now);
  return renderToStaticMarkup(createElement(EvalHistory, { events: scene.events, filter }));
}

function text(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sections(html: string): { name: string; html: string }[] {
  return [...html.matchAll(/<section data-case="([^"]+)"[^>]*>(.*?)<\/section>/gs)].map(
    ([, name = "", body = ""]) => ({ name, html: body }),
  );
}

function rows(html: string): string[][] {
  const body = /<tbody>(.*?)<\/tbody>/s.exec(html)?.[1] ?? "";
  return [...body.matchAll(/<tr[^>]*>(.*?)<\/tr>/gs)].map(([, row = ""]) =>
    [...row.matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map(([, cell = ""]) => text(cell)),
  );
}

function marks(html: string): string[] {
  return [...html.matchAll(/<li data-result="([a-z]+)"/g)].map(([, result = ""]) => result);
}

test("without a time and no filter the case shows both runs newest first, regressed", () => {
  const found = sections(shell(""));

  expect(found.map((section) => section.name)).toEqual(["plans-new-preflight"]);

  const [only] = found;
  expect(rows(only?.html ?? "")).toEqual([
    [
      "2026-11-05T12:00:00Z",
      "sonnet opus",
      "claude",
      "0",
      "fail regressed",
      "FAIL 2/3",
      "12 min",
      "laptop",
    ],
    ["2026-11-03T14:00:00Z", "opus", "claude codex", "0", "pass", "PASS 3/3", "10 min", "studio"],
  ]);

  expect(text(/<h2[^>]*>(.*?)<\/h2>/s.exec(only?.html ?? "")?.[1] ?? "")).toBe(
    "plans-new-preflight regressed",
  );

  expect(marks(only?.html ?? "")).toEqual(["pass", "fail"]);
});

test("a roster filter keeps the failing run alone, with nothing before it to regress from", () => {
  const html = history({ kind: "roster", roster: "claude" });
  const [only] = sections(html);

  expect(rows(only?.html ?? "").map((row) => row[0])).toEqual(["2026-11-05T12:00:00Z"]);
  expect(html).not.toContain("regressed");
});

test("a model filter that both runs share keeps both and the regression", () => {
  const html = history({ kind: "model", model: "opus" });
  const [only] = sections(html);

  expect(rows(only?.html ?? "")).toHaveLength(2);
  expect(only?.html).toContain("regressed");
});

test("an exit 0 run with no grade reads ungraded and keeps its grade blank", () => {
  const ungraded = stored(
    "11-06T09:00",
    "-",
    "-",
    "eval",
    {
      case: "plans-new-preflight",
      models: ["opus"],
      roster: "claude",
      exit: 0,
      verdict: null,
      grade: null,
      duration: 30_000,
    },
    { from: "0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f" },
  );

  const [only] = sections(history({ kind: "all" }, [...events, ungraded]));
  expect(rows(only?.html ?? "")[0]).toEqual([
    "2026-11-06T09:00:00Z",
    "opus",
    "claude",
    "0",
    "ungraded",
    "-",
    "30 s",
    "0f9e8d7c",
  ]);

  expect(marks(only?.html ?? "")).toEqual(["pass", "fail", "ungraded"]);
});

test("at the cut the route renders no eval runs", () => {
  const html = shell(`?at=${cut}`);
  expect(html).toContain(">no eval runs</p>");
  expect(sections(html)).toEqual([]);
});
