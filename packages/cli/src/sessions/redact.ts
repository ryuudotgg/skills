import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { eligible, findings, gitleaks, shannon } from "./gitleaks.ts";
import type { Rule, RuleSet } from "./gitleaks.ts";

const minimumSecret = 8;
const marker = /\[redacted:[a-z0-9-]+\]/gu;
const tokenChars = "A-Za-z0-9+/_.-";
const entropyFloor = 3.5;
const entropyWindow = 48;

const userinfo =
  /(?<![a-z0-9+.-])[a-z][a-z0-9+.-]*:\/\/[^\s/?#@:"'`<>]*:([^\s/?#"'`<>]+)@(?=[^\s/?#@"'`<>])/dgiu;

const keyName = new RegExp(
  "(?:(?<![A-Za-z])|(?<=[a-z])(?=[A-Z]))" +
    "(?i:key|token|secret|passw(?:or)?d|pwd|auth|bearer|credential|cookie)[sS]?(?![a-z])",
  "g",
);

const entropyToken = new RegExp(
  `(?<![${tokenChars}])[${tokenChars}]{20,}={0,3}(?![${tokenChars}=])`,
  "g",
);

const wordsOnly = /^[a-z0-9]+(?:[-_.][a-z0-9]+)+$/u;

const entropyExempt = [
  /^[0-9a-f]{7,64}(?:\.{2,3}[0-9a-f]{7,64})?$/iu,
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
  /^sha(?:1|256|384|512)-[A-Za-z0-9+/]+={0,2}$/u,
  wordsOnly,
];

const settingNamePart =
  /^(?:TTL|MS|SECONDS?|URLS?|HOST|PORT|PATH|FILE|DIR|NAME|ID|EXPIRY|EXPIRES|TIMEOUT|LENGTH|SIZE|MAX|MIN|COUNT|ENABLED|DRIVER|REGION|TYPE|MODE)$/u;

const secretNamePart =
  /^(?:API|ACCESS|CLIENT)?(?:KEYS?|TOKENS?|SECRETS?|PASSWORD|PASSWD|PASS|PWD|AUTH|CREDENTIALS?|COOKIE|PRIVATE|SALT|SIGNATURE|DSN|PAT)$/u;

const ranks = { env: 0, rule: 1, generic: 2, "url-userinfo": 3, entropy: 4 } as const;

type Span = { start: number; end: number; label: string; rank: number };

type Scan = { secrets: readonly string[]; set: RuleSet; rules: readonly Rule[] | undefined };

function pathLike(token: string): boolean {
  if (!token.includes("/") || /[+=]/u.test(token)) return false;
  if (/^(?:~|\.{1,2})\//u.test(token) || /\.[A-Za-z0-9]{1,8}$/u.test(token)) return true;
  return token.startsWith("/") && token.split("/").length > 3;
}

function boundary(text: string, start: number, end: number): boolean {
  const alnum = /[A-Za-z0-9]/u;
  if (alnum.test(text[start]!) && alnum.test(text[start - 1] ?? "")) return false;
  return !(alnum.test(text[end - 1]!) && alnum.test(text[end] ?? ""));
}

function envSpans(text: string, secrets: readonly string[]): Span[] {
  const spans: Span[] = [];
  for (const secret of secrets)
    for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1))
      if (boundary(text, at, at + secret.length))
        spans.push({ start: at, end: at + secret.length, label: "env", rank: ranks.env });

  return spans;
}

function ruleSpans(text: string, scan: Scan): Span[] {
  const rules = scan.rules ?? eligible(scan.set, text.toLowerCase());
  return findings(text, rules, scan.set).map(({ start, end, rule }) => ({
    start,
    end,
    label: rule.id,
    rank: rule.generic ? ranks.generic : ranks.rule,
  }));
}

function userinfoSpans(text: string): Span[] {
  const spans: Span[] = [];
  for (const match of text.matchAll(userinfo)) {
    const [start, end] = match.indices![1]!;
    spans.push({ start, end, label: "url-userinfo", rank: ranks["url-userinfo"] });
  }

  return spans;
}

