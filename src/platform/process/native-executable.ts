import { open, stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, win32 } from "node:path";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_VERSION_BYTES = 256;

export class InvalidProcessInputError extends TypeError {
  readonly kind = "InvalidInput" as const;
  constructor(readonly safeMessage: string) {
    super(safeMessage);
    this.name = "InvalidProcessInputError";
  }
}

export function containsNul(value: string): boolean { return value.includes("\0"); }

/** Native executables only. Windows command wrappers are never accepted. */
export function assertNativeExecutablePath(executable: string, platform = process.platform): string {
  if (typeof executable !== "string" || containsNul(executable)) {
    throw new InvalidProcessInputError("executable path is invalid");
  }
  if (!isAbsolute(executable)) throw new InvalidProcessInputError("executable must be an absolute path");
  if (/\.(?:cmd|bat|ps1)$/i.test(executable)) {
    throw new InvalidProcessInputError("command wrappers are not native executables");
  }
  if (platform === "win32" && !/\.exe$/i.test(executable)) {
    throw new InvalidProcessInputError("Windows executable must end in .exe");
  }
  return normalize(executable);
}

/** Resolve immediately before spawn. Node cannot eliminate the stat-to-spawn TOCTOU window. */
export async function resolveVersionedExecutable(options: Readonly<{
  directory: string;
  prefix: string;
  versionFile: string;
}>): Promise<string> {
  if (containsNul(options.directory) || containsNul(options.versionFile) ||
      !isAbsolute(options.directory) || !isAbsolute(options.versionFile)) {
    throw new InvalidProcessInputError("resolver paths must be absolute and contain no NUL");
  }
  if (!SAFE_NAME.test(options.prefix)) throw new InvalidProcessInputError("invalid executable prefix");
  const handle = await open(options.versionFile, "r");
  let version: string;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_VERSION_BYTES) {
      throw new InvalidProcessInputError("version selector must be a small regular file");
    }
    const bytes = Buffer.alloc(MAX_VERSION_BYTES + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > MAX_VERSION_BYTES) throw new InvalidProcessInputError("version selector is too large");
    version = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, offset)).trim();
  } finally {
    await handle.close();
  }
  if (!SAFE_NAME.test(version) || version === "." || version === "..") {
    throw new InvalidProcessInputError("invalid version selector");
  }
  const candidate = resolve(join(options.directory, `${options.prefix}${version}.exe`));
  const info = await stat(candidate);
  if (!info.isFile()) throw new InvalidProcessInputError("resolved executable is not a file");
  return assertNativeExecutablePath(candidate, "win32");
}

/** Comparable Windows paths, including Win32 extended-length and UNC spellings. */
export function normalizeWindowsPathForComparison(input: string): string {
  let value = input;
  if (value.startsWith("\\\\?\\UNC\\")) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith("\\\\?\\")) value = value.slice(4);
  return win32.normalize(value).toLowerCase();
}
