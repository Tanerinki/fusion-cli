import { stat } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve, win32 } from "node:path";
import { BoundedReadError, readBoundedFile } from "../fs/bounded-read.js";

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
  let bytes: Buffer;
  try { bytes = await readBoundedFile(options.versionFile, MAX_VERSION_BYTES); }
  catch (error) {
    if (error instanceof BoundedReadError) throw new InvalidProcessInputError("version selector must be a small regular file");
    throw error;
  }
  let version: string;
  try { version = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes).trim(); }
  catch { throw new InvalidProcessInputError("version selector is not valid UTF-8"); }
  if (!SAFE_NAME.test(version) || version === "." || version === "..") {
    throw new InvalidProcessInputError("invalid version selector");
  }
  const candidate = resolve(join(options.directory, `${options.prefix}${version}.exe`));
  const info = await stat(candidate);
  if (!info.isFile()) throw new InvalidProcessInputError("resolved executable is not a file");
  return assertNativeExecutablePath(candidate, "win32");
}

/**
 * Finds a native executable on PATH without a shell. Only `<name>.exe` is considered on Windows, so command
 * wrappers (`.cmd`/`.bat`/`.ps1`) are never selected. Returns null when absent.
 */
export async function resolveExecutableOnPath(name: string, env: NodeJS.ProcessEnv = process.env,
  platform = process.platform): Promise<string | null> {
  if (!SAFE_NAME.test(name)) throw new InvalidProcessInputError("invalid executable name");
  const pathValue = Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] ?? "";
  const separator = platform === "win32" ? ";" : ":";
  for (const directory of pathValue.split(separator)) {
    const trimmed = directory.trim().replace(/^"(.*)"$/u, "$1");
    if (!trimmed || containsNul(trimmed) || !isAbsolute(trimmed)) continue;
    const candidate = resolve(join(trimmed, platform === "win32" ? `${name}.exe` : name));
    try {
      if ((await stat(candidate)).isFile()) return assertNativeExecutablePath(candidate, platform);
    } catch { /* not present in this PATH entry */ }
  }
  return null;
}

/** Comparable Windows paths, including Win32 extended-length and UNC spellings. */
export function normalizeWindowsPathForComparison(input: string): string {
  let value = input;
  if (value.startsWith("\\\\?\\UNC\\")) value = `\\\\${value.slice(8)}`;
  else if (value.startsWith("\\\\?\\")) value = value.slice(4);
  return win32.normalize(value).toLowerCase();
}
