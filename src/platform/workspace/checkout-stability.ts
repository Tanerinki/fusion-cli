import { stat } from "node:fs/promises";
import { join } from "node:path";
import { comparablePath, type GitClient } from "./git.js";

/**
 * CHECKOUT BYTE STABILITY (v0.6).
 *
 * A host-controlled Writer delivery is prepared and verified against Git-blob / `.git`-free bytes (the committed tree,
 * which Fusion reads verbatim: LF as stored), but a production apply compares the EXACT RAW working-tree bytes against
 * that preimage (`applier.ts#checkTarget`, raw-byte SHA-256). On a checkout that TRANSFORMS blob bytes on the way to the
 * working tree — Windows `core.autocrlf=true`, a `text`/`eol` attribute, a `working-tree-encoding`, or a custom
 * clean/smudge `filter` — the raw working bytes differ from the blob even though `git status` reports the tree clean, so
 * the delivery can never be applied byte-exactly. This module detects that BEFORE a Writer build prepares such a delivery.
 *
 * The decision is deliberately CONSERVATIVE and fail-closed: a path is reported stable ONLY when Fusion can prove the
 * checkout leaves the blob bytes unchanged. It never normalizes, converts, or guesses; it only refuses. It is also
 * PATH-SPECIFIC — `.gitattributes` can make one path stable (`eol=lf`, `-text`) and another transforming (`eol=crlf`) in
 * the same repository — so every path a Writer may touch is classified individually, with the repo-wide config as input.
 */
export type CheckoutTransformCause =
  | "autocrlf"             // core.autocrlf=true converts text to CRLF on checkout
  | "coreEol"              // core.eol (or native on Windows) yields CRLF for a text path
  | "eolAttribute"         // a `eol=crlf` attribute forces CRLF
  | "filter"               // a clean/smudge filter driver is attached to the path
  | "workingTreeEncoding"  // a `working-tree-encoding` re-encodes the path on checkout
  | "undetermined";        // Git could not be queried; byte stability cannot be proven
export interface PathTransform {
  readonly path: string;
  readonly cause: CheckoutTransformCause;
  /** A short Fusion-owned label (attribute/config name and value); never file content. */
  readonly detail: string;
}
export interface CheckoutStability {
  readonly stable: boolean;
  readonly autocrlf: string;
  readonly coreEol: string;
  readonly transforms: readonly PathTransform[];
}
/** The four Git attributes that decide whether a checkout transforms a path's bytes. */
export interface PathAttributes {
  readonly text: string;   // "set" | "unset" | "auto" | "unspecified"
  readonly eol: string;    // "lf" | "crlf" | "unspecified"
  readonly filter: string; // a driver name | "unspecified" | "unset"
  readonly workingTreeEncoding: string; // an encoding | "unspecified" | "unset"
}
export interface CheckoutConfig {
  readonly autocrlf: string; // "true" | "false" | "input" (default "false")
  readonly coreEol: string;  // "lf" | "crlf" | "native" (default "native")
  readonly platform: "win32" | "posix";
}

/**
 * PURE decision: does this checkout transform the path's committed blob bytes into different working-tree bytes?
 * Returns `null` when provably byte-stable, else the single decisive cause. The order matters: a custom filter or a
 * working-tree-encoding transforms regardless of EOL; `-text` (binary) and `eol=lf` are byte-stable regardless of
 * `core.autocrlf`; only when the EOL attribute is unspecified does the repo-wide config decide.
 */
export function classifyPathTransform(attrs: PathAttributes, config: CheckoutConfig): Omit<PathTransform, "path"> | null {
  if (attrs.filter !== "unspecified" && attrs.filter !== "unset")
    return { cause: "filter", detail: `filter=${attrs.filter}` };
  if (attrs.workingTreeEncoding !== "unspecified" && attrs.workingTreeEncoding !== "unset")
    return { cause: "workingTreeEncoding", detail: `working-tree-encoding=${attrs.workingTreeEncoding}` };
  // A path explicitly marked binary (`-text`) is never EOL-converted by Git — byte-stable even under autocrlf=true.
  if (attrs.text === "unset") return null;
  if (attrs.eol === "lf") return null;                                  // forced LF matches the LF blob
  if (attrs.eol === "crlf") return { cause: "eolAttribute", detail: "eol=crlf" };
  // The EOL attribute is unspecified: the repo-wide config decides for a (possibly) text path.
  if (config.autocrlf === "true") return { cause: "autocrlf", detail: "core.autocrlf=true" };
  if (config.autocrlf === "input") return null;                         // no conversion on checkout
  // autocrlf is false/unset. A path only converts if it is treated as text AND the working EOL is CRLF.
  if (attrs.text === "set" || attrs.text === "auto") {
    const nativeIsCrlf = config.platform === "win32";
    if (config.coreEol === "crlf" || (config.coreEol === "native" && nativeIsCrlf))
      return { cause: "coreEol", detail: `core.eol=${config.coreEol}` };
    return null;                                                        // core.eol=lf, or native on POSIX
  }
  // No text attribute and autocrlf is off: Git leaves the bytes verbatim.
  return null;
}

