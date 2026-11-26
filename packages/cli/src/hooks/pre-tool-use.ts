import { homedir } from "node:os";
import type { Context } from "../registry.ts";
import { read } from "../read.ts";
import type { RuleId } from "./guards.ts";
import type { MessageProblem } from "../publish/commit.ts";
import { recordBlock } from "./blocks.ts";
import { scrubGitEnv } from "./git-env.ts";
import { basename, joinPath, splitlines } from "./text.ts";

const COMMIT_SHAPE =
  'git commit -m "<type>(<scope>): <summary>", one line, 50 characters or fewer, no trailer, also accepted as git -C <dir> commit -m and gh stack add -m';

const COMMENT_SHAPE =
  'gh pr comment <number> --body "<trigger>", the whole body the TRIGGER an active reviewer declares';

const PUSH_SHAPE =
  "git push [-u] [-q] origin <branch>, or git push [-u] [-q] origin refs/heads/<branch>:refs/heads/<branch>, alone, to a local branch other than the default, prs mode only; git -C <dir> push resolves against <dir>";

const OTHER_PUSH_JOB =
  "skills publish pushes and opens a branch or stack layer, and skills fix-round pushes a fix round. skills lease-rebase restacks layers, and skills restack-layer lease pushes a resolved stale layer and restacks the owned layers above it.";

const BOTH_SHAPES = `${COMMIT_SHAPE}; ${COMMENT_SHAPE}`;
const SETTING_REASON =
  "Blocked: git config under skills.* holds the operator's reviewer settings, in any letter case. Read them with skills settings <reviewer>; the operator sets them.";

