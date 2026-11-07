import vendored from "../../../../third-party/gitleaks/gitleaks.toml";

const lazyPrefix = "[\\w.-]{0,50}?";
const prefixChar = /[\w.-]/u;
const prefixLength = 50;
const curlWindow = 4096;

const curlFlags: Record<string, RegExp> = {
  "curl-auth-header": /[ \t\n\r](?:-H|--header)/gu,
  "curl-auth-user": /[ \t\n\r](?:-u|--user)/gu,
};

type Target = "secret" | "match" | "line";

type Allow = {
  all: boolean;
  target: Target;
  regexes: RegExp[];
  stopwords: string[];
  paths: boolean;
};

export type Rule = {
  id: string;
  regex: RegExp;
  group: number;
  whole: boolean;
  prefixed: boolean;
  flag: RegExp | undefined;
  entropy: number;
  keywords: string[];
  allows: Allow[];
  generic: boolean;
};

export type RuleSet = {
  rules: Rule[];
  global: Allow;
  untranslated: { id: string; reason: string }[];
};

export type Finding = { start: number; end: number; rule: Rule };

type Frame = { flags: string[]; capturing: boolean; named: boolean };

type Translation = { source: string; fragments: boolean };

type RawAllow = {
  condition?: string;
  regexTarget?: string;
  regexes?: string[];
  stopwords?: string[];
  paths?: string[];
};

type RawRule = {
  id: string;
  regex?: string;
  secretGroup?: number;
  entropy?: number;
  keywords?: string[];
  allowlists?: RawAllow[];
};

type RawConfig = { allowlist?: RawAllow; rules?: RawRule[] };

const upstreamFixes: Record<string, string> = {
  "(?i)^true|false|null$": "(?i)^(?:true|false|null)$",
};

const goAnchors: Record<string, string> = { z: "$", A: "^", s: "[\\t\\n\\f\\r ]" };

const goClassEscapes: Record<string, string> = { s: "\\t\\n\\f\\r " };

const posixClasses: Record<string, string> = {
  alnum: "a-zA-Z0-9",
  alpha: "a-zA-Z",
  digit: "0-9",
  lower: "a-z",
  upper: "A-Z",
  xdigit: "0-9A-Fa-f",
  word: "\\w",
  space: "\\t\\n\\v\\f\\r ",
};

function escapeAt(source: string, index: number, inClass: boolean): [string, number] {
  const next = source[index + 1];
  if (next === undefined) throw new Error("trailing backslash");

  const mapped = (inClass ? goClassEscapes : goAnchors)[next];
  if (mapped !== undefined) return [mapped, index + 2];

  if ("QCpP".includes(next) || (next === "x" && source[index + 2] === "{"))
    throw new Error(`\\${next} has no translation`);

  return [source.slice(index, index + 2), index + 2];
}

function classAt(source: string, index: number): [string, number] {
  const out = ["["];

  let cursor = index + 1;
  if (source[cursor] === "^") {
    out.push("^");
    cursor++;
  }

  if (source[cursor] === "]") {
    out.push("\\]");
    cursor++;
  }

  const posix = /\[:(\^?)(\w+):\]/uy;
  while (cursor < source.length) {
    const char = source[cursor]!;
    if (char === "]") return [`${out.join("")}]`, cursor + 1];

    posix.lastIndex = cursor;
    const named = posix.exec(source);
    if (named) {
      const expansion = posixClasses[named[2]!];
      if (named[1] || expansion === undefined) throw new Error(`[:${named[1]}${named[2]}:]`);

      out.push(expansion);
      cursor += named[0].length;
      continue;
    }

    if (char === "\\") {
      const [text, after] = escapeAt(source, cursor, true);
      out.push(text);
      cursor = after;
      continue;
    }

    out.push(char === "[" ? "\\[" : char);
    cursor++;
  }

  throw new Error("unterminated character class");
}

