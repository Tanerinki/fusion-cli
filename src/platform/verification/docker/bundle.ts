import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { failWith } from "../../../core/errors.js";
import { removeOwnedTemporary } from "../../fs/temporary.js";
import { comparablePath } from "../../workspace/git.js";
import type { DockerInput } from "./cli.js";
import { RUN_ID } from "./config.js";
import { SOURCE_ARCHIVE_LIMITS, type GuestManifest, type InputPart } from "./protocol.js";
import { digestStream, encodeArchive, fileContent, memoryArchive, planTree, TransferArchiveError,
  type ArchiveEntry, type ArchiveLimits } from "./transfer-archive.js";

/**
 * Host side of the protocol-2 data flow. Nothing is mounted into a container. The container's stdin carries, in order:
 *
 *   "FUSIONB1" u32 length  guest bundle   package.json {"type":"module"}, guest-runner.js, transfer-archive.js
 *                                         (SHA-256 pinned in the container argv; checked by the fixed bootstrap)
 *   "FUSIONM1" u32 length  manifest JSON  (SHA-256 pinned in the container argv; checked by the runner)
 *   FTA1 archive(s)                       candidate source (+ gzip dependency archive), digests in the manifest
 *
 * The candidate is archived from a Fusion-owned private verification tree: regular files and directories only, `.git`
 * excluded, no `node_modules` (dependency state enters only through the dependency lane), bounded. A symbolic link,
 * junction or special file fails the run closed; it is never followed or copied. No host run directory is created for a
 * normal verification; evidence collection alone creates one, for a host-private synthetic marker that is never sent.
 */
export const RUN_ROOT_PREFIX = "fusion-docker-";
const MARKER = ".fusion-docker-run";
export const BUNDLE_MAGIC = "FUSIONB1";
export const MANIFEST_MAGIC = "FUSIONM1";
const GUEST_FILES = Object.freeze(["guest-runner.js", "transfer-archive.js"]);

export interface RunDirectories {
  readonly runRoot: string;
  readonly privateSibling: string;
}

export async function createRunDirectories(runId: string, base: string = tmpdir()): Promise<RunDirectories> {
  if (!RUN_ID.test(runId)) failWith("InvalidInput", "Docker run id is invalid.");
  const runRoot = await mkdtemp(join(resolve(base), RUN_ROOT_PREFIX));
  await writeFile(join(runRoot, MARKER), runId, { flag: "wx" });
  const privateSibling = join(runRoot, "private-sibling");
  await mkdir(privateSibling);
  return Object.freeze({ runRoot, privateSibling });
}

/**
 * Removes a run directory only when it is provably this run's: a direct child of `base` with the Fusion prefix, not
 * a link, and carrying the ownership marker with the expected run id. Anything else is left in place and reported.
 */
export async function removeRunDirectories(directories: Pick<RunDirectories, "runRoot">, runId: string,
  base: string = tmpdir()): Promise<boolean> {
  const root = resolve(directories.runRoot);
  if (comparablePath(dirname(root)) !== comparablePath(resolve(base)) || !basename(root).startsWith(RUN_ROOT_PREFIX)) return false;
  try {
    const info = await lstat(root);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if ((await readFile(join(root, MARKER), "utf8")) !== runId) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" && await lstat(root).then(() => false, () => true);
  }
  await removeOwnedTemporary(root);
  return lstat(root).then(() => false, () => true);
}

const frame = (magic: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(12);
  header.write(magic, 0, "latin1");
  header.writeUInt32BE(body.length, 8);
  return Buffer.concat([header, body]);
};
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export interface GuestBundle {
  /** The complete `FUSIONB1` frame. */
  readonly frame: Buffer;
  /** SHA-256 of the bundle body, pinned in the container argv. */
  readonly sha256: string;
  /** SHA-256 of the runner module alone (for evidence). */
  readonly runnerSha256: string;
}
/** The compiled guest modules, read from next to this module, framed for the bootstrap. */
export async function loadGuestBundle(): Promise<GuestBundle> {
  const files: [string, Buffer][] = [["package.json", Buffer.from('{"type":"module"}')]];
  for (const name of GUEST_FILES) files.push([name, await readFile(new URL(`./${name}`, import.meta.url))]);
  const parts: Buffer[] = [Buffer.from([files.length])];
  for (const [name, bytes] of files) {
    const nameBytes = Buffer.from(name, "utf8"), length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.length, 0);
    parts.push(Buffer.from([nameBytes.length]), nameBytes, length, bytes);
  }
  const body = Buffer.concat(parts);
  return Object.freeze({ frame: frame(BUNDLE_MAGIC, body), sha256: sha256(body),
    runnerSha256: sha256(files.find(([name]) => name === "guest-runner.js")![1]) });
}