const UNREADABLE = `Blocked: the payload was unreadable, so commits and PR comments stay blocked. Allowed shapes: ${BOTH_SHAPES}.`;
const PUNCTUATION = new Set(";|&()<>");
const ANSI_C_WORD = /\0*'((?:[^\\']|\\[^])*)(')?/y;
const LOCALE_QUOTE = /\0*"/y;
const ANSI_C_ESCAPE =
  /\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|(C-)|(c[ @`])|([^]))|[^]/g;

const ANSI_C_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
};

const GIT_VALUE_OPTIONS = new Set([
  "-C",
  "-c",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--config-env",
  "--shallow-file",
  "--exec-path",
  "--super-prefix",
  "--attr-source",
]);

const COMMITTING_VERBS: Record<string, { noCommit: string[]; alone: string[]; instead: string }> = {
  "cherry-pick": {
    noCommit: ["-n", "--no-commit"],
    alone: ["--abort", "--quit"],
    instead:
      'run git cherry-pick -n, then git commit -m "<message>", or skills takeover <pr> to carry another author\'s commits from their PR',
  },
  revert: {
    noCommit: ["-n", "--no-commit"],
    alone: ["--abort", "--quit"],
    instead: 'run git revert -n, then git commit -m "<message>"',
  },
  am: {
    noCommit: [],
    alone: [
      "--abort",
      "--quit",
      "--show-current-patch",
      "--show-current-patch=diff",
      "--show-current-patch=raw",
    ],
    instead: "run git apply instead, which leaves the change unstaged for a shaped commit",
  },
  merge: {
    noCommit: ["--ff-only", "--no-commit", "--squash"],
    alone: ["--abort", "--quit"],
    instead: 'run git merge --no-commit, then git commit -m "<message>"',
  },
  pull: {
    noCommit: ["--ff-only"],
    alone: [],
    instead: "run git pull --ff-only",
  },
};

const SHIPPING_VERBS = new Set(["publish", "fix-round"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NESTING = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish", "eval", "ssh", "su"]);

const SEPARATOR = /;|(?<!>)\||(?<![<>])&(?!>)/;
const PIPE = /(?<![>|])\|(?!\|)/;
const GROUP_END = new Set(["}", "done", "fi", "esac"]);
const KEYWORDS = new Set(["{", "}", "!", "do", "done", "then", "else", "fi"]);
const GROUP_START = new Set(["{", "if", "while", "until", "for", "case", "select"]);
const READERS = new Set([
  "rg",
  "grep",
  "egrep",
  "fgrep",
  "head",
  "tail",
  "wc",
  "uniq",
  "cat",
  "cut",
  "tr",
  "echo",
  "printf",
  "which",
  "type",
  "ls",
  "file",
]);

const ENVIRONMENT_CONFIG = /^(GIT_CONFIG_KEY_[0-9]+|GIT_CONFIG_PARAMETERS)(\+?)=(.*)$/s;
const ASSIGNING = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
const ENVIRONMENT_ALIAS = /GIT_CONFIG_(?:KEY_[0-9]+|PARAMETERS)\+?=[^\n;&|]*alias\./i;
const DISTRUST =
  /(?<![\w.=/-])(?:readonly|declare|typeset|local|enable|set|shopt|alias|function)(?![\w.=/-])/;

const XARGS_VALUES = new Set(["a", "d", "E", "I", "J", "L", "n", "P", "R", "S", "s"]);
const XARGS_OPTIONAL = new Set(["e", "i", "l"]);
const XARGS_LONG = [
  "--arg-file",
  "--delimiter",
  "--eof",
  "--exit",
  "--help",
  "--interactive",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--no-run-if-empty",
  "--null",
  "--open-tty",
  "--process-slot-var",
  "--replace",
  "--show-limits",
  "--verbose",
  "--version",
];

const XARGS_LONG_VALUES = new Set([
  "--arg-file",
  "--delimiter",
  "--max-args",
  "--max-chars",
  "--max-procs",
  "--process-slot-var",
]);

const PARALLELS = new Set(["parallel", "env_parallel"]);
const PARALLEL_VALUES = new Set("aBCdDEHIjJLnNPsSUW");
const PARALLEL_LONG_VALUES = new Set(
  `arg-file argfile arg-file-sep argfilesep arg-sep argsep basefile bf basenameextensionreplace
  bner basenamereplace bnr bin block block-size blocksize block-timeout blocktimeout bt col-sep
  colsep combine-exec combine-executable combineexec combineexecutable compress-program
  compressprogram ctag-string ctagstring debug decompress-program decompressprogram delay
  delimiter dirnamereplace dnr env extensionreplace er filter group-by groupby halt
  halt-on-error haltonerror header id jl joblog jobs limit linkinputsource xapplyinputsource load match max-args
  max-chars max-procs max-replace-args maxargs maxchars maxprocs maxreplaceargs memfree
  memsuspend milestone min-version minversion ms nice parens process-slot-var processslotvar
  profile recend recstart res result results retries return rpl rsync-opts rsyncopts
  semaphore-name semaphore-timeout semaphorename semaphoretimeout seqreplace shard
  shell-completion shellcompletion slf slotreplace sql sql-and-worker sql-master sql-worker
  sqlandworker sqlmaster sqlworker ssh ssh-delay sshdelay sshlogin sshloginfile st tag-string
  tagstring template tempdir term-seq termseq tf timeout tmpdir tmpl total total-jobs totaljobs
  transfer-file transfer-files transferfile transferfiles trc trim use-compress-program
  use-decompress-program usecompressprogram usedecompressprogram wd work-dir workdir`
    .split(/\s+/)
    .map((name) => "--" + name),
);

const PARALLEL_LONG = [
  ...PARALLEL_LONG_VALUES,
  ...`bar bg bibtex cat cf citation cleanup color color-fail color-failed colorfail colorfailed
  colour colour-fail colour-failed colourfail colourfailed compress controlmaster csv ctag
  ctrl-c ctrlc dr dry-run dryrun embed eof eta exit fast fg fifo files files0 filter-host
  filter-hosts filterhosts gnu group hashbang help hgrp hostgroup hostgroups hostgrp interactive
  keep-order keeporder latest-line latestline lb line-buffer line-buffered linebuffer
  linebuffered link ll max-line-length-allowed max-lines maxlinelengthallowed maxlines nn
  no-ctrl-c no-ctrlc no-k no-keep-order no-notice no-run-if-empty noctrlc nok nokeeporder
  nonall nonotice norunifempty noswap null number-of-cores number-of-cpus number-of-sockets
  number-of-threads numberofcores numberofcpus numberofsockets numberofthreads onall open-tty
  output-as-files output-as-files0 outputasfiles outputasfiles0 pipe pipe-part pipepart plus
  progress quote record-env recordenv regex regexp remove-rec-sep removerecsep replace resume
  resume-failed resumefailed retry-failed retryfailed round round-robin roundrobin rrs
  semaphore shebang shell-quote shellquote show-limits showlimits shuf silent skip-first-line
  skipfirstline spreadstdin tag tee tmux tmux-pane tmuxpane tollef transfer tty ungroup unsafe
  use-cores-instead-of-threads use-cpus-instead-of-cores use-sockets-instead-of-threads
  usecoresinsteadofthreads usecpusinsteadofcores usesocketsinsteadofthreads verbose version
  wait will-cite willcite xapply xargs`
    .split(/\s+/)
    .map((name) => "--" + name),
];

const SLOT = /^\{(-?\d*)(\/\/|\/\.|\/|\.|#|%)?\}$/;
const SLOTS = /\{-?\d*(?:\/\/|\/\.|\/|\.|#|%)?\}/g;

const JOB_BUDGET = 1024;
const TOO_MANY = "the command builds too many commands to judge";
const JOINERS = new Set([";", "&&", "||", "&"]);
const PRINTERS = new Set(["echo", "printf"]);

const UNSURE = /[$*?[{]/;
const STDIN_PATHS = new Set(["/dev/stdin", "/dev/fd/0"]);

const DECLARING = new Set(["export", "declare", "typeset", "local", "readonly"]);
const LEADING = new Set([...KEYWORDS, ...GROUP_START, "elif", "time"]);

const ENV_SHORT_VALUES = new Set(["u", "C", "S", "P", "a"]);
const ENV_LONG_VALUES = new Set(["--unset", "--chdir", "--split-string", "--argv0"]);
const SHELL_LONG_VALUES = new Set(["--rcfile", "--init-file"]);
const SPECIAL = new Set([
  ":",
  ".",
  "source",
  "eval",
  "exec",
  "export",
  "readonly",
  "set",
  "shift",
  "trap",
  "unset",
  "return",
  "break",
  "continue",
  "exit",
  "times",
]);

const BUILTIN_WRAPPERS = new Set(["command", "builtin"]);
const SCRIPT_RUNNERS = new Set(["bash", "sh", "zsh", "dash", "ksh", "fish"]);
const REDIRECT = /^(?=.*[<>])[<>&|]+$/;

const CONTINUATION = /(?<!\\)((?:\\\\)*)\\\r?\n/g;

const UNSAFE = /[\n\r$`\\]/;
const SPELLED_WORD = /(?:[^ \t\r\n'"]+|'[^']*'|"[^"]*")+/g;

// A typed push's refspec is judged as written: bash and zsh rewrite an unquoted { or #, and zsh
// a leading =, before git sees the word.
const LITERAL_WORD = /^(?!=)(?:'[^']*'|"[^"]*"|[\w@%+=:,./\u0080-￿-])+$/;

// A config key name with any other character may be a substitution or expansion the shell turns
// into alias.<name>, so it counts as one.
const PLAIN_KEY = /^[\w@%+:,./\u0080-￿-]+$/;

export type Result =
  | { kind: "PASS" }
  | { kind: "DENY_SETTING" }
  | { kind: "COMMIT"; message: string; directory: string }
  | { kind: "VERB_COMMIT"; detail: string }
  | { kind: "COMMENT"; detail: string }
  | { kind: "PUSH"; detail: string; directory: string; expandsHome: boolean }
  | { kind: "DENY_COMMIT"; detail: string }
  | { kind: "DENY_COMMENT"; detail: string }
  | { kind: "DENY_PUSH"; detail: string }
  | { kind: "DENY"; detail: string };

type Patterns = {
  setting: RegExp;
  git: RegExp;
  config: RegExp;
  key: RegExp;
  fallback: RegExp;
  unparsed: RegExp;
  push: RegExp;
  rewritten: RegExp;
  digit: RegExp;
};

let asciiPatterns: Patterns | undefined;
let unicodePatterns: Patterns | undefined;
function patterns(raw: string): Patterns {
  const ascii = !/[\u0080-\uffff]/.test(raw);
  const cached = ascii ? asciiPatterns : unicodePatterns;
  if (cached) return cached;

  const word = ascii ? "\\w" : "\\p{L}\\p{N}_";
  const boundary = ascii ? "\\b" : `(?:(?<![${word}])(?=[${word}])|(?<=[${word}])(?![${word}]))`;
  const name = (value: string) => `${boundary}${value}${boundary}`;

  const commit = `${name("git")}[^\\n]*(${boundary}commit|${name("(cherry-pick|revert|am)")})|${name("gh")}[^\\n]*${name("stack")}[^\\n]*${boundary}add`;
  const merging = `${name("git")}[^\\n]*${boundary}(merge|pull)(?![${word}-])`;
  const comment = `${name("gh")}[^\\n]*${name("pr")}[^\\n]*${boundary}comment`;
  const push = `${name("git")}[^\\n]*(${name("(push|send-pack)")}|(-c|--config-env)[\\s=]*[Aa][Ll][Ii][Aa][Ss]\\.)|${name("gh")}[^\\n]*${name("stack")}[^\\n]*${boundary}(push|sync|submit|link)`;
  const rewritten = `${name("git")}[^\\n]*(-c|--config-env)[\\s=]*[^\\s=]*[^\\s=\\w@%+:,./\\u0080-\\uffff-]`;

  const git = ascii ? "git" : "g[i\\u0131\\u0130]t";
  const config = ascii ? "config" : "conf[i\\u0131\\u0130]g";
  const key = `(?<![${word}.-])${ascii ? "skills" : "sk[i\\u0131\\u0130]lls"}\\.${ascii ? "[a-z0-9]" : "[a-z0-9\\u0131\\u0130]"}`;
  const setting = `${name(git)}[^\\n;&|]*${name(config)}[^\\n;&|]*${key}`;
  const caseless = ascii ? "i" : "iu";
  const result = {
    setting: new RegExp(setting, caseless),
    git: new RegExp(`^${git}$`, caseless),
    config: new RegExp(`^${config}$`, caseless),
    key: new RegExp(key, caseless),
    fallback: new RegExp(`${commit}|${comment}|${push}`, ascii ? "" : "u"),
    unparsed: new RegExp(`${commit}|${merging}|${comment}|${push}`, ascii ? "" : "u"),
    push: new RegExp(push, ascii ? "" : "u"),
    rewritten: new RegExp(rewritten, ascii ? "" : "u"),
    digit: /^[0-9]+$/,
  };

  if (ascii) asciiPatterns = result;
  else unicodePatterns = result;

  return result;
}

function joined(raw: string): string {
  return raw.replace(CONTINUATION, (_, pairs: string) => pairs);
}

class ShellsDisagree extends Error {}
class Unjudged extends Error {}

const DESCRIPTOR = "\0";
const DESCRIPTOR_WORD = /^(?:[0-9]+|\{[A-Za-z_][A-Za-z0-9_]*\})$/;
function tokens(
  raw: string,
  newlines = false,
  literal = false,
  decode = !literal,
  descriptors: false | "bash" | "zsh" = false,
): string[] {
  const text = (
    literal ? raw.replace(CONTINUATION, (_, pairs: string) => pairs + "\0") : joined(raw)
  ).replace(/`|\$\(/g, (match) => (literal && match !== "`" ? " ;( " : " ; "));

  const parts: string[] = [];
  let cut = -1;
  const word = (descriptor = false) => {
    if (cut >= 0 && token.length > cut) throw new ShellsDisagree("Shells disagree after a NUL");

    cut = -1;
    parts.push(
      descriptor ? DESCRIPTOR + token : literal && isPunctuation(token) ? "\\" + token : token,
    );
  };

  let token = "";
  let begin = 0;
  let state: "space" | "word" | "punctuation" | "'" | '"' = "space";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\0") continue;

    if (state === "'" || state === '"') {
      if (char === state) state = "word";
      else if (char === "\\" && state === '"') {
        const next = text[++index];
        if (next === undefined) throw new Error("No escaped character");
        token += next === '"' || next === "\\" ? next : "\\" + next;
      } else token += char;

      continue;
    }

    if (state === "punctuation") {
      if (PUNCTUATION.has(char)) {
        token += char;
        continue;
      }

      parts.push(token);
      token = "";
      state = "space";
    }

    if (state === "space") begin = index;
    // Bash runs $"..." as the quoted text when no translation exists, zsh as $ and a quoted word.
    if (decode && char === "$" && localeAt(text, index + 1)) continue;

    const quoted = char === "$" ? ansiCWord(text, index + 1) : null;
    if (literal && state === "space" && char === "#") {
      const end = text.slice(index).search(/[\n\0]/);
      index += (end < 0 ? text.length - index : end) - 1;
    } else if (" \t\r\n".includes(char)) {
      if (state === "word") word();
      if (newlines && char === "\n") parts.push(";");
      token = "";
      state = "space";
    } else if (PUNCTUATION.has(char)) {
      // Only an unquoted number or {name} touching the redirect is its descriptor, so read the raw spelling.
      if (state === "word")
        word(
          descriptors &&
            ("<>".includes(char) ||
              (descriptors === "zsh" && char === "&" && text[index + 1] === ">")) &&
            DESCRIPTOR_WORD.test(text.slice(begin, index).replaceAll("\0", "")),
        );

      token = char;
      state = "punctuation";
    } else if (quoted) {
      if (quoted[2] === undefined) throw new Error("No closing quotation");

      const body = quoted[1]!.replaceAll("\0", "");
      const decoded = decode ? ansiC(body) : "$" + body;
      const nul = decoded.indexOf("\0");
      if (nul >= 0 && cut < 0) cut = token.length + nul;

      token += nul < 0 ? decoded : decoded.slice(0, nul);
      index += quoted[0].length;
      state = "word";
    } else if (char === "'" || char === '"') state = char;
    else if (char === "\\") {
      const next = text[++index];
      if (next === undefined) throw new Error("No escaped character");

      token += next;
      state = "word";
    } else {
      token += char;
      state = "word";
    }
  }

  if (state === "'" || state === '"') throw new Error("No closing quotation");
  if (state === "word") word();
  else if (state === "punctuation") parts.push(token);

  return parts;
}

function localeAt(text: string, at: number): boolean {
  LOCALE_QUOTE.lastIndex = at;
  return LOCALE_QUOTE.test(text);
}

function ansiCWord(text: string, at: number): RegExpExecArray | null {
  ANSI_C_WORD.lastIndex = at;
  return ANSI_C_WORD.exec(text);
}

// Bash and zsh differ on unknown escapes, \c and \C-, so each takes the shell that spells more.
// zsh emits \u and \U as is and keeps a pending \C- for the next character.
function ansiC(body: string): string {
  let decoded = "";
  let control = false;
  for (const match of body.matchAll(ANSI_C_ESCAPE)) {
    if (match[5]) {
      control = true;
      continue;
    }

    const char = ansiCChar(match);
    if (match[3] || match[4]) {
      decoded += char;
      continue;
    }

    decoded += control ? String.fromCharCode(char.charCodeAt(0) & 0x1f) : char;
    control = false;
  }

  return decoded;
}

function ansiCChar([escape, octal, hex, short, long, , empty, other]: RegExpExecArray): string {
  if (octal) return String.fromCharCode(parseInt(octal, 8) & 0xff);
  if (hex) return String.fromCharCode(parseInt(hex, 16));

  const point = short || long;
  if (point)
    return parseInt(point, 16) > 0x10ffff ? escape : String.fromCodePoint(parseInt(point, 16));

  if (empty) return "\0";

  return other === undefined ? escape : (ANSI_C_ESCAPES[other] ?? other);
}

function unquoted(text: string): string {
  return joined(text).replace(/['"\\]/g, "");
}

function isPunctuation(part: string): boolean {
  return Boolean(part) && [...part].every((char) => PUNCTUATION.has(char));
}

function segments(parts: string[]): string[][] {
  const found: string[][] = [[]];
  for (const part of parts)
    if (isPunctuation(part)) found.push([]);
    else found.at(-1)!.push(part);

  return found;
}

function unescaped(text: string): string {
  return text.replace(/\\(?:x([0-9a-fA-F]{1,2})|0?([0-7]{1,3})|[nrtv])/g, (_, hex, octal) =>
    hex
      ? String.fromCharCode(parseInt(hex, 16))
      : octal
        ? String.fromCharCode(parseInt(octal, 8))
        : "\n",
  );
}

function nests(segment: string[]): boolean {
  return segment.some((part) => NESTING.has(basename(part)));
}

function pipeline(parts: string[]): { commands: string[][]; separators: string[] } {
  const commands: string[][] = [[]];
  const separators: string[] = [];
  for (const part of parts)
    if (
      part === ";" &&
      PIPE.test(separators.at(-1) ?? "") &&
      commands.at(-1)!.every((word) => isPunctuation(word) || word === "{")
    )
      continue;
    else if (isPunctuation(part) && SEPARATOR.test(part)) {
      separators.push(part);
      commands.push([]);
    } else commands.at(-1)!.push(part);

  return { commands, separators };
}

// Finding where a piped group or loop starts takes a shell parser, so it reads every command before.
function shellStdin(parts: string[]): string[][] {
  const { commands, separators } = pipeline(parts);

  const piped = (from: number) => {
    const found: string[][] = [];

    let grouped = false;
    for (let index = from - 1; index >= 0 && (grouped || PIPE.test(separators[index]!)); index--) {
      const words = commands[index]!.filter((part) => !isPunctuation(part));
      found.unshift(words);

      grouped ||=
        separators[index]!.includes(")") ||
        commands[index]!.some((part) => isPunctuation(part) && part.includes(")")) ||
        GROUP_END.has(words[0] ?? "");
    }

    return found;
  };

  const openAt = (at: number, shell: number) => {
    const open: { start: number; paren: boolean }[] = [];
    const close = (paren: boolean) => {
      const last = open.findLastIndex((group) => group.paren === paren);
      if (last >= 0) open.splice(last, 1);
    };

    for (let index = 0; index <= at; index++) {
      const tokens = index === at ? commands[index]!.slice(0, shell) : commands[index]!;
      const first = tokens.find((part) => !isPunctuation(part)) ?? "";
      if (GROUP_START.has(first)) open.push({ start: index, paren: false });
      if (GROUP_END.has(first)) close(false);

      for (const token of [separators[index - 1] ?? "", ...tokens].filter(isPunctuation))
        for (const char of token)
          if (char === "(") open.push({ start: index, paren: true });
          else if (char === ")") close(true);
    }

    return open.map((group) => group.start);
  };

  return commands.flatMap((command, at) => {
    const own = command.filter((part) => !isPunctuation(part));
    const name = own.find((word) => !ASSIGNMENT.test(word)) ?? "";
    const reads =
      READERS.has(basename(name)) &&
      !command.some(isPunctuation) &&
      !own.some((word) => word.startsWith("--"));

    if (!nests(command) || reads) return [];

    const shell = command.findIndex((part) => NESTING.has(basename(part)));

    const fed = [...new Set(openAt(at, shell))].filter(
      (start) => start < at && PIPE.test(separators[start - 1] ?? ""),
    );

    const producers = [...fed.flatMap(piped), ...piped(at)];
    if (producers.length === 0) return [own];

    const commands = producers.map((words) =>
      words.slice(words.findIndex((word) => !KEYWORDS.has(word))),
    );

    const output = commands.flatMap((words) => words.slice(1));
    const formats = commands.flatMap((words) => printed(words.slice(runs(words))));

    const words = [...producers.flat(), ...own];
    const texts = [output.join(" "), ...formats].flatMap((text) => [
      text,
      unescaped(text),
      ansiC(text),
    ]);

    return [[...words, ...new Set(texts.filter((text) => !words.includes(text)))]];
  });
}

type Xargs = {
  command: string[];
  file: boolean;
  chars: boolean;
  replace?: string;
  spread?: string;
  size?: { lines: boolean; count: number };
  eof?: string;
  delimiter?: string;
};

const count = (value: string) => (/^[1-9][0-9]*$/.test(value) ? Number(value) : 1);
const replacing = (xargs: Xargs, value: string) => (xargs.replace = value);
const sizing = (xargs: Xargs, lines: boolean, value: string) =>
  (xargs.size = { lines, count: count(value) });

const XARGS_EFFECTS: Record<string, (xargs: Xargs, value: string) => void> = {
  "-a": (xargs) => (xargs.file = true),
  "--arg-file": (xargs) => (xargs.file = true),
  "-E": (xargs, value) => (xargs.eof = value || undefined),
  "-e": (xargs, value) => (xargs.eof = value || undefined),
  "--eof": (xargs, value) => (xargs.eof = value || undefined),
  "-I": replacing,
  "-i": (xargs, value) => replacing(xargs, value || "{}"),
  "--replace": (xargs, value) => replacing(xargs, value || "{}"),
  "-J": (xargs, value) => (xargs.spread = value),
  "-L": (xargs, value) => sizing(xargs, true, value),
  "-l": (xargs, value) => sizing(xargs, true, value || "1"),
  "--max-lines": (xargs, value) => sizing(xargs, true, value || "1"),
  "-n": (xargs, value) => sizing(xargs, false, value),
  "--max-args": (xargs, value) => sizing(xargs, false, value),
  "-d": (xargs, value) => (xargs.delimiter = unescaped(value)),
  "--delimiter": (xargs, value) => (xargs.delimiter = unescaped(value)),
  "-0": (xargs) => (xargs.delimiter = "\0"),
  "--null": (xargs) => (xargs.delimiter = "\0"),
  "-s": (xargs) => (xargs.chars = true),
  "--max-chars": (xargs) => (xargs.chars = true),
};

const WRAPPERS = new Set([...BUILTIN_WRAPPERS, "exec", "nohup"]);
const BODY_ROWS = 3;
function runs(words: string[], start = 0): number {
  let at = start;
  while (at < words.length) {
    const word = words[at]!;
    if (LEADING.has(word) || ASSIGNING.test(word)) at++;
    else if (basename(word) === "env") at = envCommand(words, at, new Map());
    else if (WRAPPERS.has(basename(word))) {
      const values = basename(word) === "exec" ? "a" : "";
      at++;

      while (words[at]?.startsWith("-")) {
        const option = words[at++]!;
        if (option === "--") break;
        if (values && option.indexOf(values, 1) === option.length - 1) at++;
      }
    } else break;
  }

  return at;
}

type Grammar = {
  values: Set<string>;
  optional: Record<string, RegExp | undefined>;
  long: string[];
  longValues: Set<string>;
};

const XARGS_GRAMMAR: Grammar = {
  values: XARGS_VALUES,
  optional: Object.fromEntries([...XARGS_OPTIONAL].map((flag) => ["-" + flag, undefined])),
  long: XARGS_LONG,
  longValues: XARGS_LONG_VALUES,
};

const PARALLEL_GRAMMAR: Grammar = {
  values: PARALLEL_VALUES,
  optional: {
    "-e": /^(?!-)/,
    "-i": /^(?!-)/,
    "-l": /^[\d.]+$/,
    "--eof": /^(?!-)/,
    "--replace": /^(?!-)/,
    "--max-lines": /^[\d.]+$/,
    "--maxlines": /^[\d.]+$/,
  },
  long: PARALLEL_LONG,
  longValues: PARALLEL_LONG_VALUES,
};

function scan(words: string[], grammar: Grammar, apply: (name: string, value: string) => void) {
  let index = 0;
  const operand = () => words[++index] ?? "";
  const optional = (name: string) =>
    grammar.optional[name]?.test(words[index + 1] ?? "") ? operand() : "";

  for (; index < words.length; index++) {
    const word = words[index]!;
    if (word === "--") return index + 1;

    if (word.startsWith("--")) {
      const [spelled = "", value] = word.split(/=(.*)/s);
      const name = grammar.long.includes(spelled)
        ? spelled
        : (grammar.long.find((option) => option.startsWith(spelled)) ?? spelled);

      apply(name, value ?? (grammar.longValues.has(name) ? operand() : optional(name)));
      continue;
    }

    if (!word.startsWith("-") || word === "-") break;

    for (let at = 1; at < word.length; at++) {
      const flag = word[at]!;
      const attached = word.slice(at + 1);
      if (grammar.values.has(flag)) {
        apply("-" + flag, attached || operand());
        break;
      }

      if ("-" + flag in grammar.optional) {
        apply("-" + flag, attached || optional("-" + flag));
        break;
      }

      apply("-" + flag, "");
    }
  }

  return index;
}

function xargsRuns(words: string[]): Xargs | undefined {
  const xargs: Xargs = { command: [], file: false, chars: false };
  const start = scan(words, XARGS_GRAMMAR, (name, value) => XARGS_EFFECTS[name]?.(xargs, value));
  const command = words.slice(runs(words, start));
  const head = basename(command[0] ?? "");
  return xargs.file || (head !== "git" && !PARALLELS.has(head)) ? undefined : { ...xargs, command };
}

function chunks<T>(items: T[], size: number): T[][] {
  const found: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    found.push(items.slice(index, index + size));

  return found;
}

function xargsLines(xargs: Xargs, text: string): string[][][] {
  const spaced = (input: string, eof: string | undefined) => {
    const lines: string[][] = [];
    for (const line of input.split("\n")) {
      const words = line.split(/\s+/).filter(Boolean);
      const end = eof === undefined ? -1 : words.indexOf(eof);
      lines.push(end < 0 ? words : words.slice(0, end));
      if (end >= 0) break;
    }

    return lines;
  };

  if (xargs.delimiter === undefined) return [spaced(text, xargs.eof)];

  const items = text.split(xargs.delimiter);
  return [items.filter(Boolean).map((item) => [item]), spaced(items.join("\n"), undefined)];
}

function xargsBuilds(xargs: Xargs, text: string): string[][] {
  return xargsLines(xargs, text).flatMap((lines) => xargsCalls(xargs, lines));
}

function xargsCalls(xargs: Xargs, lines: string[][]): string[][] {
  const filled = lines.filter((line) => line.length > 0);
  const replaced = xargs.replace
    ? filled.map((line) =>
        xargs.command.map((word) => word.replaceAll(xargs.replace!, line.join(" "))),
      )
    : [];

  if (xargs.replace && !xargs.size) return replaced;

  const groups = !xargs.size
    ? [filled.flat()]
    : xargs.size.lines
      ? chunks(filled, xargs.size.count).map((group) => group.flat())
      : chunks(filled.flat(), xargs.size.count);

  const calls = xargs.chars
    ? groups.flatMap((group) => group.map((_, start) => group.slice(start)))
    : groups;

  return [
    ...replaced,
    ...calls.map((call) => {
      const at = xargs.spread === undefined ? -1 : xargs.command.indexOf(xargs.spread);
      return at < 0
        ? [...xargs.command, ...call]
        : [...xargs.command.slice(0, at), ...call, ...xargs.command.slice(at + 1)];
    }),
  ];
}

function from(words: string[], starts: (word: string) => boolean): string[] {
  const at = words.findIndex(starts);
  return at < 0 ? [] : words.slice(at);
}

function printed(words: string[]): string[] {
  const name = basename(words[0] ?? "");
  const rest = words.slice(1);
  if (name === "echo") return [from(rest, (word) => !/^-[neE]+$/.test(word)).join(" ")];
  if (name !== "printf") return [];

  const format = rest[0] === "--" ? 1 : 0;
  if (!/%/.test((rest[format] ?? "").replaceAll("%%", "")))
    return [rest[format] ?? "", rest.slice(format).join(" ")];

  const args = rest.slice(format + 1);
  return [formatted(rest[format]!, args), args.join(" "), args.join("\n")];
}

function formatted(format: string, args: string[]): string {
  let text = "";
  let next = 0;
  for (;;) {
    const start = next;
    text += format.replace(
      /%(?:%|[-+ #0]*(?:\d+|\*)?(?:\.(\d*|\*))?([a-zA-Z]))/g,
      (directive, precision: string | undefined, conversion: string | undefined) => {
        if (directive === "%%") return "%";

        next += directive.split("*").length - 1;
        const limit = precision === "*" ? (args[next - 1] ?? "") : precision;
        const given = args[next++] ?? "";
        if (conversion === "c") return given.slice(0, 1);

        const arg = conversion === "b" ? unescaped(given) : given;
        return limit && /^\s*\+?\d+$/.test(limit) && "sb".includes(conversion!)
          ? arg.slice(0, Number(limit))
          : arg;
      },
    );

    if (next >= args.length || next === start) return text;
  }
}

function bodies(rows: string[][], command: string[]): string[] {
  const flat = rows.flat();
  const rowOf = rows.flatMap((row, number) => row.map(() => number));
  const typed = subcommandAt(command, 0) >= 0;
  const pending = GIT_VALUE_OPTIONS.has(command.at(-1) ?? "") ? 0 : 1;

  let offset = 0;
  const reaches = rows.map((row) => {
    const subcommand = typed ? -1 : subcommandAt(flat, offset - pending);
    offset += row.length;
    return subcommand < 0 ? rows.length - 1 : rowOf[subcommand]!;
  });

  // A start that reaches the same subcommand as the row before it only drops leading options.
  return rows.flatMap((_, start) => {
    const reach = typed ? start : reaches[start]!;
    if (!typed && start > 0 && reach === reaches[start - 1]) return [];

    return [
      rows
        .slice(start, reach + BODY_ROWS)
        .map((line) => line.join(" "))
        .join("\n"),
    ];
  });
}

function quoted(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

function own(command: string[]): string[] {
  const words = command.flatMap((part, index) => {
    if (
      isPunctuation(part) ||
      part.startsWith(DESCRIPTOR) ||
      REDIRECT.test(command[index - 1] ?? "")
    )
      return [];

    return [part.startsWith("\\") && isPunctuation(part.slice(1)) ? part.slice(1) : part];
  });

  return words.slice(runs(words));
}

function depthOf(parts: string[]): number {
  let depth = 0;
  let leading = true;
  for (const part of parts)
    if (isPunctuation(part)) depth += part.split(")").length - part.split("(").length;
    else if (leading && (part === "{" || part === "}")) depth += part === "}" ? 1 : -1;
    else leading = false;

  return depth;
}

function ending(words: string[]): string {
  if (basename(words[0]!) !== "echo") return "";
  const end = words.findIndex((word, index) => index > 0 && !/^-[neE]+$/.test(word));
  return words.slice(1, end < 0 ? undefined : end).some((flag) => flag.includes("n")) ? "" : "\n";
}

function stdout(command: string[], stderrReturns: boolean): "pipe" | "gone" | "unsure" {
  const redirects = command.flatMap((part, index) => (REDIRECT.test(part) ? [index] : []));
  const writes = redirects.filter((index) => {
    const part = command[index]!;
    const descriptor = command[index - 1]?.startsWith(DESCRIPTOR)
      ? command[index - 1]!.slice(1)
      : undefined;

    return (
      Number(descriptor) === 1 ||
      part.startsWith("&") ||
      (descriptor === undefined && part.includes(">") && !part.startsWith("<"))
    );
  });

  if (writes.length === 0) return "pipe";
  if (redirects.length > 1) return "unsure";

  const part = command[writes[0]!]!;
  const target = command[writes[0]! + 1] ?? "";
  if (part === ">&" && target === "1") return "pipe";
  if (target === "/dev/null" || (part === ">&" && target === "2" && !stderrReturns)) return "gone";

  return "unsure";
}

function piped(commands: string[][], separators: string[], at: number): string[] {
  if (!PIPE.test(separators[at - 1] ?? "")) return [];

  let start = at - 1;
  let depth = depthOf([separators[start]!]) + depthOf(commands[start]!);
  while (depth > 0 && start > 0) {
    depth += depthOf([separators[start - 1]!]);
    if (depth > 0) depth += depthOf(commands[--start]!);
  }

  if (depth > 0) start = at - 1;

  const joiners = separators.slice(start, at - 1).map((joiner) => joiner.replace(/[()]/g, ""));
  if (joiners.some((joiner) => !JOINERS.has(joiner))) return [];

  const returns =
    separators[at - 1]!.includes("|&") || commands[at - 1]!.some((part) => REDIRECT.test(part));

  const members = commands.slice(start, at).flatMap((command, index) => {
    const words = own(command);
    const output = stdout(command, returns);
    return words.length === 0 || output === "gone"
      ? []
      : [{ words, unsure: output === "unsure" || joiners[index - 1] === "||" }];
  });

  if (members.some(({ words }) => !PRINTERS.has(basename(words[0]!)))) return [];

  const texts = (kept: typeof members) => {
    const readings = kept.map(({ words }) =>
      printed(words).map((text) =>
        text.includes("\\c") ? text.slice(0, text.indexOf("\\c")) : text + ending(words),
      ),
    );

    return Array.from({ length: Math.max(0, ...readings.map((found) => found.length)) }, (_, at) =>
      readings.map((found) => found[Math.min(at, found.length - 1)]).join(""),
    );
  };

  return [...texts(members), ...texts(members.filter(({ unsure }) => !unsure))];
}

type Source = string[] | "stdin" | "file";

type Parallel = {
  command: string[];
  sources: Source[];
  slots: Map<string, string>;
  rules: "default" | "plus" | "custom";
  argSep: string;
  fileSep: string;
  columns?: RegExp | "csv";
  delimiter?: string;
  group?: number;
};

const fromFile = (parallel: Parallel, file: string) =>
  parallel.sources.push(file === "-" || STDIN_PATHS.has(file) ? "stdin" : "file");

const literally = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const grouping = (parallel: Parallel, value: string) => (parallel.group = count(value));
const packing = (parallel: Parallel) => (parallel.group = Infinity);
const splitting = (parallel: Parallel, value: string) => {
  try {
    parallel.columns = new RegExp(value);
  } catch {
    parallel.columns = new RegExp(literally(value));
  }
};

const slot = (modifier: string) => (parallel: Parallel, value: string) =>
  value && parallel.slots.set(value, modifier);

const PARALLEL_EFFECTS: Record<string, (parallel: Parallel, value: string) => void> = {
  "-a": fromFile,
  "--arg-file": fromFile,
  "--argfile": fromFile,
  "--arg-sep": (parallel, value) => (parallel.argSep = value),
  "--argsep": (parallel, value) => (parallel.argSep = value),
  "--arg-file-sep": (parallel, value) => (parallel.fileSep = value),
  "--argfilesep": (parallel, value) => (parallel.fileSep = value),
  "-I": slot(""),
  "-i": slot(""),
  "--replace": slot(""),
  "--extensionreplace": slot("."),
  "--er": slot("."),
  "--basenamereplace": slot("/"),
  "--bnr": slot("/"),
  "--dirnamereplace": slot("//"),
  "--dnr": slot("//"),
  "--basenameextensionreplace": slot("/."),
  "--bner": slot("/."),
  "--seqreplace": slot("#"),
  "--slotreplace": slot("%"),
  "--plus": (parallel) => parallel.rules === "default" && (parallel.rules = "plus"),
  "--rpl": (parallel) => (parallel.rules = "custom"),
  "--parens": (parallel) => (parallel.rules = "custom"),
  "--header": (parallel) => (parallel.rules = "custom"),
  "--match": (parallel) => (parallel.rules = "custom"),
  "-0": (parallel) => (parallel.delimiter = "\0"),
  "--null": (parallel) => (parallel.delimiter = "\0"),
  "-d": (parallel, value) => (parallel.delimiter = ansiC(value)),
  "--delimiter": (parallel, value) => (parallel.delimiter = ansiC(value)),
  "-C": splitting,
  "--colsep": splitting,
  "--col-sep": splitting,
  "--csv": (parallel) => (parallel.columns = "csv"),
  "-L": grouping,
  "-l": grouping,
  "-m": packing,
  "-N": grouping,
  "-n": grouping,
  "-X": packing,
  "--max-args": grouping,
  "--max-lines": grouping,
  "--max-replace-args": grouping,
  "--maxargs": grouping,
  "--maxlines": grouping,
  "--maxreplaceargs": grouping,
  "--xargs": packing,
};

const extensionless = (value: string) => value.replace(/\.[^./]*$/, "");
const MODIFIERS: Record<string, (value: string) => string> = {
  ".": extensionless,
  "/": (value) => value.replace(/^.*\//, ""),
  "//": (value) => {
    const path = value.replace(/(.)\/+$/, "$1");
    return path.includes("/") ? path.replace(/\/+[^/]*$/, "") || "/" : ".";
  },
  "/.": (value) => extensionless(value.replace(/^.*\//, "")),
};

function parallelRuns(words: string[]): Parallel {
  const parallel: Parallel = {
    command: [],
    sources: [],
    slots: new Map(),
    rules: "default",
    argSep: ":::",
    fileSep: "::::",
  };

  const start = scan(words, PARALLEL_GRAMMAR, (name, value) =>
    PARALLEL_EFFECTS[name]?.(parallel, value),
  );

  let list: string[] | undefined;
  let files = false;
  for (const word of words.slice(start))
    if (word === parallel.argSep || word === parallel.argSep + "+") {
      list = [];
      files = false;
      parallel.sources.push(list);
    } else if (word === parallel.fileSep || word === parallel.fileSep + "+") files = true;
    else if (files) fromFile(parallel, word);
    else if (list) list.push(word);
    else parallel.command.push(word);

  if (parallel.sources.length === 0) parallel.sources.push("stdin");
  return parallel;
}

function product(sources: string[][]): string[][] {
  return sources.reduce<string[][]>(
    (tuples, source) => tuples.flatMap((tuple) => source.map((input) => [...tuple, input])),
    [[]],
  );
}

function csvFields(input: string): string[] {
  const fields = [""];

  let inside = false;
  for (const char of input)
    if (char === '"') inside = !inside;
    else if (char === "," && !inside) fields.push("");
    else fields[fields.length - 1] += char;

  return fields;
}

function records(text: string, delimiter: string | undefined): string[] {
  const found = text.split("\n").flatMap((line) => (delimiter ? line.split(delimiter) : [line]));
  return found.at(-1) === "" ? found.slice(0, -1) : found;
}

// Inputs reach the command quoted, so a job that only mentions git stays a mention.
function parallelJobs(parallel: Parallel, texts: string[], budget: Budget): string[] {
  const line = parallel.command.join(" ");
  if (
    parallel.rules === "custom" ||
    line.includes("{=") ||
    /\{-?\d*:/.test(line) ||
    (parallel.rules === "plus" &&
      [...line.matchAll(/\{[^{}]*\}/g)].some(([found]) => !SLOT.test(found)))
  )
    throw new Unjudged("parallel replacement string could not be read");

  const custom = [...parallel.slots.keys()].map(literally);
  const pattern = new RegExp([...custom, SLOTS.source].join("|"), "g");
  const bare = new RegExp(pattern.source).test((parallel.command[0] ?? "").split(/[\s=]/)[0]!);
  const job = (tuple: string[]) => {
    if (parallel.command.length === 0) return tuple.join(" ");

    let replaced = false;
    const text = line.replace(pattern, (found) => {
      replaced = true;

      const [, position = "", modifier = ""] = SLOT.exec(found) ?? [];
      const change = MODIFIERS[parallel.slots.get(found) ?? modifier] ?? ((value: string) => value);

      const at = Number(position);
      const values = at > 0 ? [tuple[at - 1] ?? ""] : at < 0 ? [tuple.at(at) ?? ""] : tuple;
      return values.map((value) => (bare ? change(value) : quoted(change(value)))).join(" ");
    });

    return replaced ? text : [line, ...tuple.map(quoted)].join(" ");
  };

  const columns = (tuple: string[]) =>
    parallel.columns === undefined
      ? tuple
      : tuple.flatMap((input) =>
          (parallel.columns === "csv" ? csvFields(input) : input.split(parallel.columns!)).map(
            (field) => field.trim(),
          ),
        );

  const readings = parallel.sources.includes("stdin") && texts.length > 0 ? texts : [undefined];
  return readings.flatMap((text) => {
    const sources = parallel.sources.map((source) => {
      const inputs =
        source === "file" || (source === "stdin" && text === undefined)
          ? []
          : source === "stdin"
            ? records(text!, parallel.delimiter)
            : source;

      return inputs.length === 0 ? [""] : inputs.map((input) => input.trim());
    });

    const size = sources.reduce((total, source) => total * source.length, 1);
    if (size * (parallel.group ? sources.length + 1 : 1) > JOB_BUDGET) throw new Unjudged(TOO_MANY);

    const tuples = product(sources);
    const flat = parallel.group ? tuples.flat() : [];
    const groups =
      parallel.group === Infinity
        ? flat.map((_, from) => flat.slice(from))
        : chunks(flat, (parallel.group ?? 1) * sources.length);

    const jobs = [...tuples, ...groups]
      .map(columns)
      .map(job)
      .filter((built) => !budget.seen.has(built));

    for (const built of jobs) budget.seen.add(built);

    if (budget.seen.size > JOB_BUDGET) throw new Unjudged(TOO_MANY);
    return jobs;
  });
}

type Budget = { seen: Set<string> };

function relayed(parts: string[], budget: Budget): string[] {
  const { commands, separators } = pipeline(parts);
  return commands.flatMap((command, at) => {
    const words = own(command);
    const name = basename(words[0] ?? "");
    const stdin = (runner: string[]) => {
      const rows = commands.slice(at + 1).filter((row) => row.length > 0);
      const input = [
        ...piped(commands, separators, at),
        ...command.flatMap((part, index) => (part === "<<<" ? [command[index + 1] ?? ""] : [])),
        ...(command.includes("<<") ? bodies(rows, runner) : []),
      ];

      return [...new Set(input.flatMap((text) => [text, unescaped(text)]))];
    };

    if (name === "xargs") {
      const xargs = xargsRuns(words.slice(1));
      if (!xargs) return [];

      return stdin(xargs.command)
        .flatMap((text) => xargsBuilds(xargs, text))
        .map((build) => build.map(quoted).join(" "));
    }

    if (!PARALLELS.has(name)) return [];

    const parallel = parallelRuns(words.slice(1));
    return parallelJobs(parallel, stdin(parallel.command), budget);
  });
}

function subcommandAt(parts: string[], start: number): number {
  for (let index = start + 1; index < parts.length; index++) {
    const part = parts[index]!;
    if (GIT_VALUE_OPTIONS.has(part)) index++;
    else if (!part.startsWith("-")) return index;
  }

  return -1;
}

function gitSubcommand(parts: string[], start: number): string {
  return parts[subcommandAt(parts, start)] ?? "";
}

function committingVerb(parts: string[], start: number, exempts: boolean): string | undefined {
  const at = subcommandAt(parts, start);
  const verb = parts[at] ?? "";
  const rule = Object.hasOwn(COMMITTING_VERBS, verb) ? COMMITTING_VERBS[verb] : undefined;
  if (!rule) return undefined;

  const rest = parts.slice(at + 1);
  if (!exempts || !rest.every((part) => LITERAL_WORD.test(part))) return verb;
  if (rest.length === 1 && rule.alone.includes(rest[0]!)) return undefined;

  return rule.noCommit.includes(rest[0]!) && !rest.slice(1).some((part) => part.startsWith("--"))
    ? undefined
    : verb;
}

function namesCommittingVerb(text: string): boolean {
  let words: string[];
  try {
    // Literal tokens keep the $ of ANSI-C quoting, so printf $'git merge x' | sh reads as $git.
    words = tokens(text).map((word) => word.replace(/^\$/, ""));
  } catch {
    return false;
  }

  return words.some(
    (word, index) => basename(word) === "git" && committingVerb(words, index, false) !== undefined,
  );
}

function inOrder(parts: string[], first: string, second: string): boolean {
  return parts.includes(first) && parts.slice(parts.indexOf(first) + 1).includes(second);
}

function hasStackMessage(parts: string[]): boolean {
  return parts.some(
    (part) =>
      part.startsWith("-m") ||
      part === "--message" ||
      part.startsWith("--message=") ||
      /^-[A-Za-z]*m$/.test(part),
  );
}

function definesAlias(segment: string[], start: number): boolean {
  const verb = subcommandAt(segment, start);
  const words = segment.slice(start + 1);
  return words.some((word, index) => {
    const separate = word === "-c" || word === "--config-env";
    const key = separate ? words[index + 1] : /^(?:-c|--config-env=)(.*)$/s.exec(word)?.[1];
    const global = verb < 0 || start + 1 + index < verb;
    if (key === undefined) return separate && global;

    const name = key.split("=", 1)[0]!;
    return name.toLowerCase().startsWith("alias.") || (global && !PLAIN_KEY.test(name));
  });
}

function parameterKeys(value: string): string[] | undefined {
  let index = 0;
  const quoted = (): string | undefined => {
    if (value[index] !== "'") return undefined;

    let text = "";
    for (index++; index < value.length; index++)
      if (value[index] !== "'") text += value[index];
      else if (value[index + 1] === "\\" && value[index + 3] === "'") {
        text += value[index + 2];
        index += 3;
      } else {
        index++;
        return text;
      }

    return undefined;
  };

  const keys: string[] = [];
  for (;;) {
    while (/\s/.test(value[index] ?? "")) index++;
    if (index >= value.length) return keys;

    const entry = quoted();
    if (entry === undefined) return undefined;

    if (value[index] !== "=") keys.push(entry.split("=", 1)[0]!);
    else {
      keys.push(entry);
      index++;
      if (value[index] === "'" && quoted() === undefined) return undefined;
    }
  }
}

function namesAlias(key: string): boolean {
  return key.toLowerCase().startsWith("alias.") || !PLAIN_KEY.test(key);
}

function aliasAssignment(word: string): [string, boolean] | undefined {
  const match = ENVIRONMENT_CONFIG.exec(word.replace(/^\$/, ""));
  if (!match)
    return ASSIGNING.test(word) && ENVIRONMENT_ALIAS.test(word)
      ? [word.split(/\+?=/, 1)[0]!, true]
      : undefined;

  const [, name, append, value] = match as unknown as [string, string, string, string];
  if (append) return value === "" ? undefined : [name, true];
  if (value === "") return [name, false];
  if (name !== "GIT_CONFIG_PARAMETERS") return [name, namesAlias(value)];

  const keys = value.includes("$") ? undefined : parameterKeys(value);
  return [name, keys ? keys.some(namesAlias) : true];
}

function aliased(aliases: Map<string, boolean>): boolean {
  return [...aliases.values()].includes(true);
}

function splitString(value: string): string[] {
  const text = value.replace(/\\c[\s\S]*$/, "").replace(/\\_/g, " ");
  try {
    return tokens(text);
  } catch {
    return [text];
  }
}

function envCommand(words: string[], start: number, aliases: Map<string, boolean>): number {
  const apply = (flag: string, value: string, at: number) => {
    if (flag === "u" || flag === "--unset") aliases.delete(value);
    if (flag === "S" || flag === "--split-string") words.splice(at + 1, 0, ...splitString(value));
  };

  let options = true;
  let index = start + 1;
  for (; index < words.length; index++) {
    const word = words[index]!;
    const assigned = aliasAssignment(word);
    if (options && word === "--") options = false;
    else if (options && (word === "-" || word === "--ignore-environment")) aliases.clear();
    else if (options && word.startsWith("--")) {
      const equals = word.indexOf("=");
      const flag = equals < 0 ? word : word.slice(0, equals);
      const value =
        equals >= 0
          ? word.slice(equals + 1)
          : ENV_LONG_VALUES.has(flag)
            ? (words[++index] ?? "")
            : "";

      apply(flag, value, index);
    } else if (options && /^-./.test(word))
      for (let at = 1; at < word.length; at++) {
        const flag = word[at]!;
        if (flag === "i") aliases.clear();
        if (!ENV_SHORT_VALUES.has(flag)) continue;

        const value = at + 1 < word.length ? word.slice(at + 1) : (words[++index] ?? "");
        apply(flag, value, index);
        break;
      }
    else if (assigned) aliases.set(...assigned);
    else if (!ASSIGNING.test(word)) break;
  }

  return index;
}

function shellInput(rest: string[]): { script: boolean; stdin: boolean; operand: number } {
  let script = false;
  let stdin = false;
  let index = 0;
  for (; index < rest.length; index++) {
    const word = rest[index]!;
    if (word === "--" || word === "-") {
      index++;
      break;
    }

    if (word.startsWith("--")) {
      if (SHELL_LONG_VALUES.has(word)) index++;
      continue;
    }

    if (!/^[-+]./.test(word)) break;

    for (const flag of word.slice(1))
      if (flag === "c") script = true;
      else if (flag === "s") stdin = true;
      else if (flag === "o" || flag === "O") index++;
  }

  const standard = index >= rest.length || STDIN_PATHS.has(rest[index]!);
  return { script, stdin: stdin || (!script && standard), operand: index };
}

type Walk = { raw: string; aliases: Map<string, boolean>; frozen: boolean };

function reachesGit(command: string[], local: Map<string, boolean>, walk: Walk): boolean {
  const words = [...command];

  let executable = 0;
  for (let index = 0; index < words.length;) {
    const name = basename(words[index]!);
    if (name === "env") executable = index = envCommand(words, index, local);
    else if ((name === "git" || UNSURE.test(name)) && aliased(local)) return true;
    else if (READERS.has(name) && index === executable) return false;
    else if (NESTING.has(name)) {
      const rest = words.slice(index + 1);
      const input = SCRIPT_RUNNERS.has(name) ? shellInput(rest) : undefined;
      if (input?.stdin && !input.script)
        return aliased(local) || /GIT_CONFIG/i.test(unescaped(walk.raw));

      const text = input?.script ? (rest[input.operand] ?? "") : rest.join(" ");
      const nested = walkAliases(text, local, walk.frozen);
      for (const [key, value] of nested.aliases) if (value) walk.aliases.set(key, true);

      return nested.reached.length > 0;
    } else index++;
  }

  return false;
}

function isOption(word: string): boolean {
  return /^[-+]./.test(word);
}

function environmentAliases(raw: string): string[][] {
  return walkAliases(raw, new Map(), false).reached;
}

// Only a clear in a flat ;-separated run counts: a subshell, pipe or condition may never run it.
function walkAliases(
  raw: string,
  inherited: Map<string, boolean>,
  frozen: boolean,
): { reached: string[][]; aliases: Map<string, boolean> } {
  const text = inlined(joined(raw), 0, "", true)[0];
  const walk: Walk = {
    raw,
    aliases: new Map(inherited),
    frozen: frozen || UNSURE.test(raw),
  };

  const reached: string[][] = [];

  let settled = !/`|\$\(|<<(?!<)/.test(raw);
  let parts: string[];
  try {
    parts = tokens(text, true, true);
  } catch {
    try {
      parts = tokens(text, true);
      settled = false;
    } catch {
      const found =
        (aliased(inherited) || ENVIRONMENT_ALIAS.test(unquoted(raw))) && /\bgit\b/.test(raw);

      return { reached: found ? [[]] : [], aliases: walk.aliases };
    }
  }

  walk.frozen ||= parts.some((part) => DISTRUST.test(part));
  settled &&= !walk.frozen;

  let words: string[] = [];
  let target = false;
  let redirected = false;
  for (let index = 0; index <= parts.length; index++) {
    const part = parts[index];
    if (part !== undefined && REDIRECT.test(part)) {
      if (/^[0-9]+$/.test(words.at(-1) ?? "")) words.pop();
      target = true;
      redirected = true;
      continue;
    }

    if (part !== undefined && !isPunctuation(part)) {
      if (target) target = false;
      else words.push(part);

      continue;
    }

    target = false;

    let at = 0;
    while (at < words.length && LEADING.has(words[at]!)) at++;
    if (at > 0) settled = false;

    const clears =
      settled && !redirected && (part === undefined || [";", "&&", "||"].includes(part));

    const first = at;
    while (at < words.length && ASSIGNING.test(words[at]!)) at++;

    let builtin = at;
    let lookup = false;
    while (BUILTIN_WRAPPERS.has(words[builtin] ?? "")) {
      builtin++;

      for (; words[builtin]?.startsWith("-"); builtin++) {
        if (words[builtin] === "--") {
          builtin++;
          break;
        }

        lookup ||= /[vV]/.test(words[builtin]!);
      }
    }

    const name = lookup ? "" : (words[builtin] ?? "");
    const prefix = words.slice(first, at);
    const operands = words.slice(builtin + 1);
    const declaring = DECLARING.has(name);
    const direct = clears && builtin === at;
    const clearing =
      direct && (at === words.length || (name === "export" && !operands.some(isOption)));

    const shared = declaring
      ? [...prefix, ...operands]
      : at === words.length || SPECIAL.has(name)
        ? prefix
        : [];

    for (const assigned of shared.map(aliasAssignment))
      if (assigned && (assigned[1] || clearing)) walk.aliases.set(...assigned);

    if (
      name === "unset" &&
      direct &&
      operands.every((word) => !isOption(word) || word === "-v" || word === "--")
    )
      for (const word of operands) walk.aliases.delete(word);

    if (at < words.length && !declaring && !lookup && name !== "unset") {
      const local = new Map(walk.aliases);
      for (const assigned of prefix.map(aliasAssignment))
        if (assigned && (assigned[1] || !walk.frozen)) local.set(...assigned);

      if (reachesGit(words.slice(at), local, walk)) reached.push(words);
    }

    settled &&= part === ";";
    words = [];
    redirected = false;
  }

  return { reached, aliases: walk.aliases };
}

function pushes(segment: string[]): boolean {
  for (const [index, part] of segment.entries()) {
    const name = basename(part);
    const rest = name === "git" || name === "gh" ? segment.slice(index + 1) : [];

    if (name === "git" && ["push", "send-pack"].includes(gitSubcommand(segment, index)))
      return true;

    if (["git-push", "git-send-pack"].includes(name)) return true;
    if (name === "git" && definesAlias(segment, index)) return true;

    if (
      name === "gh" &&
      ["push", "sync", "submit", "link"].some((action) => inOrder(rest, "stack", action))
    )
      return true;
  }

  return false;
}

function namesSetting(raw: string): boolean {
  const text = joined(raw);
  const mentionsConfig =
    text.toLowerCase().includes("config") ||
    ((text.includes("\u0131") || text.includes("\u0130")) && /conf[i\u0131\u0130]g/i.test(text));

  const { setting } = patterns(raw);
  return mentionsConfig && (setting.test(text) || setting.test(raw));
}

function configAt(segment: string[], expressions: Patterns): number {
  const git = segment.findIndex((part) => expressions.git.test(basename(part)));
  if (git < 0) return -1;
  return segment.findIndex((part, index) => index > git && expressions.config.test(part));
}

function inlined(text: string, start = 0, close = "", separate = false): [string, number] {
  let output = "";
  let quote = "";
  let depth = 0;
  for (let index = start; index < text.length; index++) {
    const char = text[index]!;
    if (quote === "'") {
      output += char;
      if (char === "'") quote = "";
      continue;
    }

    if (char === "\\") {
      output += char + (text[++index] ?? "");
      continue;
    }

    if (!quote && char === close && depth === 0) return [output, index];

    const dollar = char === "$" && text[index + 1] === "(";
    if (dollar || char === "`") {
      const [body, end] = inlined(text, index + (dollar ? 2 : 1), dollar ? ")" : "`", separate);
      const spaced = separate ? ` ;( ${body} ) ` : ` ${body} `;
      output += quote ? `"${spaced}"` : spaced;
      index = end;
      continue;
    }

    if (!quote && char === "(") depth++;
    if (!quote && char === ")") depth--;
    if (char === '"') quote = quote ? "" : '"';
    else if (char === "'" && !quote) quote = "'";

    output += char;
  }

  return [output, text.length];
}

function setsSkills(raw: string): boolean {
  const expressions = patterns(raw);

  let parts: string[];
  try {
    parts = tokens(inlined(joined(raw))[0], true);
  } catch {
    return namesSetting(raw);
  }

  const commands: string[][] = [[]];
  for (const part of parts)
    if (!isPunctuation(part)) commands.at(-1)!.push(part);
    else if (SEPARATOR.test(part)) commands.push([]);

  if (
    commands.some((command) => {
      const config = configAt(command, expressions);
      return config >= 0 && command.slice(config + 1).some((part) => expressions.key.test(part));
    })
  )
    return true;

  if (
    shellStdin(tokens(inlined(joined(raw))[0], true, true)).some((read) =>
      namesSetting(read.join(" ")),
    )
  )
    return true;

  return (
    (/\$'|<<|#[^\n]*\\\r?\n/.test(raw) ||
      commands.some((command) =>
        command.some(
          (part, index) =>
            part.includes("$") &&
            command.slice(index + 1).some((word) => expressions.config.test(word)),
        ),
      )) &&
    namesSetting(raw)
  );
}

function pushRefspecs(segment: string[]): string[] {
  for (const [index, part] of segment.entries()) {
    if (basename(part) !== "git" || gitSubcommand(segment, index) !== "push") continue;

    return segment
      .slice(segment.indexOf("push", index + 1) + 1)
      .filter((value) => !value.startsWith("-") && value !== "origin");
  }

  return [];
}

function pushDetail(parts: string[], aliased: string[][] = []): string {
  const groups = [...segments(parts).filter(pushes), ...aliased];
  const values = groups.flat();
  const refspecs = groups.flatMap(pushRefspecs);

  if (
    values.some(
      (part) =>
        (part.startsWith("-") && !part.startsWith("--") && part.slice(1).includes("f")) ||
        ["--force", "--force-if-includes"].includes(part) ||
        part.startsWith("--force-with-lease") ||
        part.startsWith("+"),
    )
  )
    return "force push. A typed push never rewrites a pushed commit: skills fix-round pushes a fix round and lease rebases the owned layers above it, and skills lease-rebase restacks owned layers onto a moved parent. skills restack-layer lease pushes a resolved stale layer and restacks the owned layers above it.";

  if (values.some((part) => ["--delete", "-d", "--prune"].includes(part) || part.startsWith(":")))
    return "delete push. A typed push never deletes a remote ref: skills publish and skills fix-round make every push past the allowed shape, and removing a remote branch is the operator's.";

  if (
    groups.some((group) => group.includes("gh") && group.includes("stack")) ||
    refspecs.length > 1 ||
    values.some((part) => ["--all", "--mirror"].includes(part) || part.includes("*"))
  )
    return "stack push. Stack pushes and stack submission go through skills publish.";

  return `chained or unsupported push. ${OTHER_PUSH_JOB}`;
}

function branch(value: string): string {
  if (!value || value.startsWith("-") || value.startsWith("refs/")) return "";
  if (/[\s\p{Cc}*?[:+~^`\\]/u.test(value)) return "";
  return value;
}

function pushedBranch(refspec: string): string {
  if (branch(refspec)) return refspec;

  const separator = refspec.indexOf(":");
  const left = refspec.slice(0, separator);
  if (separator < 0 || left !== refspec.slice(separator + 1) || !left.startsWith("refs/heads/"))
    return "";

  return branch(left.slice("refs/heads/".length));
}

function oneMessage(parts: string[]): string | undefined {
  if (parts.length === 2 && ["-m", "--message"].includes(parts[0]!)) return parts[1];
  if (parts.length === 1 && parts[0]!.startsWith("-m") && parts[0]!.length > 2)
    return parts[0]!.slice(2);

  if (parts.length === 1 && parts[0]!.startsWith("--message="))
    return parts[0]!.slice("--message=".length);

  return undefined;
}

// tokens() drops quoting, so the -C word is judged as written. Only spellings bash and zsh
// both pass as one known path survive: zsh expands ~ after empty quotes, ~"/x" and =cmd,
// and either shell expands braces and globs.
function homeSpelling(spelling: string): boolean | undefined {
  if (/^~(?:\/[\w@%+=:,./\u0080-￿-]*)?$/.test(spelling)) return true;
  if (/^(?:'[^']*'|"[^"]*"|[\w@%+:,./\u0080-￿-][\w@%+=:,./\u0080-￿-]*)$/.test(spelling))
    return false;

  return undefined;
}

function allowed(raw: string, parts: string[]): Result | undefined {
  if (UNSAFE.test(raw) || parts.some(isPunctuation)) return undefined;

  if (parts[0] === "git") {
    let rest = parts.slice(1);
    let directory = "";
    let expandsHome: boolean | undefined = false;
    if (rest.length >= 2 && rest[0] === "-C") {
      directory = rest[1]!;
      expandsHome = homeSpelling(raw.match(SPELLED_WORD)?.[2] ?? "");
      rest = rest.slice(2);
    }

    if (rest[0] === "commit") {
      const message = oneMessage(rest.slice(1));
      if (message !== undefined) return { kind: "COMMIT", message, directory };

      return {
        kind: "DENY_COMMIT",
        detail: rest.includes("--amend")
          ? "amend is not allowed"
          : "commit has an extra flag or no single message",
      };
    }

    const verb = committingVerb(parts, 0, true);
    if (verb !== undefined)
      return {
        kind: "VERB_COMMIT",
        detail: `git ${verb} commits a message the guard cannot check; ${COMMITTING_VERBS[verb]!.instead}`,
      };

    if (rest[0] !== "push") return undefined;

    const flags = rest.slice(1, -2);
    if (
      new Set(flags).size !== flags.length ||
      flags.some((flag) => flag !== "-u" && flag !== "-q") ||
      rest.at(-2) !== "origin" ||
      expandsHome === undefined
    )
      return undefined;

    const refspec = rest.at(-1)!;
    if (!pushedBranch(refspec) || !LITERAL_WORD.test(raw.match(SPELLED_WORD)?.at(-1) ?? ""))
      return undefined;

    return { kind: "PUSH", detail: refspec, directory, expandsHome };
  }

  if (parts[0] === "gh" && parts[1] === "stack" && parts[2] === "add") {
    const rest = parts.slice(3);
    const alternatives = [
      [rest, []],
      [rest.slice(1), rest.slice(0, 1)],
      [rest.slice(0, -1), rest.slice(-1)],
    ];

    for (const [messages, positional] of alternatives) {
      const message = oneMessage(messages!);
      if (message !== undefined && !positional!.some((part) => part.startsWith("-")))
        return { kind: "COMMIT", message, directory: "" };
    }

    return hasStackMessage(rest)
      ? { kind: "DENY_COMMIT", detail: "stack add has an extra flag or no single message" }
      : undefined;
  }

  if (parts[0] === "gh" && parts[1] === "pr" && parts[2] === "comment")
    return parts.length === 6 &&
      patterns(raw).digit.test(parts[3]!) &&
      parts[4] === "--body" &&
      parts[5]
      ? { kind: "COMMENT", detail: parts[5] }
      : { kind: "DENY_COMMENT", detail: "PR comment is not a reviewer trigger" };

  return undefined;
}

function substituted(raw: string, budget: Budget): Result | undefined {
  if (!raw.includes("$(") && !raw.includes("`")) return undefined;

  let rest = raw;
  for (
    let match = /\$\(([^()]*)\)|`([^`]*)`/.exec(rest);
    match;
    match = /\$\(([^()]*)\)|`([^`]*)`/.exec(rest)
  ) {
    const inner = classify(match[1] ?? match[2]!, budget);
    if (inner.kind === "DENY_SETTING") return inner;
    if (inner.kind === "COMMIT" || inner.kind === "VERB_COMMIT" || inner.kind === "DENY_COMMIT")
      return {
        kind: "DENY_COMMIT",
        detail: "chained, substituted, multi line or unsupported commit",
      };

    if (inner.kind === "COMMENT" || inner.kind === "DENY_COMMENT")
      return {
        kind: "DENY_COMMENT",
        detail: "chained, substituted, multi line or unsupported PR comment",
      };

    if (inner.kind === "PUSH" || inner.kind === "DENY_PUSH")
      return { kind: "DENY_PUSH", detail: `substituted push. ${OTHER_PUSH_JOB}` };

    if (inner.kind === "DENY") return { kind: "DENY", detail: "substituted command" };

    rest = `${rest.slice(0, match.index)} _ ${rest.slice(match.index + match[0].length)}`;
  }

  return (rest.includes("$(") || rest.includes("`")) && patterns(raw).unparsed.test(rest)
    ? { kind: "DENY", detail: "substitution could not be read" }
    : undefined;
}

export function classify(raw: string, budget: Budget = { seen: new Set() }): Result {
  let parts: string[];
  try {
    parts = tokens(raw);
  } catch (error) {
    if (error instanceof ShellsDisagree)
      return { kind: "DENY", detail: "command could not be parsed" };

    if (namesSetting(raw)) return { kind: "DENY_SETTING" };

    const expressions = patterns(raw);
    const text = unquoted(raw);
    if (
      expressions.push.test(text) ||
      expressions.rewritten.test(text) ||
      environmentAliases(raw).length
    )
      return { kind: "DENY_PUSH", detail: `push could not be parsed. ${OTHER_PUSH_JOB}` };

    if ([joined(raw), text].flatMap(splitlines).some((line) => expressions.unparsed.test(line)))
      return { kind: "DENY", detail: "command could not be parsed" };

    return { kind: "PASS" };
  }

  if (setsSkills(raw)) return { kind: "DENY_SETTING" };

  const hidden = substituted(raw, budget);
  if (hidden) return hidden;

  const exact = allowed(raw, parts);
  if (exact) return exact;

  const groups = segments(parts);
  const lines = segments(tokens(raw, true));

  const alone = parts[0] === "git" && !UNSAFE.test(raw) && !parts.some(isPunctuation);
  let commit = lines.some((line) =>
    line.some(
      (part, index) => basename(part) === "git" && committingVerb(line, index, alone) !== undefined,
    ),
  );

  let comment = false;
  for (const segment of groups)
    for (const [index, part] of segment.entries()) {
      const name = basename(part);
      if (name === "git" && ["commit", "commit-tree"].includes(gitSubcommand(segment, index)))
        commit = true;

      if (name !== "gh") continue;

      const rest = segment.slice(index + 1);
      if (inOrder(rest, "pr", "comment")) comment = true;
      if (inOrder(rest, "stack", "add") && hasStackMessage(rest)) commit = true;
    }

  if (commit)
    return {
      kind: "DENY_COMMIT",
      detail: "chained, substituted, multi line or unsupported commit",
    };

  if (comment)
    return {
      kind: "DENY_COMMENT",
      detail: "chained, substituted, multi line or unsupported PR comment",
    };

  const aliased = environmentAliases(raw);
  if (aliased.length || groups.some(pushes))
    return { kind: "DENY_PUSH", detail: pushDetail(parts, aliased) };

  const expressions = patterns(raw);

  const fed = [true, false].flatMap((decode) => shellStdin(tokens(raw, true, true, decode)));
  const judged = new Set<string>();
  for (const segment of [...groups.filter(nests), ...fed]) {
    const key = segment.join("\0");
    if (judged.has(key)) continue;

    judged.add(key);

    const nested = [...new Set([...segment, segment.join(" ")])].map((part) =>
      part === raw ? "PASS" : classify(part, budget).kind,
    );

    if (nested.includes("DENY_SETTING")) return { kind: "DENY_SETTING" };
    if (
      nested.every((kind) => kind === "PASS") &&
      !segment.some((part) => expressions.fallback.test(part) || namesCommittingVerb(part))
    )
      continue;

    return nested.some((kind) => kind === "PUSH" || kind === "DENY_PUSH") ||
      segment.some((part) => expressions.push.test(part))
      ? { kind: "DENY_PUSH", detail: pushDetail(parts) }
      : { kind: "DENY", detail: "nested command" };
  }

  let built: Set<string>;
  try {
    built = new Set(
      [false, true].flatMap((literal) =>
        (["bash", "zsh"] as const).flatMap((shell) =>
          relayed(tokens(raw, true, literal, !literal, shell), budget),
        ),
      ),
    );
  } catch (error) {
    if (error instanceof Unjudged) return { kind: "DENY", detail: error.message };
    throw error;
  }

  for (const command of built) {
    const kind = command === raw ? "PASS" : classify(command, budget).kind;
    if (kind === "DENY_SETTING") return { kind };
    if (kind === "PASS") continue;

    return kind === "PUSH" || kind === "DENY_PUSH"
      ? { kind: "DENY_PUSH", detail: pushDetail(parts) }
      : { kind: "DENY", detail: "nested command" };
  }

  return { kind: "PASS" };
}

function homeExpanded(path: string | undefined, env: NodeJS.ProcessEnv): string {
  const home = env.HOME || homedir();
  if (path === undefined || path === "~") return home;
  return path.startsWith("~/") ? home + path.slice(1) : path;
}

function gitDirectory(start: string, directory: string, env: NodeJS.ProcessEnv): string {
  return joinPath(start, homeExpanded(directory, env));
}

function skillsShipFrom(raw: string, start: string, env: NodeJS.ProcessEnv): string[] {
  let parts: string[];
  try {
    parts = tokens(raw, true);
  } catch {
    return [];
  }

  const shipping: (string | undefined)[][] = [];
  const saved: (string | undefined)[][] = [];

  let steps: (string | undefined)[] = [];
  let segment: string[] = [];
  for (const part of [...parts, ";"]) {
    if (!isPunctuation(part)) {
      segment.push(part);
      continue;
    }

    const command = segment.findIndex((word) => !ASSIGNMENT.test(word));
    const [name = "", ...rest] = command < 0 ? [] : segment.slice(command);
    const verb = rest[0] === "--root" ? rest[2] : rest[0];
    const subshell = /^(?:&(?!&)|\|(?!\|))/.test(part);
    if (name === "cd" && !subshell) steps = [...steps, rest.find((word) => !word.startsWith("-"))];
    else if (basename(name) === "skills" && SHIPPING_VERBS.has(verb ?? "")) shipping.push(steps);

    segment = [];

    for (const char of part)
      if (char === "(") saved.push(steps);
      else if (char === ")") steps = saved.pop() ?? steps;
  }

  const directories = shipping.map((cds) =>
    cds.reduce<string>((directory, step) => joinPath(directory, homeExpanded(step, env)), start),
  );

  return [...new Set(directories)];
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("unreadable payload");

  return value as Record<string, unknown>;
}

function command(payload: Record<string, unknown>): string {
  const value = object(payload.tool_input).command;
  if (typeof value === "string") return value;
  if (!Array.isArray(value) || !value.every((part): part is string => typeof part === "string"))
    throw new Error("unreadable command");

  if (
    value.length === 3 &&
    ["bash", "sh", "zsh"].includes(basename(value[0]!)) &&
    ["-c", "-lc"].includes(value[1]!)
  )
    return value[2]!;

  return value
    .map((part) =>
      !part
        ? "''"
        : /^[\w@%+:,./-][\w@%+=:,./-]*$/.test(part)
          ? part
          : "'" + part.replaceAll("'", "'\"'\"'") + "'",
    )
    .join(" ");
}

function deny(reason: string): string {
  return `{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": ${JSON.stringify(reason)}}}\n`;
}

async function pushBlock(
  result: Extract<Result, { kind: "PUSH" }>,
  start: string,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  // bash and zsh expand ~ to nothing under a set but empty HOME, where homedir() would not.
  const directory = !result.expandsHome
    ? joinPath(start, result.directory)
    : env.HOME === ""
      ? joinPath(start, result.directory.slice(1))
      : gitDirectory(start, result.directory, env);

  const target = pushedBranch(result.detail);
  const gitEnv = scrubGitEnv(env);
  const git = async (args: string[]): Promise<{ code: number | undefined; output: string }> => {
    try {
      const spawned = await read(["git", "-C", directory, ...args], {
        env: gitEnv,
        deadline: 5_000,
      });

      if (!spawned.ok) return { code: undefined, output: "" };

      const output = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
        .decode(spawned.bytes)
        .replace(/\r\n?/g, "\n");

      return { code: spawned.code, output };
    } catch {
      return { code: undefined, output: "" };
    }
  };

  const [head, local, remapped, pushDefault] = await Promise.all([
    git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]),
    git(["show-ref", "--verify", "--quiet", `refs/heads/${target}`]),
    git(["config", "--get-all", "remote.origin.push"]),
    git(["config", "--get", "push.default"]),
  ]);

  if (
    [head, local, remapped].some((result) => result.code === undefined) ||
    (pushDefault.code !== 0 && pushDefault.code !== 1)
  )
    return "git could not be read, so the default branch is unknown";

  const prefix = "refs/remotes/origin/";
  const defaultBranch = head.output.trim().slice(prefix.length);
  if (head.code !== 0 || !head.output.startsWith(prefix) || !defaultBranch)
    return "origin/HEAD is unset, so the default branch is unknown. Run git remote set-head origin -a, then push again";

  if (target === defaultBranch) return `${defaultBranch} is the default branch`;
  if (local.code !== 0) return `${target} is not a local branch`;
  if (!result.detail.includes(":") && remapped.code !== 1)
    return `remote.origin.push may send ${target} elsewhere, so name the destination: git push origin refs/heads/${target}:refs/heads/${target}`;

  const upstream = pushDefault.output.trim();
  if (!result.detail.includes(":") && ["upstream", "tracking"].includes(upstream))
    return `push.default is ${upstream}, so git may send ${target} to its upstream branch; name the destination: git push origin refs/heads/${target}:refs/heads/${target}`;

  return "";
}

type Denial = { reason: string; rule: RuleId };

const MESSAGE_RULES: Record<MessageProblem, { detail: string; rule: RuleId }> = {
  "multi line message": { detail: "multi line message", rule: "commit-guard/message" },
  "longer than 50 characters": {
    detail: "message is longer than 50 characters",
    rule: "commit-guard/message-length",
  },
  "no Conventional prefix": {
    detail: "message has no Conventional prefix",
    rule: "commit-guard/message-prefix",
  },
};

async function decide(
  result: Result,
  start: string,
  root: string,
  env: NodeJS.ProcessEnv,
): Promise<Denial | undefined> {
  const commitReason = `Allowed shape: ${COMMIT_SHAPE}.`;
  const commentReason = `Allowed shape: ${COMMENT_SHAPE}.`;
  const pushReason = (reason: string) => `${reason} Allowed typed push: ${PUSH_SHAPE}.`;
  switch (result.kind) {
    case "PASS":
      return undefined;

    case "DENY_SETTING":
      return { reason: SETTING_REASON, rule: "commit-guard/setting" };

    case "DENY_COMMIT":
      return {
        reason: `Blocked: ${result.detail}. ${commitReason}`,
        rule: "commit-guard/commit-shape",
      };

    case "DENY_COMMENT":
      return {
        reason: `Blocked: ${result.detail}. ${commentReason}`,
        rule: "commit-guard/comment-shape",
      };

    case "DENY_PUSH":
      return { reason: pushReason(`Blocked: ${result.detail}.`), rule: "commit-guard/push" };

    case "DENY":
      return {
        reason: pushReason(
          `Blocked: ${result.detail}. Allowed shapes: ${BOTH_SHAPES}. ${OTHER_PUSH_JOB}`,
        ),
        rule: "commit-guard/unparsed",
      };
  }

  if (result.kind === "COMMIT") {
    const { messageProblem } = await import("../publish/commit.ts");
    const problem = messageProblem(result.message);
    if (problem) {
      const { detail, rule } = MESSAGE_RULES[problem];
      return { reason: `Blocked: ${detail}. ${commitReason}`, rule };
    }
  }

  const { readDelivery } = await import("../delivery.ts");
  const delivery = readDelivery(root, env);
  const extensions = delivery.mode === "prs" ? delivery.active : [];

  if (result.kind === "VERB_COMMIT" && delivery.mode === "prs")
    return {
      reason: `Blocked: ${result.detail}. ${commitReason}`,
      rule: "commit-guard/commit-shape",
    };

  if (result.kind === "COMMIT" || result.kind === "VERB_COMMIT")
    return delivery.mode === "prs"
      ? undefined
      : {
          reason: `Blocked: hands-off mode leaves the work unstaged and the operator commits. ${commitReason}`,
          rule: "commit-guard/hands-off-commit",
        };

  if (result.kind === "COMMENT") {
    let triggers: Map<string, string>;
    try {
      const { readDeclarations } = await import("../reviewers/declaration.ts");

      triggers = new Map(
        readDeclarations(root).map((declaration) => [declaration.name, declaration.trigger]),
      );
    } catch {
      return {
        reason: `Blocked: reviewer declarations are unreadable. ${commentReason}`,
        rule: "commit-guard/unreadable",
      };
    }

    if (
      [...triggers].some(
        ([name, trigger]) => result.detail === trigger && extensions.includes(name),
      )
    )
      return undefined;

    const inactive = [...triggers].find(([, trigger]) => result.detail === trigger)?.[0];
    return {
      reason: `Blocked: ${inactive !== undefined ? `${inactive} is inactive` : "the body is no active reviewer's trigger"}. ${commentReason}`,
      rule: "commit-guard/comment-inactive",
    };
  }

  if (delivery.mode !== "prs")
    return {
      reason: pushReason(
        "Blocked: hands-off mode leaves the work unstaged and the operator pushes.",
      ),
      rule: "commit-guard/hands-off-push",
    };

  const block = await pushBlock(result, start, env);
  return block
    ? { reason: pushReason(`Blocked: ${block}.`), rule: "commit-guard/push-refused" }
    : undefined;
}

async function sweepBeforeShipping(
  payload: Record<string, unknown>,
  directories: string[],
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    const { commitSweep } = await import("./sweep.ts");
    return commitSweep(payload, directories, env);
  } catch {
    return undefined;
  }
}

type Guarded = { output: string; rule?: RuleId; payload?: Record<string, unknown> };

export async function guard(input: string, root: string, env: NodeJS.ProcessEnv): Promise<Guarded> {
  let payload: Record<string, unknown> | undefined;
  try {
    payload = object(JSON.parse(input));
    if (
      payload.tool_name !== undefined &&
      payload.tool_name !== null &&
      payload.tool_name !== "Bash"
    )
      return { output: "" };

    const raw = command(payload);
    const result = classify(raw);

    const cwd = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
    const workdir = object(payload.tool_input).workdir;
    const start = joinPath(cwd, typeof workdir === "string" ? workdir : "");
    const denial = await decide(result, start, root, env);
    if (denial) return { output: deny(denial.reason), rule: denial.rule, payload };

    const directories =
      result.kind === "COMMIT"
        ? [gitDirectory(start, result.directory, env)]
        : result.kind === "PASS"
          ? skillsShipFrom(raw, start, env)
          : [];

    if (!directories.length) return { output: "" };

    const swept = await sweepBeforeShipping(payload, directories, env);
    return swept
      ? { output: deny(swept), rule: "commit-guard/comment-lines", payload }
      : { output: "" };
  } catch {
    return { output: deny(UNREADABLE), rule: "commit-guard/unreadable", payload };
  }
}

export async function preToolUse(ctx: Context): Promise<number> {
  let guarded: Guarded;
  try {
    const input = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      await Bun.stdin.bytes(),
    );

    guarded = await guard(input, ctx.root, process.env);
  } catch {
    guarded = { output: deny(UNREADABLE), rule: "commit-guard/unreadable" };
  }

  if (guarded.output) process.stdout.write(guarded.output);
  if (guarded.rule)
    await recordBlock(
      { reason: guarded.output, rules: [guarded.rule] },
      guarded.payload ?? {},
      process.env,
    );

  return 0;
}