function translateGo(source: string): Translation {
  const out: string[] = [];
  const frames: Frame[] = [{ flags: [], capturing: false, named: false }];
  const setting = /\(\?([a-zA-Z]*(?:-[a-zA-Z]+)?)\)/uy;
  const opener = /\(\?(?:P?<(\w+)>|([a-zA-Z]*(?:-[a-zA-Z]+)?):)/uy;

  let fragments = false;
  let index = 0;

  const closeFlags = () => out.push(")".repeat(frames.at(-1)!.flags.length));
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\\") {
      const [text, after] = escapeAt(source, index, false);
      out.push(text);
      index = after;
      continue;
    }

    if (char === "[") {
      const [text, after] = classAt(source, index);
      out.push(text);
      index = after;
      continue;
    }

    if (char === "|") {
      closeFlags();
      out.push("|", ...frames.at(-1)!.flags);
      index++;
      continue;
    }

    if (char === ")") {
      closeFlags();

      const frame = frames.pop()!;
      if (frames.length === 0) throw new Error("unbalanced parenthesis");

      if (frame.capturing && (frame.named || /[*+?{]/u.test(source[index + 1] ?? "")))
        fragments = true;

      out.push(")");
      index++;
      continue;
    }

    if (char !== "(") {
      out.push(char);
      index++;
      continue;
    }

    setting.lastIndex = index;
    opener.lastIndex = index;

    const set = setting.exec(source);
    const group = set ? null : opener.exec(source);
    const flags = set?.[1] ?? group?.[2] ?? "";
    if (/[^ims-]/u.test(flags)) throw new Error(`flag group (?${flags})`);

    if (set) {
      const scoped = `(?${flags}:`;
      out.push(scoped);
      frames.at(-1)!.flags.push(scoped);
      index += set[0].length;
      continue;
    }

    if (source[index + 1] === "?" && !group)
      throw new Error(`group ${source.slice(index, index + 4)}`);

    const name = group?.[1];
    out.push(name === undefined ? (group?.[0] ?? "(") : `(?<${name}>`);
    frames.push({ flags: [], capturing: !group || name !== undefined, named: name !== undefined });
    index += group?.[0].length ?? 1;
  }

  closeFlags();
  if (frames.length !== 1) throw new Error("unbalanced parenthesis");

  return { source: out.join(""), fragments };
}

export function translate(source: string): string {
  return translateGo(upstreamFixes[source] ?? source).source;
}

function compile(source: string, flags = ""): RegExp {
  return new RegExp(translate(source), flags);
}

function loadAllow(raw: RawAllow): Allow {
  const target = raw.regexTarget ?? "secret";
  if (target !== "secret" && target !== "match" && target !== "line")
    throw new Error(`regexTarget ${target}`);

  return {
    all: raw.condition?.toUpperCase() === "AND",
    target,
    regexes: (raw.regexes ?? []).map((source) => compile(source)),
    stopwords: (raw.stopwords ?? []).map((word) => word.toLowerCase()),
    paths: (raw.paths ?? []).length > 0,
  };
}

function loadRule(raw: RawRule & { regex: string }): Rule {
  const flagged = raw.regex.startsWith("(?i)") ? "(?i)" : "";
  const prefixed = raw.regex.startsWith(lazyPrefix, flagged.length);
  const source = prefixed
    ? flagged + raw.regex.slice(flagged.length + lazyPrefix.length)
    : raw.regex;

  const translation = translateGo(source);
  const flag = curlFlags[raw.id];
  return {
    id: raw.id,
    regex: new RegExp(translation.source, flag ? "dy" : "dg"),
    group: raw.secretGroup ?? 0,
    whole: raw.secretGroup === undefined && translation.fragments,
    prefixed,
    flag,
    entropy: raw.entropy ?? 0,
    keywords: (raw.keywords ?? []).map((word) => word.toLowerCase()),
    allows: (raw.allowlists ?? []).map(loadAllow),
    generic: raw.id.startsWith("generic"),
  };
}

export function loadRules(config: RawConfig): RuleSet {
  const set: RuleSet = {
    rules: [],
    global: { all: false, target: "secret", regexes: [], stopwords: [], paths: false },
    untranslated: [],
  };

  try {
    set.global = loadAllow(config.allowlist ?? {});
  } catch (error) {
    set.untranslated.push({ id: "allowlist", reason: (error as Error).message });
  }

  for (const raw of config.rules ?? []) {
    if (raw.regex === undefined) continue;

    try {
      set.rules.push(loadRule({ ...raw, regex: raw.regex }));
    } catch (error) {
      set.untranslated.push({ id: raw.id, reason: (error as Error).message });
    }
  }

  return set;
}

