export function summarize(totals) {
  const keys = Object.keys(totals);

  let sum = 0;
  for (const key of keys) sum += totals[key];
  return { count: keys.length, sum };
}
