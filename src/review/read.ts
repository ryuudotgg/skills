import type { CommandOutput } from "../round/types.ts";
import { declarations, runReview, type Dependencies } from "./threads.ts";

export const readUsage = "usage: skills review read <pr number>";
export const inlineJq =
  '.[] | "### \\(.path):\\(.line // .original_line // "file") by \\(.user.login)\\n\\(.html_url)\\n\\(.body)\\n"';
export const reviewsJq =
  '.reviews[] | select(.body != "") | "### review by \\(.author.login), \\(.state)\\n\\(.body)\\n"';
export const commentsJq =
  '.comments[] | "### comment by \\(.author.login)\\n\\(.url)\\n\\(.body)\\n"';

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

export async function runRead(
  args: readonly string[],
  deps: Dependencies,
): Promise<CommandOutput> {
  return runReview("review-read", readUsage, deps, async (output, context) => {
    const [number] = args;
    if (args.length !== 1 || !number || !/^\d+$/.test(number)) throw new Error(readUsage);

    const headings = declarations(context).flatMap((entry) =>
      entry.outsideDiff === undefined ? [] : [entry.outsideDiff.toLowerCase()],
    );

    const sources: { name: string; text: string }[] = [];
    const reads: [string, string[]][] = [
      [
        "inline comments",
        [
          "api",
          `repos/{owner}/{repo}/pulls/${number}/comments`,
          "--paginate",
          "--jq",
          inlineJq,
        ],
      ],
      ["PR body", ["pr", "view", number, "--json", "body", "--jq", ".body"]],
      ["reviews", ["pr", "view", number, "--json", "reviews", "--jq", reviewsJq]],
      ["PR comments", ["pr", "view", number, "--json", "comments", "--jq", commentsJq]],
    ];

    for (const [name, argv] of reads) {
      const result = await context.gh(argv, 60_000);
      context.stderr?.(result.stderr);
      if (result.code !== 0) throw new Error(`gh failed reading ${name}`);

      sources.push({ name, text: result.stdout.replace(/\n+$/, "") });
    }

    output.stdout = sources
      .map(
        (source) => `== ${source.name}\n${/\S/.test(source.text) ? source.text : "empty"}\n`,
      )
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