function insideMarker(at: number, held: readonly number[][]): boolean {
  return held.some(([start, end]) => start! <= at && at < end!);
}

function entropySpans(text: string, held: readonly number[][]): Span[] {
  const keyEnds = [...text.matchAll(keyName)]
    .filter((match) => !insideMarker(match.index, held))
    .map((match) => match.index + match[0].length);

  if (keyEnds.length === 0) return [];

  const spans: Span[] = [];

  let latest = -1;
  for (const match of text.matchAll(entropyToken)) {
    const start = match.index;
    while (latest + 1 < keyEnds.length && keyEnds[latest + 1]! <= start) latest++;

    const keyEnd = keyEnds[latest];
    if (keyEnd === undefined || start - keyEnd > entropyWindow) continue;
    if (text.slice(keyEnd, start).includes("\n")) continue;

    const token = match[0];
    if (entropyExempt.some((exempt) => exempt.test(token)) || pathLike(token)) continue;
    if (shannon(token) < entropyFloor) continue;

    spans.push({ start, end: start + token.length, label: "entropy", rank: ranks.entropy });
  }

  return spans;
}

function outsideMarkers(spans: Span[], held: readonly number[][]): Span[] {
  const pieces: Span[] = [];

  let first = 0;
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    while (first < held.length && held[first]![1]! <= span.start) first++;

    let start = span.start;
    for (let index = first; index < held.length && held[index]![0]! < span.end; index++) {
      const [from, to] = held[index]!;
      if (from! > start) pieces.push({ ...span, start, end: from! });
      start = Math.max(start, to!);
    }

    if (start < span.end) pieces.push({ ...span, start });
  }

  return pieces;
}

function merge(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of [...spans].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = merged.at(-1);
    if (!last || span.start >= last.end) {
      merged.push({ ...span });
      continue;
    }

    last.end = Math.max(last.end, span.end);

    if (span.rank < last.rank) {
      last.rank = span.rank;
      last.label = span.label;
    }
  }

  return merged;
}

function replacement(covered: string, label: string): string {
  return covered
    .split(/(\r?\n)/u)
    .map((piece, index) => (index % 2 === 1 ? piece : `[redacted:${label}]`))
    .join("");
}

function redactOnce(context: string, from: number, to: number, scan: Scan): string {
  const held = [...context.matchAll(marker)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);

  const clipped = [
    ...envSpans(context, scan.secrets),
    ...ruleSpans(context, scan),
    ...userinfoSpans(context),
    ...entropySpans(context, held),
  ]
    .map((span) => ({ ...span, start: Math.max(span.start, from), end: Math.min(span.end, to) }))
    .filter((span) => span.start < span.end);

  const found = outsideMarkers(clipped, held).filter((span) =>
    /[A-Za-z0-9]/u.test(context.slice(span.start, span.end)),
  );

  const pieces: string[] = [];

  let copied = from;
  for (const span of merge(found)) {
    pieces.push(context.slice(copied, span.start));
    pieces.push(replacement(context.slice(span.start, span.end), span.label));
    copied = span.end;
  }

  pieces.push(context.slice(copied, to));
  return pieces.join("");
}

function redactText(text: string, prefix: string, suffix: string, scan: Scan): string {
  let current = text;
  while (true) {
    const context = prefix + current + suffix;
    const next = redactOnce(context, prefix.length, prefix.length + current.length, scan);
    if (next === current) return current;

    current = next;
  }
}

function parses(line: string): boolean {
  try {
    JSON.parse(line);
    return true;
  } catch {
    return false;
  }
}