const CONFIG_FALLBACK = Object.freeze({ autocrlf: "false", coreEol: "native" });
async function configValue(git: GitClient, root: string, key: string, fallback: string, signal?: AbortSignal): Promise<string> {
  const result = await git.run(["config", "--get", key], { cwd: root, ...(signal ? { signal } : {}) }).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return fallback;
  const value = result.stdout.trim().toLowerCase();
  return value.length > 0 ? value : fallback;
}

/**
 * Reads the EFFECTIVE Git config and attributes the primary checkout uses (a NON-isolated client, so the system/global
 * `core.autocrlf` that actually smudged the working tree is seen), predicts a transform per path, and CONFIRMS it against
 * the real bytes: a path is refused only when (a) its attributes/config predict a transform, (b) Git reports it clean
 * (so it is not a user edit), and (c) its raw working bytes differ from the committed blob — the exact signature of a
 * normalizing checkout (Git calls it clean, yet the bytes are not the blob). A path whose attributes forbid conversion
 * (`eol=lf`, `-text`), or whose bytes already equal the blob, is stable even under `core.autocrlf=true`; a path not in
 * HEAD (a create) is byte-safe. If Git cannot be queried at all, every predicted path is `undetermined` (fail-closed).
 * Read-only: no config or working tree is changed.
 */
export async function assessCheckoutByteStability(root: string, paths: readonly string[], git: GitClient,
  platform: "win32" | "posix" = process.platform === "win32" ? "win32" : "posix", signal?: AbortSignal): Promise<CheckoutStability> {
  const autocrlf = await configValue(git, root, "core.autocrlf", CONFIG_FALLBACK.autocrlf, signal);
  const coreEol = await configValue(git, root, "core.eol", CONFIG_FALLBACK.coreEol, signal);
  const unique = [...new Set(paths)].filter(path => path.length > 0);
  if (unique.length === 0) return { stable: true, autocrlf, coreEol, transforms: [] };
  const config: CheckoutConfig = { autocrlf, coreEol, platform };
  const attrs = await readAttributes(git, root, unique, signal);
  if (attrs === undefined)
    return { stable: false, autocrlf, coreEol,
      transforms: unique.map(path => ({ path, cause: "undetermined" as const, detail: "git check-attr could not be read" })) };
  const predicted = unique.map(path => ({ path, verdict: classifyPathTransform(attrs.get(path) ?? UNSPECIFIED, config) }))
    .filter((entry): entry is { path: string; verdict: Omit<PathTransform, "path"> } => entry.verdict !== null);
  const transforms: PathTransform[] = [];
  if (predicted.length > 0) {
    // A structural transform (a clean/smudge filter or a working-tree-encoding) is refused on the attribute alone: its
    // round trip is not guaranteed byte-identical, and it matches the applier's existing custom-filter refusal. Only the
    // EOL causes (autocrlf / core.eol / eol attribute) are byte-confirmed, because an LF working file under
    // `core.autocrlf=true` is provably stable and must not be a false positive.
    const structural = predicted.filter(p => p.verdict.cause === "filter" || p.verdict.cause === "workingTreeEncoding");
    for (const { path, verdict } of structural) transforms.push({ path, ...verdict });
    const eol = predicted.filter(p => p.verdict.cause !== "filter" && p.verdict.cause !== "workingTreeEncoding");
    if (eol.length > 0) {
      const changed = await changedPaths(git, root, eol.map(p => p.path), signal);
      for (const { path, verdict } of eol) {
        if (changed === undefined) { transforms.push({ path, cause: "undetermined", detail: "git status could not be read" }); continue; }
        if (changed.has(comparablePath(path))) continue;               // a user edit / untracked create — not a checkout transform
        const confirmed = await blobDiffersFromWorking(git, root, path, signal);
        if (confirmed === "differs") transforms.push({ path, ...verdict });
        else if (confirmed === "undetermined") transforms.push({ path, cause: "undetermined", detail: "working/blob bytes could not be compared" });
        // "equal" or "absent" (a create not in HEAD): byte-stable — suppressed.
      }
    }
  }
  return { stable: transforms.length === 0, autocrlf, coreEol, transforms };
}

