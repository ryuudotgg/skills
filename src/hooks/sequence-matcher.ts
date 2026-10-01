type Match = [number, number, number];
export type Opcode = ["replace" | "delete" | "insert" | "equal", number, number, number, number];

export class SequenceMatcher {
  readonly b2j = new Map<string, number[]>();
  readonly bjunk = new Set<string>();
  private matchingBlocks: Match[] | undefined;
  private opcodes: Opcode[] | undefined;

  constructor(
    readonly first: readonly string[],
    readonly second: readonly string[],
  ) {
    for (const [index, element] of second.entries()) {
      const indices = this.b2j.get(element) ?? [];
      indices.push(index);
      this.b2j.set(element, indices);
    }
  }

  findLongestMatch(alo = 0, ahi = this.first.length, blo = 0, bhi = this.second.length): Match {
    const { first, second, b2j, bjunk } = this;

    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let index = alo; index < ahi; index++) {
      const newj2len = new Map<number, number>();
      for (const other of b2j.get(first[index]!) ?? []) {
        if (other < blo) continue;
        if (other >= bhi) break;

        const size = (j2len.get(other - 1) ?? 0) + 1;
        newj2len.set(other, size);

        if (size > bestsize) {
          besti = index - size + 1;
          bestj = other - size + 1;
          bestsize = size;
        }
      }

      j2len = newj2len;
    }

    while (
      besti > alo &&
      bestj > blo &&
      !bjunk.has(second[bestj - 1]!) &&
      first[besti - 1] === second[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }

    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      !bjunk.has(second[bestj + bestsize]!) &&
      first[besti + bestsize] === second[bestj + bestsize]
    )
      bestsize += 1;

    while (
      besti > alo &&
      bestj > blo &&
      bjunk.has(second[bestj - 1]!) &&
      first[besti - 1] === second[bestj - 1]
    ) {
      besti -= 1;
      bestj -= 1;
      bestsize += 1;
    }

    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      bjunk.has(second[bestj + bestsize]!) &&
      first[besti + bestsize] === second[bestj + bestsize]
    )
      bestsize += 1;

    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks) return this.matchingBlocks;

    const la = this.first.length;
    const lb = this.second.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const matching: Match[] = [];
    while (queue.length) {
      const [alo, ahi, blo, bhi] = queue.pop()!;
      const match = this.findLongestMatch(alo, ahi, blo, bhi);
      const [index, other, size] = match;
      if (size) {
        matching.push(match);
        if (alo < index && blo < other) queue.push([alo, index, blo, other]);
        if (index + size < ahi && other + size < bhi)
          queue.push([index + size, ahi, other + size, bhi]);
      }
    }

    matching.sort((left, right) => left[0] - right[0] || left[1] - right[1] || left[2] - right[2]);

    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const [i2, j2, k2] of matching)
      if (i1 + k1 === i2 && j1 + k1 === j2) k1 += k2;
      else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        [i1, j1, k1] = [i2, j2, k2];
      }

    if (k1) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    this.matchingBlocks = nonAdjacent;

    return nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes) return this.opcodes;

    let index = 0;
    let other = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: Opcode[0] | undefined;
      if (index < ai && other < bj) tag = "replace";
      else if (index < ai) tag = "delete";
      else if (other < bj) tag = "insert";

      if (tag) answer.push([tag, index, ai, other, bj]);
      index = ai + size;
      other = bj + size;
      if (size) answer.push(["equal", ai, index, bj, other]);
    }

    this.opcodes = answer;

    return answer;
  }
}
