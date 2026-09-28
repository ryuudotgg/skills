export interface ReviewerDeclarations {
  readonly checks: readonly string[];
  readonly logins: readonly string[];
  readonly outsideDiffHeadings: readonly string[];
}

let cached: ReviewerDeclarations | undefined;

function readValues(key: string): string[] {
  const result = Bun.spawnSync(["sh", `${import.meta.dir}/../reviewers.sh`, key]);
  if (result.exitCode !== 0)
    throw new Error(result.stderr.toString());

  return result.stdout.toString().split("\n")
    .filter((line) => line.length > 0)
    .map((line) => line.slice(line.indexOf("\t") + 1));
}

export function readReviewerDeclarations(): ReviewerDeclarations {
  if (cached !== undefined)
    return cached;

  cached = {
    checks: readValues("CHECK"),
    logins: readValues("LOGINS").flatMap((value) => value.split(/\s+/)),
    outsideDiffHeadings: readValues("OUTSIDE_DIFF"),
  };
  return cached;
}
