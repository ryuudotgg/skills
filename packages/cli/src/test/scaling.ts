export const LINEAR = 4;

const ROUNDS = { least: 2, most: 8 };
const MEASURABLE = 5000;

function cpuTime(run: () => void, repeats: number): number {
  Bun.gc(true);
  const before = process.cpuUsage();
  for (let repeat = 0; repeat < repeats; repeat += 1) run();
  const spent = process.cpuUsage(before);
  return (spent.user + spent.system) / repeats;
}

function measurable(run: () => void): number {
  let repeats = 1;
  while (cpuTime(run, repeats) * repeats < MEASURABLE) repeats *= 2;
  return repeats;
}

export function perUnitSlowdown(
  workload: (size: number) => () => void,
  small: number,
  large: number,
): number {
  const run = { small: workload(small), large: workload(large) };
  const repeats = { small: measurable(run.small), large: measurable(run.large) };
  const best = { small: Infinity, large: Infinity };

  let slowdown = Infinity;
  const undecided = (round: number) => round < ROUNDS.least || slowdown >= LINEAR;
  for (let round = 0; round < ROUNDS.most && undecided(round); round += 1) {
    best.small = Math.min(best.small, cpuTime(run.small, repeats.small));
    best.large = Math.min(best.large, cpuTime(run.large, repeats.large));
    slowdown = best.large / best.small / (large / small);
  }

  return slowdown;
}
