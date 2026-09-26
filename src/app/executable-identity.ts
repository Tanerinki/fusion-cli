import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/**
 * O5.5B23/O5.5B25: an authorized executable's exact identity — the directory a grant names and the SHA-256 of its bytes.
 * Reading only: nothing here ever starts the executable.
 */

/** The directory a grant names, resolved against the environment; undefined when it cannot be resolved exactly. */
export function grantDirectory(template: string, env: NodeJS.ProcessEnv): string | undefined {
  const prefix = "%LOCALAPPDATA%";
  if (template.toUpperCase().startsWith(prefix)) {
    const base = env.LOCALAPPDATA;
    return typeof base === "string" && isAbsolute(base) ? resolve(base, template.slice(prefix.length).replace(/^[\\/]+/u, "")) : undefined;
  }
  return isAbsolute(template) ? resolve(template) : undefined;
}
/** SHA-256 of a file's bytes, streamed (the executable may be hundreds of MiB). */
export async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((done, fail) => createReadStream(path).on("data", chunk => hash.update(chunk)).once("end", () => done())
    .once("error", fail));
  return hash.digest("hex");
}