function redactJson(line: string, secrets: readonly string[], set: RuleSet): string {
  const literal = /"(?:[^"\\]|\\.)*"/gu;
  const colon = /\s*:/uy;
  const literals = [...line.matchAll(literal)].map((match) => ({
    match,
    value: JSON.parse(match[0]) as string,
  }));

  const escaped = literals.filter(({ match }) => match[0].includes("\\")).map(({ value }) => value);
  const keywords = [line, ...escaped].join("\n").toLowerCase();
  const scan = { secrets, set, rules: eligible(set, keywords) };
  const pieces: string[] = [];

  let copied = 0;
  let key: { name: string; end: number } | undefined;
  for (const { match, value } of literals) {
    const end = match.index + match[0].length;

    colon.lastIndex = end;
    const isKey = colon.test(line);
    if (isKey) key = { name: value, end };
    if (isKey) continue;

    const keyed = key && /^\s*:\s*$/u.test(line.slice(key.end, match.index)) ? key.name : undefined;

    const prefix = keyed === undefined ? "" : `${JSON.stringify(keyed)}:"`;
    const redacted = redactText(value, prefix, keyed === undefined ? "" : '"', scan);
    if (redacted === value) continue;

    pieces.push(line.slice(copied, match.index), JSON.stringify(redacted));
    copied = end;
  }

  return pieces.length === 0 ? line : pieces.join("") + line.slice(copied);
}

export function redact(text: string, secrets: readonly string[]): string {
  const set = gitleaks();
  const values = [...new Set(secrets)].filter((secret) => secret.length >= minimumSecret);
  const lines = text.split("\n");
  const out: string[] = [];

  let raw: string[] = [];
  const flush = () => {
    if (raw.length > 0)
      out.push(redactText(raw.join("\n"), "", "", { secrets: values, set, rules: undefined }));

    raw = [];
  };

  for (const line of lines) {
    const body = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (!parses(body)) {
      raw.push(line);
      continue;
    }

    flush();
    out.push(redactJson(body, values, set) + line.slice(body.length));
  }

  flush();
  return out.join("\n");
}

function unescape(value: string): string {
  const escapes: Record<string, string> = { n: "\n", r: "\r", t: "\t" };
  return value.replace(/\\(.)/gu, (_, char: string) => escapes[char] ?? char);
}

function envEntry(line: string): [string, string] | undefined {
  const assignment = /^\s*(?:export\s+)?([A-Za-z_][\w.-]*)\s*=(.*)$/u.exec(line);
  if (!assignment) return undefined;

  const rest = assignment[2]!.trim();
  const quoted = /^(["'`])((?:\\.|(?!\1)[^\\])*)\1/u.exec(rest);
  if (!quoted) return [assignment[1]!, rest.replace(/(?:^|\s+)#.*$/u, "")];

  return [assignment[1]!, quoted[1] === '"' ? unescape(quoted[2]!) : quoted[2]!];
}

function secretName(name: string): boolean {
  const parts = name.toUpperCase().split(/[_.-]/u);
  return (
    parts.some((part) => secretNamePart.test(part)) &&
    !parts.some((part) => settingNamePart.test(part))
  );
}

function worthHiding(name: string, value: string): boolean {
  if (value.length < minimumSecret) return false;
  if (secretName(name)) return true;
  if (/^[\d.:]+$/u.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:\/\/[^\s@?#]*$/iu.test(value) || /^[~/.]/u.test(value)) return false;

  return !/^[A-Za-z]+$/u.test(value) && !wordsOnly.test(value);
}

function envFiles(directory: string): string[] {
  try {
    return readdirSync(directory).filter(
      (name) =>
        (name === ".env" || name.startsWith(".env.")) &&
        !/\.(?:example|sample|template)$/u.test(name),
    );
  } catch {
    return [];
  }
}

export function envSecrets(directories: readonly string[]): string[] {
  const values = new Set<string>();
  for (const directory of directories)
    for (const name of envFiles(directory)) {
      let text: string;
      try {
        text = readFileSync(join(directory, name), "utf8");
      } catch {
        continue;
      }

      for (const line of text.split(/\r?\n/u)) {
        const entry = envEntry(line);
        if (entry && worthHiding(...entry)) values.add(entry[1]);
      }
    }

  return [...values];
}
