import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { compareEvents, parseTime, sceneAt } from "skills-core";
import { FrontierBoard } from "../src/views/frontier.tsx";
import { cut, events, machines, now, row, stored } from "./fixture.ts";
import { text } from "./render.ts";

const HASH = "#token=fixture";

function render(time?: string): string {
  const at = time === undefined ? undefined : parseTime(time);
  const scene = sceneAt(events, at, now);
  return renderToStaticMarkup(
    createElement(FrontierBoard, { scene, link: (path: string) => `${path}${HASH}` }),
  );
}

function project(html: string, name: string): string {
  return (
    new RegExp(`<section data-project="${name}"[^>]*>(.*?)</section>`, "s").exec(html)?.[1] ?? ""
  );
}

function list(html: string, name: string, kind: string): string[] {
  const body =
    new RegExp(`<ol data-list="${kind}"[^>]*>(.*?)</ol>`, "s").exec(project(html, name))?.[1] ?? "";

  return [...body.matchAll(/<li[^>]*>(.*?)<\/li>/gs)].map(([, item = ""]) => text(item));
}

function attributes(html: string, element: string, name: string): string[] {
  return [...html.matchAll(new RegExp(`<${element} ${name}="([^"]*)"`, "g"))].map(
    ([, value = ""]) => value.replace(/&gt;/g, ">"),
  );
}

function node(html: string, key: string): string {
  return new RegExp(`<g data-node="${key}"[^>]*>`).exec(html)?.[0] ?? "";
}

function drawn(html: string, key: string): string {
  return new RegExp(`<g data-node="${key}"[^>]*>(.*?)</g>`, "s").exec(html)?.[1] ?? "";
}

function texts(html: string, key: string): string[] {
  return [...drawn(html, key).matchAll(/<text[^>]*>(.*?)<\/text>/gs)].map(([, item = ""]) =>
    text(item),
  );
}

function title(html: string, key: string): string {
  return text(/<title>(.*?)<\/title>/s.exec(drawn(html, key))?.[1] ?? "");
}

describe("without a time", () => {
  const html = render();

  test("Alpha holds nothing ready, 003 blocked on 002 and Beta#1, 004 in review, 002 doing", () => {
    expect(list(html, "Alpha", "ready")).toEqual([]);
    expect(list(html, "Alpha", "blocked")).toEqual(["003 board P2 waits on 002, Beta#1"]);
    expect(list(html, "Alpha", "review")).toEqual(["004 lint P2 feat/lint"]);
    expect(list(html, "Alpha", "doing")).toEqual(["002 feed P1 feat/feed"]);
    expect(list(html, "Alpha", "inbox")).toEqual([]);
  });

  test("Beta has 001 doing and Beta#1 in its inbox, marked as blocking Alpha 003", () => {
    expect(list(html, "Beta", "ready")).toEqual([]);
    expect(list(html, "Beta", "doing")).toEqual(["001 sync P1 feat/sync"]);
    expect(list(html, "Beta", "inbox")).toEqual(["Beta#1 needs sync API blocks Alpha/003"]);
  });

  test("each plan row links its plan page and keeps the token", () => {
    expect(project(html, "Alpha")).toContain(`href="/plan/Alpha/003${HASH}"`);
    expect(project(html, "Beta")).toContain(`href="/plan/Beta/001${HASH}"`);
  });

  test("the graph holds five open nodes and the two blocker lines, 003 one column right", () => {
    expect(attributes(html, "g", "data-node")).toEqual([
      "Alpha/002",
      "Beta/001",
      "Alpha/003",
      "Alpha/004",
      "Beta#1",
    ]);

    expect(attributes(html, "line", "data-edge")).toEqual([
      "Alpha/002->Alpha/003",
      "Beta#1->Alpha/003",
    ]);

    for (const key of ["Alpha/002", "Alpha/004", "Beta/001", "Beta#1"])
      expect(node(html, key)).toContain('data-column="0"');

    expect(node(html, "Alpha/003")).toContain('data-column="1"');
    expect(html).toContain('aria-label="5 plans and issues, 2 blocker lines"');
  });

  test("a node draws its id or number first and its project with its status below", () => {
    expect(texts(html, "Alpha/003")).toEqual(["003 board", "Alpha TODO"]);
    expect(texts(html, "Beta#1")).toEqual(["#1 needs sync API", "Beta open"]);
    expect(title(html, "Alpha/003")).toBe("003 board, Alpha TODO");
  });

  test("edges use the neutral token and the view holds no colour literal", () => {
    expect(html).toContain("stroke:var(--chart-neutral)");
    expect(html).not.toMatch(/style="[^"]*#/);
  });

  test("lines draw above the nodes, so a line that skips a column stays visible", () => {
    expect(html.indexOf("<line")).toBeGreaterThan(html.lastIndexOf("<g data-node"));
  });

  test("an issue node draws dashed and links nowhere, a plan node links its plan page", () => {
    expect(
      /<g data-node="Beta#1"[^>]*><title>.*?<rect[^>]*stroke-dasharray="4 3"/s.test(html),
    ).toBe(true);

    expect(html).toMatch(
      new RegExp(`<g data-node="Alpha/003"[^>]*><a href="/plan/Alpha/003${HASH}"`),
    );
  });

  test("rendering twice yields identical markup", () => {
    expect(render()).toBe(html);
  });
});

