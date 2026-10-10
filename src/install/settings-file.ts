import {
  accessSync,
  chownSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readlinkSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { object, parseJson, stringifyJson, type JsonObject } from "./json.ts";

export type Format = { indent: string; newline: "\n" | "\r\n"; finalNewline: boolean };
export type SettingsFile = {
  path: string;
  real: string;
  stats: Stats | undefined;
  text: string | undefined;
  bytes: Buffer | undefined;
  format: Format;
  data: JsonObject;
  canonical: string;
};

export type WriteOutcome =
  | { outcome: "written" }
  | { outcome: "unchanged" }
  | { outcome: "refused"; reason: string };

export function resolveTarget(path: string): string {
  let target = resolve(path);
  for (let hops = 0; hops < 40; hops++) {
    if (!lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) return target;
    target = resolve(dirname(target), readlinkSync(target));
  }

  throw new Error("dangling symlink or symlink loop");
}

export function accessible(path: string, flag: number, mask: number): boolean {
  try {
    accessSync(path, flag);
    return (statSync(path).mode & mask) !== 0;
  } catch {
    return false;
  }
}

export class MetadataCopyError extends Error {
  constructor(source: string, path: string, reason: string) {
    super(`cannot copy metadata from ${source} to ${path}: ${reason}`);
    this.name = "MetadataCopyError";
  }
}

export function writeAtomic(
  path: string,
  content: string | Uint8Array,
  mode: number,
  metadataSource = path,
  current?: () => boolean,
): boolean {
  const temporary = join(dirname(path), `.${basename(path)}.${crypto.randomUUID()}`);

  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    closeSync(descriptor);
    descriptor = undefined;

    if (existsSync(metadataSource)) {
      const copy = Bun.which("cp", { PATH: process.env.PATH });
      try {
        if (copy) {
          const result = Bun.spawnSync(
            process.platform === "linux"
              ? [copy, "--preserve=mode,ownership,timestamps,xattr", metadataSource, temporary]
              : [copy, "-p", metadataSource, temporary],
            {
              stdout: "ignore",
              stderr: "ignore",
            },
          );

          if (result.exitCode !== 0)
            throw new MetadataCopyError(metadataSource, path, `cp exited ${result.exitCode}`);
        } else copyFileSync(metadataSource, temporary);
      } catch (error) {
        if (error instanceof MetadataCopyError) throw error;
        throw new MetadataCopyError(metadataSource, path, osReason(error));
      }

      chmodSync(temporary, 0o600);

      try {
        chownSync(temporary, -1, statSync(metadataSource).gid);
      } catch {}
    }

    descriptor = openSync(temporary, "w");
    writeFileSync(descriptor, content);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;

    chmodSync(temporary, mode);
    if (current && !current()) return false;

    renameSync(temporary, path);

    try {
      descriptor = openSync(dirname(path), "r");
      fsyncSync(descriptor);
    } catch {}

    return true;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function osReason(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code;
  const reasons: Record<string, string> = {
    EACCES: "Permission denied",
    EPERM: "Operation not permitted",
    ENOENT: "No such file or directory",
    ENOSPC: "No space left on device",
    EROFS: "Read-only file system",
    ELOOP: "Too many levels of symbolic links",
  };

  return (code && reasons[code]) || (error instanceof Error ? error.message : String(error));
}

function serialize(data: JsonObject, format: Format): string {
  const content = stringifyJson(data, format.indent).replace(/\n/g, format.newline);
  return content + (format.finalNewline ? format.newline : "");
}

export function readSettings(path: string): SettingsFile | { refused: string } {
  let real: string;
  try {
    real = resolveTarget(path);
  } catch {
    return { refused: "dangling symlink or symlink loop" };
  }

  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() && !existsSync(path))
    return { refused: "dangling symlink or symlink loop" };

  const stats = existsSync(real) ? statSync(real) : undefined;
  if (stats?.isDirectory()) return { refused: "is a directory" };

  const directory = dirname(real);
  if (!existsSync(directory) || !statSync(directory).isDirectory())
    return { refused: "parent directory does not exist" };

  let bytes: Buffer | undefined;
  let text: string | undefined;
  let data: JsonObject = {};
  if (stats) {
    if (!stats.isFile()) return { refused: "is not a regular file" };
    if (!accessible(real, constants.R_OK, 0o444)) return { refused: "is not readable" };

    try {
      bytes = readFileSync(real);
    } catch (error) {
      return { refused: `cannot read: ${osReason(error)}` };
    }

    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return { refused: "is not UTF-8" };
    }

    try {
      const record = object(parseJson(text));
      if (!record) return { refused: "top level is not an object" };
      data = record;
    } catch (error) {
      return { refused: error instanceof Error ? error.message : String(error) };
    }
  }

  const indent = text?.match(/^\s*[{[][ \t]*(?:\r?\n[ \t]*)*\r?\n([ \t]+)\S/)?.[1];
  const format: Format = {
    indent: indent ?? "  ",
    newline: indent !== undefined && text!.includes("\r\n") ? "\r\n" : "\n",
    finalNewline: indent === undefined || text!.endsWith("\n"),
  };

  return { path, real, stats, text, bytes, format, data, canonical: serialize(data, format) };
}

export function writeSettings(file: SettingsFile, data: JsonObject): WriteOutcome {
  const content = serialize(data, file.format);
  if (content === file.canonical) return { outcome: "unchanged" };

  const { path, real, bytes } = file;
  const changed: WriteOutcome = {
    outcome: "refused",
    reason: "changed on disk since it was read",
  };

  const current = (): boolean => {
    try {
      if (resolveTarget(path) !== real) return false;
      if (bytes === undefined) return lstatSync(real, { throwIfNoEntry: false }) === undefined;
      return readFileSync(real).equals(bytes);
    } catch {
      return false;
    }
  };

  if (!current()) return changed;

  const stats = bytes === undefined ? undefined : statSync(real, { throwIfNoEntry: false });
  if (bytes !== undefined && !stats) return changed;
  if (stats && !accessible(real, constants.W_OK, 0o222))
    return { outcome: "refused", reason: "is not writable" };

  if (stats && stats.uid !== process.geteuid?.())
    return { outcome: "refused", reason: "is owned by another user" };

  if (stats && stats.nlink > 1)
    return { outcome: "refused", reason: "has hard links a rewrite would split" };

  if (!accessible(dirname(real), constants.W_OK, 0o222))
    return { outcome: "refused", reason: "parent directory is not writable" };

  if (/[\uD800-\uDFFF]/u.test(content))
    return { outcome: "refused", reason: "cannot encode as UTF-8" };

  try {
    const written = writeAtomic(
      real,
      content,
      stats ? stats.mode & 0o7777 : 0o666 & ~process.umask(),
      real,
      current,
    );

    return written ? { outcome: "written" } : changed;
  } catch (error) {
    if (!current()) return changed;
    if (error instanceof MetadataCopyError) throw error;
    return { outcome: "refused", reason: `cannot write: ${osReason(error)}` };
  }
}
