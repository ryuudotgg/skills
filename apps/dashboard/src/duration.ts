export function durationText(milliseconds: number): string {
  if (milliseconds < 59_500) return `${Math.round(milliseconds / 1000)} s`;

  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;

  const rest = minutes % 60;
  const hours = `${Math.floor(minutes / 60)} h`;
  return rest === 0 ? hours : `${hours} ${rest} min`;
}
