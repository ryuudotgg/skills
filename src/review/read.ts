import type { CommandOutput } from "../round/types.ts";
import { declarations, runReview, type Dependencies } from "./threads.ts";

export const readUsage = "usage: skills review read <pr number>";
export const inlineJq =
  '.[] | "### \\(.path):\\(.line // .original_line // "file") by \\(.user.login)\\n\\(.html_url)\\n\\(.body)\\n"';

function viewRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("cannot read PR body, reviews and comments");

  return value as Record<string, unknown>;
}

function viewText(value: unknown): string {
  if (typeof value !== "string") throw new Error("cannot read PR body, reviews and comments");
  return value;
}

function viewAuthor(value: unknown): string {
  return value === null ? "ghost" : viewText(viewRecord(value).login);
}

function viewSections(source: string): { name: string; text: string }[] {
  try {
    const value = viewRecord(JSON.parse(source));
    const body = viewText(value.body);

    if (!Array.isArray(value.reviews) || !Array.isArray(value.comments))
      throw new Error("cannot read PR body, reviews and comments");

    const reviews = value.reviews
      .map((entry: unknown) => {
        const review = viewRecord(entry);
        const text = viewText(review.body);
        const author = viewAuthor(review.author);
        const state = viewText(review.state);
        return text ? `### review by ${author}, ${state}\n${text}\n\n` : "";
      })
      .join("");

    const comments = value.comments
      .map((entry: unknown) => {
        const comment = viewRecord(entry);
        return `### comment by ${viewAuthor(comment.author)}\n${viewText(comment.url)}\n${viewText(comment.body)}\n\n`;
      })
      .join("");

    return [
      { name: "PR body", text: body },
      { name: "reviews", text: reviews },
      { name: "PR comments", text: comments },
    ].map((section) => ({ ...section, text: section.text.replace(/\n+$/, "") }));
  } catch {
    throw new Error("cannot read PR body, reviews and comments");
  }
}

function outsideBlock(source: string, headings: readonly string[]): string[] {
  let found = false;
  const lines: string[] = [];
  for (const line of `${source}\n`.split("\n").slice(0, -1)) {
    if (/^### (review|comment) by /.test(line)) found = false;
    if (headings.some((heading) => line.toLowerCase().includes(heading))) found = true;
    if (found) lines.push(line);
  }

  return lines;
}

export async function runRead(args: readonly string[], deps: Dependencies): Promise<CommandOutput> {
  return runReview("review-read", readUsage, deps, async (output, context) => {
    const [number] = args;
    if (args.length !== 1 || !number || !/^\d+$/.test(number)) throw new Error(readUsage);

    const headings = declarations(context).flatMap((entry) =>
      entry.outsideDiff === undefined ? [] : [entry.outsideDiff.toLowerCase()],
    );

    const inline = await context.gh(
      ["api", `repos/{owner}/{repo}/pulls/${number}/comments`, "--paginate", "--jq", inlineJq],
      60_000,
    );

    context.stderr?.(inline.stderr);
    if (inline.code !== 0) throw new Error("gh failed reading inline comments");

    const view = await context.gh(
      ["pr", "view", number, "--json", "body,reviews,comments"],
      60_000,
    );

    context.stderr?.(view.stderr);
    if (view.code !== 0) throw new Error("gh failed reading PR body, reviews and comments");

    const sources = [
      { name: "inline comments", text: inline.stdout.replace(/\n+$/, "") },
      ...viewSections(view.stdout),
    ];

    output.stdout = sources
      .map((source) => `== ${source.name}\n${/\S/.test(source.text) ? source.text : "empty"}\n`)
      .join("");

    const outside = sources.slice(1).map((source) => ({
      name: source.name,
      lines: outsideBlock(source.text, headings),
    }));

    const names = outside.filter((source) => source.lines.length).map((source) => source.name);
    output.stdout += "== comments outside diff\n";
    output.stdout += names.length
      ? `found in: ${names.join(", ")}\n${outside.flatMap((source) => source.lines).join("\n")}\n`
      : "empty\n";
  });
}