export interface ManifestFrame {
  readonly frame: Buffer;
  readonly sha256: string;
}
export function manifestFrame(manifest: GuestManifest): ManifestFrame {
  const body = Buffer.from(JSON.stringify(manifest), "utf8");
  return Object.freeze({ frame: frame(MANIFEST_MAGIC, body), sha256: sha256(body) });
}

/** An input part the host can stream (twice: once to digest, once to send) with a fixed digest. */
export interface StreamedPart extends InputPart {
  chunks(): AsyncIterable<Uint8Array>;
}
export interface SnapshotStats {
  readonly files: number;
  readonly directories: number;
  readonly bytes: number;
}

/** Maps archive-layer codes to typed, path-free failures. */
export function archiveFailure(error: unknown, what: string): never {
  if (!(error instanceof TransferArchiveError)) throw error;
  if (error.code === "tree-link") failWith("SecurityViolation", `${what} contains a symbolic link or junction; it is never copied or followed.`);
  if (error.code === "tree-special-file") failWith("SecurityViolation", `${what} contains a special file.`);
  if (error.code === "path-forbidden-segment")
    failWith("SecurityViolation", `${what} contains node_modules; dependency state enters verification only through the dependency lane.`);
  if (error.code === "file-changed-during-encode") failWith("SecurityViolation", `${what} changed while it was being archived.`);
  if (error.code === "tree-root-invalid") failWith("InvalidInput", `${what} must be a real directory.`);
  return failWith("InvalidInput", `${what} cannot be archived (${error.code}).`);
}

/**
 * Plans and digests the candidate source archive. The digest pass and the send pass read the same files; a file that
 * changes in between makes the guest's digest check (and the host's own re-hash) fail closed.
 */
export async function candidateSourcePart(root: string, limits: ArchiveLimits = SOURCE_ARCHIVE_LIMITS):
  Promise<Readonly<{ part: StreamedPart; stats: SnapshotStats }>> {
  let entries: readonly ArchiveEntry[];
  try { entries = await planTree(resolve(root), { limits, skipRootNames: [".git"] }); }
  catch (error) { return archiveFailure(error, "Verification candidate"); }
  const chunks = (): AsyncIterable<Uint8Array> => encodeArchive(entries, entry => fileContent(resolve(root), entry));
  let digest;
  try { digest = await digestStream(chunks()); } catch (error) { return archiveFailure(error, "Verification candidate"); }
  const files = entries.filter(entry => entry.kind === "file");
  return Object.freeze({ part: Object.freeze({ sha256: digest.sha256, bytes: digest.bytes, limits, chunks }),
    stats: Object.freeze({ files: files.length, directories: entries.length - files.length,
      bytes: files.reduce((sum, entry) => sum + entry.size!, 0) }) });
}

/** A small Fusion-authored archive held in memory (canary input, dependency manifests). */
export async function memoryPart(files: Readonly<Record<string, Buffer>>, limits: ArchiveLimits): Promise<StreamedPart> {
  const [entries, content] = memoryArchive(files);
  const bytes = Buffer.concat(await collect(encodeArchive(entries, content)));
  return Object.freeze({ sha256: sha256(bytes), bytes: bytes.length, limits, chunks: async function* () { yield bytes; } });
}

async function collect(stream: AsyncIterable<Uint8Array>): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for await (const chunk of stream) out.push(Buffer.from(chunk));
  return out;
}

/**
 * The complete stdin for one container: bundle frame, manifest frame, then the parts in manifest order. While
 * sending, each part is hashed again; a part whose bytes differ from its announced digest aborts the stream (the guest
 * would refuse it anyway), and `mismatch` records it for the host's own verdict.
 */
export function containerInput(bundle: GuestBundle, manifest: ManifestFrame, parts: readonly StreamedPart[]):
  DockerInput & Readonly<{ mismatch: () => boolean }> {
  let mismatch = false;
  const bytes = bundle.frame.length + manifest.frame.length + parts.reduce((sum, part) => sum + part.bytes, 0);
  return {
    bytes,
    mismatch: () => mismatch,
    async *chunks() {
      yield bundle.frame;
      yield manifest.frame;
      for (const part of parts) {
        const hash = createHash("sha256");
        let sent = 0;
        for await (const chunk of part.chunks()) {
          sent += chunk.byteLength;
          if (sent > part.bytes) { mismatch = true; return; }
          hash.update(chunk);
          yield chunk;
        }
        if (sent !== part.bytes || hash.digest("hex") !== part.sha256) { mismatch = true; return; }
      }
    },
  };
}