let loaded: RuleSet | undefined;
export function gitleaks(): RuleSet {
  loaded ??= loadRules(vendored as RawConfig);
  return loaded;
}

export function eligible(set: RuleSet, lower: string): Rule[] {
  return set.rules.filter(
    (rule) => rule.keywords.length === 0 || rule.keywords.some((word) => lower.includes(word)),
  );
}

export function shannon(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);

  const length = Buffer.byteLength(text);

  let entropy = 0;
  for (const count of counts.values()) {
    const share = count / length;
    entropy -= share * Math.log2(share);
  }

  return entropy;
}

function curlBefore(text: string, at: number): number {
  let index = text.lastIndexOf("curl", at);
  while (index >= 0 && at - index <= curlWindow) {
    const bounded = !/\w/u.test(text[index - 1] ?? "") && !/\w/u.test(text[index + 4] ?? "");
    if (bounded) return index;
    index = text.lastIndexOf("curl", index - 1);
  }

  return -1;
}

function* matchesOf(text: string, rule: Rule): Generator<[RegExpExecArray, number]> {
  if (!rule.flag) {
    for (const match of text.matchAll(rule.regex)) yield [match, 0];
    return;
  }

  for (const flag of text.matchAll(rule.flag)) {
    if (curlBefore(text, flag.index) < 0) continue;

    rule.regex.lastIndex = 0;

    const match = rule.regex.exec(`curl${text.slice(flag.index, flag.index + curlWindow)}`);
    if (match) yield [match, flag.index - 4];
  }
}

function lineAround(text: string, start: number, end: number): string {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const to = text.indexOf("\n", end);
  return text.slice(from, to < 0 ? text.length : to);
}

function prefixStart(text: string, start: number): number {
  let cursor = start;
  while (cursor > 0 && start - cursor < prefixLength && prefixChar.test(text[cursor - 1]!))
    cursor--;

  return cursor;
}

function allowed(allow: Allow, targets: Record<Target, string>, secret: string): boolean {
  const checks: boolean[] = [];
  if (allow.regexes.length > 0)
    checks.push(allow.regexes.some((regex) => regex.test(targets[allow.target])));

  if (allow.stopwords.length > 0) {
    const lower = secret.toLowerCase();
    checks.push(allow.stopwords.some((word) => lower.includes(word)));
  }

  if (allow.paths) checks.push(false);

  return allow.all ? checks.length > 0 && checks.every(Boolean) : checks.some(Boolean);
}

function secretOf(match: RegExpExecArray, rule: Rule): [string, number] {
  const indices = match.indices!;
  const pick = (n: number): [string, number] | undefined => {
    const value = match[n];
    const span = indices[n];
    return value && span ? [value, span[0]] : undefined;
  };

  if (rule.group > 0) return pick(rule.group) ?? ["", 0];

  if (!rule.whole)
    for (let n = 1; n < match.length; n++) {
      const found = pick(n);
      if (found) return found;
    }

  return [match[0], match.index];
}

export function findings(text: string, rules: readonly Rule[], set: RuleSet): Finding[] {
  const found: Finding[] = [];
  for (const rule of rules)
    for (const [match, offset] of matchesOf(text, rule)) {
      const [secret, local] = secretOf(match, rule);
      if (secret === "") continue;
      if (rule.entropy > 0 && shannon(secret) <= rule.entropy) continue;

      const start = offset + local;
      const end = offset + match.index + match[0].length;
      const begin = offset + match.index;

      const from = rule.prefixed ? prefixStart(text, begin) : begin;
      const matched = rule.flag ? match[0] : text.slice(from, end);
      const targets = { secret, match: matched, line: lineAround(text, from, end) };
      if (rule.allows.some((allow) => allowed(allow, targets, secret))) continue;
      if (allowed(set.global, targets, secret)) continue;

      found.push({ start, end: start + secret.length, rule });
    }

  return found;
}