describe("at the cut", () => {
  const html = render(cut);

  test("Alpha holds 004 ready and 003 waiting on 002 alone, Beta holds 001 ready, no inbox", () => {
    expect(list(html, "Alpha", "ready")).toEqual(["004 lint P2 S"]);
    expect(list(html, "Alpha", "blocked")).toEqual(["003 board P2 waits on 002"]);
    expect(list(html, "Beta", "ready")).toEqual(["001 sync P1 L"]);
    expect(list(html, "Alpha", "inbox")).toEqual([]);
    expect(list(html, "Beta", "inbox")).toEqual([]);
  });

  test("the graph holds four nodes, no done 001, and one blocker line", () => {
    expect(attributes(html, "g", "data-node")).toEqual([
      "Alpha/002",
      "Beta/001",
      "Alpha/003",
      "Alpha/004",
    ]);

    expect(attributes(html, "line", "data-edge")).toEqual(["Alpha/002->Alpha/003"]);
  });

  test("rendering twice yields identical markup", () => {
    expect(render(cut)).toBe(html);
  });
});

test("an empty feed renders the empty state", () => {
  const scene = sceneAt([], undefined, now);
  const html = renderToStaticMarkup(createElement(FrontierBoard, { scene, link: (path) => path }));
  expect(text(html)).toBe("no plans");
});

test("a number filed twice shows every title and the renumber command in its inbox line", () => {
  const twice = [
    ...events,
    stored(
      "11-05T09:30",
      "Beta",
      "#1",
      "issue",
      { n: 1, title: "needs sync push", body: null, from: null },
      { from: machines.laptop },
    ),
  ].sort(compareEvents);

  const html = renderToStaticMarkup(
    createElement(FrontierBoard, {
      scene: sceneAt(twice, undefined, now),
      link: (path: string) => `${path}${HASH}`,
    }),
  );

  expect(list(html, "Beta", "inbox")).toEqual([
    "Beta#1 needs sync API | needs sync push blocks Alpha/003 conflict, run skills issues renumber Beta#1",
  ]);
});

function plan(id: string, slug: string) {
  return {
    id,
    slug,
    status: "TODO",
    pri: "P2",
    effort: "S",
    blocked_by: "-",
    ctx: "-",
    branch: "-",
    note: "-",
  };
}

function width(line: string): number {
  return [...line].reduce(
    (sum, character) => sum + ((character.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1),
    0,
  );
}

describe("long project name", () => {
  const studio = "Interaction-design-studio-client-portal";
  const wide = "\uff21".repeat(30);
  const faces = "\u{1f600}".repeat(30);
  const issue = (n: number, title: string) => ({ n, title, body: null, from: null });
  const scene = sceneAt(
    [
      row("11-01T09:00", studio, plan("001", "shell"), { type: "added" }),
      row("11-01T09:01", studio, plan("002", "feed"), { type: "added" }),
      stored("11-05T09:00", "Beta", "#1", "issue", issue(1, wide)),
      stored("11-05T09:01", "Beta", "#2", "issue", issue(2, faces)),
    ].sort(compareEvents),
    undefined,
    now,
  );

  const html = renderToStaticMarkup(
    createElement(FrontierBoard, { scene, link: (path: string) => path }),
  );

  test("each plan shows its id at the start of its first line", () => {
    expect(texts(html, `${studio}/001`)[0]).toStartWith("001 ");
    expect(texts(html, `${studio}/002`)[0]).toStartWith("002 ");
  });

  test("a fullwidth title clips by display width, an emoji title on whole code points", () => {
    const [first = ""] = texts(html, "Beta#1");
    expect(width(first)).toBeLessThanOrEqual(26);
    expect(first).toEndWith("...");

    const [emoji = ""] = texts(html, "Beta#2");
    expect(emoji).toEndWith("...");
    expect(emoji.isWellFormed()).toBe(true);
  });

  test("each title holds the whole label", () => {
    expect(title(html, `${studio}/001`)).toBe(`001 shell, ${studio} TODO`);
    expect(title(html, "Beta#1")).toBe(`#1 ${wide}, Beta open`);
    expect(title(html, "Beta#2")).toBe(`#2 ${faces}, Beta open`);
  });
});
