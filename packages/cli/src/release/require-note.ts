import { git } from "./notes.ts";

export function addedNotes(cwd: string, base: string, head: string): string[] {
  const added = git(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=A",
    `${base}...${head}`,
    "--",
    ":(glob).tegami/*.md",
  ])
    .split("\0")
    .filter(Boolean);

  return added.filter((note) => /^### /m.test(git(cwd, ["show", `${head}:${note}`])));
}

export function pendingNotes(cwd: string, commit: string): string[] {
  return git(cwd, ["ls-tree", "--name-only", "-z", commit, "--", ".tegami/"])
    .split("\0")
    .filter((path) => /^\.tegami\/[^/]+\.md$/.test(path));
}

if (import.meta.main) {
  const [base, head] = process.argv.slice(2);
  if (!base || !head) {
    console.error("usage: require-note.ts <base> <head> | --pending <commit>");
    process.exit(2);
  }

  if (base === "--pending") {
    const commit = head;
    const pending = pendingNotes(process.cwd(), commit);
    if (pending.length) {
      console.error(
        [
          "These notes were merged after the version run, so no changelog section holds them:",
          ...pending.map((note) => `  ${note}`),
          "Run the Release workflow again to version them. Once the version commit is on main, revert it through a pull request first.",
        ].join("\n"),
      );

      process.exit(1);
    }

    process.exit(0);
  }

  const notes = addedNotes(process.cwd(), base, head);
  if (!notes.length) {
    console.error(
      "This pull request adds no note with a ### heading in .tegami/. Add one as the Releases section of AGENTS.md describes, internal changes included.",
    );

    process.exit(1);
  }

  for (const note of notes) console.log(note);
}
