export type DiffLine = { mark: " " | "-" | "+"; text: string };

export type Hunk = {
  before: { start: number; count: number };
  after: { start: number; count: number };
  lines: DiffLine[];
};

const CONTEXT = 3;

function linesOf(text: string): string[] {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

type Snapshot = { low: number; values: Int32Array };

function at(snapshot: Snapshot, diagonal: number): number {
  return snapshot.values[diagonal - snapshot.low]!;
}

function goesDown(snapshot: Snapshot, diagonal: number, depth: number): boolean {
  if (diagonal === -depth) return true;
  return diagonal !== depth && at(snapshot, diagonal - 1) < at(snapshot, diagonal + 1);
}

function trace(before: readonly string[], after: readonly string[]): Snapshot[] {
  const max = before.length + after.length;
  const offset = max + 1;
  const frontier = new Int32Array(2 * max + 3);
  const history: Snapshot[] = [];
  for (let depth = 0; depth <= max; depth++) {
    const snapshot = {
      low: -depth - 1,
      values: frontier.slice(offset - depth - 1, offset + depth + 2),
    };

    history.push(snapshot);

    for (let diagonal = -depth; diagonal <= depth; diagonal += 2) {
      let x = goesDown(snapshot, diagonal, depth)
        ? at(snapshot, diagonal + 1)
        : at(snapshot, diagonal - 1) + 1;

      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) {
        x++;
        y++;
      }

      frontier[offset + diagonal] = x;
      if (x >= before.length && y >= after.length) return history;
    }
  }

  return history;
}

function script(before: readonly string[], after: readonly string[]): DiffLine[] {
  const history = trace(before, after);
  const lines: DiffLine[] = [];

  let x = before.length;
  let y = after.length;
  for (let depth = history.length - 1; depth >= 0; depth--) {
    const snapshot = history[depth]!;
    const diagonal = x - y;
    const down = goesDown(snapshot, diagonal, depth);

    const previous = down ? diagonal + 1 : diagonal - 1;
    const startX = at(snapshot, previous);
    const startY = startX - previous;
    while (x > startX && y > startY) {
      y--;
      lines.push({ mark: " ", text: before[--x]! });
    }

    if (depth === 0) break;

    if (down) lines.push({ mark: "+", text: after[--y]! });
    else lines.push({ mark: "-", text: before[--x]! });
  }

  return lines.reverse();
}

type Start = { before: number; after: number };

function starts(lines: readonly DiffLine[]): Start[] {
  let before = 1;
  let after = 1;
  return lines.map((line) => {
    const start = { before, after };
    if (line.mark !== "+") before++;
    if (line.mark !== "-") after++;
    return start;
  });
}

function hunkOf(lines: readonly DiffLine[], start: Start): Hunk {
  const count = (skipped: DiffLine["mark"]) => lines.filter((line) => line.mark !== skipped).length;
  return {
    before: { start: start.before, count: count("+") },
    after: { start: start.after, count: count("-") },
    lines: [...lines],
  };
}

export function unifiedDiff(beforeText: string, afterText: string): Hunk[] {
  const lines = script(linesOf(beforeText), linesOf(afterText));
  const at = starts(lines);
  const changed = lines.flatMap((line, index) => (line.mark === " " ? [] : [index]));
  const hunks: Hunk[] = [];
  for (let next = 0; next < changed.length; next++) {
    const first = changed[next]!;

    let last = first;
    while (next + 1 < changed.length && changed[next + 1]! - last <= 2 * CONTEXT + 1)
      last = changed[++next]!;

    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(lines.length, last + CONTEXT + 1);
    hunks.push(hunkOf(lines.slice(from, to), at[from]!));
  }

  return hunks;
}

function range({ start, count }: Hunk["before"]): string {
  const shown = count === 0 ? start - 1 : start;
  return count === 1 ? `${shown}` : `${shown},${count}`;
}

export function hunkHeader(hunk: Hunk): string {
  return `@@ -${range(hunk.before)} +${range(hunk.after)} @@`;
}
