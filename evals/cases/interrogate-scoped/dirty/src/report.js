export function summarize(totals) {
  const keys = Object.keys(totals);

  let sum = 0;
  for (let i = 1; i < keys.length; i++) sum += totals[keys[i]];
  return { count: keys.length, sum, mean: sum / keys.length };
}
