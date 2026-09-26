import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { MuseLaunchConfig } from "./types.js";

/** Content digests of executables already read, keyed by path and invalidated by any size or modification change. */
const DIGESTS = new Map<string, Readonly<{ size: number; mtimeMs: number; sha256: string }>>();

async function executableSha256(path: string): Promise<string> {
  const info = await stat(path);
  const known = DIGESTS.get(path);
  if (known !== undefined && known.size === info.size && known.mtimeMs === info.mtimeMs) return known.sha256;
  const hash = createHash("sha256");
  await new Promise<void>((done, fail) => createReadStream(path).on("data", chunk => hash.update(chunk)).once("end", () => done())
    .once("error", fail));
  const sha256 = hash.digest("hex");
  DIGESTS.set(path, Object.freeze({ size: info.size, mtimeMs: info.mtimeMs, sha256 }));
  return sha256;
}

/**
 * O5.5B24: whether the executable about to run for `version` is exactly the binary this binding's validation names
 * (`MuseLaunchConfig.validatedBindings`, by SHA-256). False for any other release, any other binary, an unreadable file,
 * or a binding without such a validation: the binding-scoped facts are then never claimed.
 */
export async function validatedBindingIdentity(config: MuseLaunchConfig, executable: string, version: string): Promise<boolean> {
  const entry = (config.validatedBindings ?? []).find(candidate => candidate.release === version);
  if (entry === undefined) return false;
  try { return await executableSha256(executable) === entry.executableSha256; } catch { return false; }
}