/** The set of touched paths Git reports as changed (modified, staged or untracked) — those are not checkout transforms. */
async function changedPaths(git: GitClient, root: string, paths: readonly string[], signal?: AbortSignal): Promise<Set<string> | undefined> {
  const result = await git.run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...paths],
    { cwd: root, ...(signal ? { signal } : {}) }).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return undefined;
  const set = new Set<string>();
  for (const entry of result.stdout.split("\0").filter(Boolean)) set.add(comparablePath(entry.slice(3)));
  return set;
}
/**
 * Whether a touched path's raw working bytes differ from its committed blob, the signature of a transform. It is
 * compared by Git OBJECT ID and never as decoded text:
 * - `ls-tree` gives the committed blob's id;
 * - `hash-object --no-filters` hashes the raw working bytes as a blob WITHOUT any clean/EOL conversion.
 * So a non-UTF-8, binary or large file is compared byte-exactly. `absent` only when the path is provably not in HEAD (a
 * create) or has no working file. Any Git failure, or a committed entry that is not a regular file (a symlink or a
 * submodule), is `undetermined`: fail closed, never assumed stable.
 */
async function blobDiffersFromWorking(git: GitClient, root: string, path: string, signal?: AbortSignal): Promise<"equal" | "differs" | "absent" | "undetermined"> {
  const options = { cwd: root, ...(signal ? { signal } : {}) };
  const tree = await git.run(["ls-tree", "-z", "--full-tree", "HEAD", "--", path], options).catch(() => undefined);
  if (tree === undefined || tree.exitCode !== 0) return "undetermined";
  const entry = tree.stdout.split("\0").find(line => line.length > 0);
  if (entry === undefined) return "absent";                             // not in HEAD: a create, byte-safe at apply
  const committed = /^(100644|100755) blob ([0-9a-f]{40}|[0-9a-f]{64})\t/u.exec(entry);
  if (committed === null) return "undetermined";                        // a symlink, submodule or unexpected entry
  if (await stat(join(root, ...path.split("/"))).then(s => !s.isFile(), () => true)) return "absent"; // no working file to transform
  const working = await git.run(["hash-object", "--no-filters", "--", path], options).catch(() => undefined);
  if (working === undefined || working.exitCode !== 0) return "undetermined";
  return working.stdout.trim() === committed[2] ? "equal" : "differs";
}

const UNSPECIFIED: PathAttributes = Object.freeze({ text: "unspecified", eol: "unspecified", filter: "unspecified", workingTreeEncoding: "unspecified" });
const ATTR_KEYS = ["text", "eol", "filter", "working-tree-encoding"] as const;

/** Runs one `git check-attr -z` for all paths and parses its NUL-separated `<path>\0<attr>\0<info>\0` triples. */
async function readAttributes(git: GitClient, root: string, paths: readonly string[], signal?: AbortSignal):
  Promise<Map<string, PathAttributes> | undefined> {
  const result = await git.run(["check-attr", "-z", ...ATTR_KEYS, "--", ...paths], { cwd: root, ...(signal ? { signal } : {}) }).catch(() => undefined);
  if (result === undefined || result.exitCode !== 0) return undefined;
  const fields = result.stdout.split("\0");
  const map = new Map<string, { text: string; eol: string; filter: string; workingTreeEncoding: string }>();
  const keyOf: Record<string, keyof PathAttributes> = { text: "text", eol: "eol", filter: "filter", "working-tree-encoding": "workingTreeEncoding" };
  for (let i = 0; i + 2 < fields.length || (i + 2 === fields.length && fields[i] !== undefined && fields[i] !== ""); i += 3) {
    const path = fields[i], attr = fields[i + 1], info = fields[i + 2];
    if (path === undefined || attr === undefined || info === undefined || path === "") break;
    const entry = map.get(path) ?? { text: "unspecified", eol: "unspecified", filter: "unspecified", workingTreeEncoding: "unspecified" };
    const key = keyOf[attr];
    if (key !== undefined) entry[key] = info;
    map.set(path, entry);
  }
  return map;
}

/** A specific, human-readable refusal naming the offending paths and the transform Git would apply (bounded, no content). */
export function describeCheckoutTransform(stability: CheckoutStability): string {
  const shown = stability.transforms.slice(0, 8);
  const list = shown.map(t => `${t.path} (${t.detail})`).join("; ");
  const more = stability.transforms.length > shown.length ? ` and ${stability.transforms.length - shown.length} more` : "";
  return `${list}${more} use Git checkout transformations (core.autocrlf/text/eol/filter/working-tree-encoding). ` +
    "Fusion v0.6 requires byte-stable checkout semantics for Writer delivery/apply: set `core.autocrlf=false`, or add a " +
    "`.gitattributes` rule such as `eol=lf` (or `-text` for binary) for these paths, so the working-tree bytes equal the committed bytes.";
}
