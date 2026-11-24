import { git } from "./notes.ts";

export function addedNotes(cwd: string, base: string, head: string): string[] {
  const added = git(cwd, [
    "diff",
    "--name-only",
    "-z",
    "--diff-filter=A",
    base,
    head,
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
    console.error("usage: require-note.ts <base> <head> | --pending <commit> | --late <commit>");
    process.exit(2);
  }

  if (base === "--pending") {
    const commit = head;
    const pending = pendingNotes(process.cwd(), commit);
    if (pending.length) {
      console.error(
        [
          "These notes merged to main after the version run, so this version PR leaves them out:",
          ...pending.map((note) => `  ${note}`),
          "The Release workflow runs for each push to main and adds them to this PR. Run it by hand if that run did not.",
        ].join("\n"),
      );

      process.exit(1);
    }

    process.exit(0);
  }

  if (base === "--late") {
    for (const note of pendingNotes(process.cwd(), head))
      console.log(
        `::warning file=${note}::${note} merged after the version PR was cut, so this release ships its change and the next version's changelog lists it`,
      );

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
