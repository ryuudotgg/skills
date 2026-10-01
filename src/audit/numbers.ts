export function sum(values: Iterable<number>): number {
  let total = 0;
  let compensation = 0;
  for (const value of values) {
    const next = total + value;
    if (Math.abs(total) >= Math.abs(value)) compensation += (total - next) + value;
    else compensation += (value - next) + total;

    total = next;
  }

  if (compensation !== 0 && Number.isFinite(compensation)) total += compensation;

  return total;
}

export function round(value: number): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return value;

  const [whole, fraction = ""] = Math.abs(value).toFixed(100).split(".");
  let cents = BigInt(whole!) * 100n + BigInt(fraction.slice(0, 2));
  const remainder = fraction.slice(2);
  if (remainder[0]! > "5" || (remainder[0] === "5" && (/[1-9]/u.test(remainder.slice(1)) || cents % 2n !== 0n))) cents++;

  const rounded = Number(cents) / 100;
  return value < 0 || Object.is(value, -0) ? -rounded : rounded;
}

export function floatRepr(value: number): string {
  if (Object.is(value, -0)) return "-0.0";

  const magnitude = Math.abs(value);
  const scientific = magnitude !== 0 && (magnitude < 1e-4 || magnitude >= 1e16);
  const text = scientific ? value.toExponential() : String(value);
  if (scientific) return text.replace(/e([+-])(\d+)$/u, (_, sign: string, exponent: string) => `e${sign}${exponent.padStart(2, "0")}`);

  return text.includes(".") ? text : `${text}.0`;
}

export function fixed(value: number): string {
  const rounded = round(value);
  return `${rounded < 0 || Object.is(rounded, -0) ? "-" : ""}${Math.abs(rounded).toFixed(2)}`;
}
