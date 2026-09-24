import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { failWith } from "../../core/errors.js";
import { readBoundedFile } from "../fs/bounded-read.js";
import { parseStrictJson, StrictJsonError } from "../process/strict-json.js";

/**
 * Backend-neutral dependency policy for confined verification (V0.1: a RESTRICTED npm lane). Verification itself never
 * has network access, so dependencies are prepared in a separate stage and consumed as an immutable, identity-bound
 * artifact. This module decides WHICH projects are eligible and WHAT the artifact's identity is; it runs nothing.
 *
 * Eligibility (every rule fails closed with a stable code):
 *  - exactly `package.json` + `package-lock.json` (lockfileVersion 2 or 3) at the candidate root; `npm-shrinkwrap.json`
 *    and npm workspaces are unsupported;
 *  - every installed package resolves to `https://registry.npmjs.org/…​.tgz` with a single `sha512` integrity (bundled
 *    `inBundle` entries are covered by their parent's integrity); no `file:`, `link:`, git, GitHub, http(s) tarball
 *    or workspace specs; no `link: true` entries;
 *  - lifecycle scripts NEVER run (`--ignore-scripts`, also for the root package). A package that declares install
 *    scripts (`hasInstallScript`, which includes native `binding.gyp` builds) is refused unless the host explicitly
 *    acknowledges running it WITHOUT its script; acknowledgement never makes the script run;
 *  - the candidate's manifests must hash to the host-APPROVED identity. A Writer's own dependency change therefore
 *    cannot authorize the environment it would be verified in.
 */
export type DependencyRequirement =
  | Readonly<{ kind: "none" }>
  | Readonly<{
    kind: "npm-lockfile";
    /** Hashes of the manifests the host approved (typically the committed base), never derived from the candidate. */
    approved: Readonly<{ packageJsonSha256: string; lockfileSha256: string }>;
    /** Package names the host accepts running without their (never executed) install scripts. */
    acknowledgedInstallScripts?: readonly string[];
  }>;
export type DependencyKind = Exclude<DependencyRequirement["kind"], "none">;

export const NPM_REGISTRY = "https://registry.npmjs.org/";
export const NPM_POLICY_VERSION = 1;
/** The fixed npm argv of the preparation stage. No flag comes from a repository, task or model. */
export const NPM_CI_ARGS = Object.freeze(["ci", "--ignore-scripts", "--no-bin-links", "--no-audit", "--no-fund",
  "--include=dev", `--registry=${NPM_REGISTRY}`, "--cache=/fusion/work/npm-cache", "--userconfig=/fusion/work/home/.npmrc-none",
  "--globalconfig=/fusion/work/home/.npmrc-global-none", "--update-notifier=false", "--install-links=false", "--strict-ssl=true",
  "--loglevel=warn", "--no-progress"]);
export const NPM_MANIFEST_LIMITS = Object.freeze({ maxPackageJsonBytes: 1024 * 1024, maxLockfileBytes: 32 * 1024 * 1024,
  maxPackages: 20_000 });
/** Root files whose change is a dependency change; a ChangeSet touching one cannot self-approve its environment. */
export const DEPENDENCY_CONTROL_FILES = Object.freeze(["package.json", "package-lock.json", "npm-shrinkwrap.json", ".npmrc",
  "yarn.lock", ".yarnrc", ".yarnrc.yml", "pnpm-lock.yaml", "pnpm-workspace.yaml", ".pnpmfile.cjs", "bun.lock", "bun.lockb"]);
const ROOT_LIFECYCLE = ["preinstall", "install", "postinstall", "prepublish", "preprepare", "prepare", "postprepare"];

export class DependencyPolicyError extends Error {
  constructor(readonly code: string, readonly detail: readonly string[] = []) { super(code); this.name = "DependencyPolicyError"; }
}
const refuse = (code: string, detail: readonly string[] = []): never => { throw new DependencyPolicyError(code, detail); };

const SHA256 = /^[0-9a-f]{64}$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/u;
const NAME = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]{0,213}\/)?[A-Za-z0-9][A-Za-z0-9._~-]{0,213}$/u;
/** Dependency specs that bypass the registry (or name another package manager's protocol). */
const NON_REGISTRY_SPEC = /^(?:file|link|git|git\+[a-z]+|github|gitlab|bitbucket|gist|https?|workspace|portal|patch|exec|catalog):/iu;
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export const sha256Hex = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

function strict(bytes: Buffer, what: string): Record<string, unknown> {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return refuse(`${what}-not-utf8`); }
  let value: unknown;
  try { value = parseStrictJson(text.replace(/^﻿/u, ""), 64); }
  catch (error) { if (error instanceof StrictJsonError) return refuse(`${what}-invalid-json`); throw error; }
  if (!isRecord(value)) refuse(`${what}-not-object`);
  return value as Record<string, unknown>;
}

function registryTarball(resolved: unknown): boolean {
  if (typeof resolved !== "string" || resolved.length > 2048 || !resolved.startsWith(NPM_REGISTRY)) return false;
  let url: URL;
  try { url = new URL(resolved); } catch { return false; }
  // The raw text must already be canonical: URL parsing silently resolves `..`/`.` and case, which must never launder a path.
  return url.href === resolved && url.protocol === "https:" && url.host === "registry.npmjs.org" && url.username === "" && url.password === "" &&
    url.search === "" && url.hash === "" && url.pathname.endsWith(".tgz") && !url.pathname.split("/").includes("..") &&
    !/%2e%2e|%2f|%5c/iu.test(url.pathname);
}

/** `node_modules/a/node_modules/@s/b` → the package names along the path, or undefined when malformed. */
function installPath(key: string): string[] | undefined {
  if (!key.startsWith("node_modules/")) return undefined;
  const names = key.slice("node_modules/".length).split("/node_modules/");
  return names.every(name => NAME.test(name) && !name.split("/").some(part => part === "." || part === "..")) ? names : undefined;
}

export interface NpmManifestReport {
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  readonly lockfileVersion: 2 | 3;
  readonly packages: number;
  /** Packages declaring install scripts; they are installed WITHOUT running them (acknowledged by the host). */
  readonly installScriptPackages: readonly string[];
  /** Root lifecycle scripts present in package.json; never executed by the preparation stage. */
  readonly skippedRootScripts: readonly string[];
}

/** Validates the two manifests against the restricted lane. Pure: bytes in, report or `DependencyPolicyError` out. */
export function validateNpmManifests(packageJson: Buffer, lockfile: Buffer,
  acknowledgedInstallScripts: readonly string[] = []): NpmManifestReport {
  if (packageJson.length > NPM_MANIFEST_LIMITS.maxPackageJsonBytes) refuse("package-json-too-large");
  if (lockfile.length > NPM_MANIFEST_LIMITS.maxLockfileBytes) refuse("lockfile-too-large");
  const pkg = strict(packageJson, "package-json"), lock = strict(lockfile, "lockfile");
  if (Object.hasOwn(pkg, "workspaces")) refuse("workspaces-unsupported");
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const specs = pkg[field];
    if (specs === undefined) continue;
    if (!isRecord(specs)) refuse("package-json-dependencies-invalid");
    for (const [name, spec] of Object.entries(specs as Record<string, unknown>)) {
      if (!NAME.test(name) || typeof spec !== "string" || spec.length > 256) refuse("package-json-dependencies-invalid");
      const bare = (spec as string).startsWith("npm:") ? (spec as string).slice(4) : spec as string;
      if (NON_REGISTRY_SPEC.test(bare) || bare.includes("/") && !/^@[^/]+\/[^/@]+@/u.test(bare))
        refuse("non-registry-dependency", [name]);
    }
  }
  const version = lock.lockfileVersion;
  if (version !== 2 && version !== 3) refuse("lockfile-version-unsupported");
  const packages = lock.packages;
  if (!isRecord(packages) || !isRecord(packages[""])) refuse("lockfile-packages-missing");
  const entries = Object.entries(packages as Record<string, unknown>);
  if (entries.length - 1 > NPM_MANIFEST_LIMITS.maxPackages) refuse("lockfile-too-many-packages");
  if (Object.hasOwn((packages as Record<string, Record<string, unknown>>)[""]!, "workspaces")) refuse("workspaces-unsupported");
  const acknowledged = new Set(acknowledgedInstallScripts);
  const scripted = new Set<string>();
  for (const [key, raw] of entries) {
    if (key === "") continue;
    const names = installPath(key);
    if (names === undefined || !isRecord(raw)) refuse("lockfile-entry-invalid");
    const entry = raw as Record<string, unknown>;
    if (entry.link === true) refuse("linked-package-unsupported");
    if (typeof entry.version !== "string" || entry.version.length > 256) refuse("lockfile-entry-invalid");
    if (entry.inBundle === true) {
      // Bundled inside its parent's tarball, whose integrity covers it; the parent must itself be installed here.
      const cut = key.lastIndexOf("/node_modules/");
      if (cut <= 0 || !Object.hasOwn(packages as object, key.slice(0, cut))) refuse("lockfile-entry-invalid");
    } else {
      if (!registryTarball(entry.resolved)) refuse("non-registry-resolved", [names!.at(-1)!]);
      if (typeof entry.integrity !== "string" || !INTEGRITY.test(entry.integrity)) refuse("integrity-missing-or-weak", [names!.at(-1)!]);
    }
    if (entry.hasInstallScript === true) scripted.add(typeof entry.name === "string" && NAME.test(entry.name) ? entry.name : names!.at(-1)!);
  }
  const unacknowledged = [...scripted].filter(name => !acknowledged.has(name)).sort();
  if (unacknowledged.length > 0) refuse("install-scripts-unacknowledged", unacknowledged.slice(0, 32));
  const scripts = isRecord(pkg.scripts) ? pkg.scripts : {};
  return Object.freeze({ packageJsonSha256: sha256Hex(packageJson), lockfileSha256: sha256Hex(lockfile),
    lockfileVersion: version as 2 | 3, packages: entries.length - 1, installScriptPackages: Object.freeze([...scripted].sort()),
    skippedRootScripts: Object.freeze(ROOT_LIFECYCLE.filter(name => Object.hasOwn(scripts, name))) });
}

export interface NpmManifests {
  readonly packageJson: Buffer;
  readonly lockfile: Buffer;
}
/** Reads the candidate root's manifests: regular files only (never a link), bounded. */
export async function readNpmManifests(root: string): Promise<NpmManifests> {
  const read = async (name: string, max: number): Promise<Buffer> => {
    const path = join(root, name);
    const info = await lstat(path).catch(() => refuse(`${name === "package.json" ? "package-json" : "lockfile"}-missing`));
    if (info.isSymbolicLink() || !info.isFile()) refuse("manifest-not-regular-file");
    return readBoundedFile(path, max).catch(() => refuse("manifest-unreadable"));
  };
  if (await lstat(join(root, "npm-shrinkwrap.json")).then(() => true, () => false)) refuse("shrinkwrap-unsupported");
  return Object.freeze({ packageJson: await read("package.json", NPM_MANIFEST_LIMITS.maxPackageJsonBytes),
    lockfile: await read("package-lock.json", NPM_MANIFEST_LIMITS.maxLockfileBytes) });
}

/** Everything that determines a prepared dependency tree. Its canonical hash is the cache key. */
export interface DependencyIdentity {
  readonly schemaVersion: 1;
  readonly manager: "npm";
  readonly policyVersion: typeof NPM_POLICY_VERSION;
  readonly packageJsonSha256: string;
  readonly lockfileSha256: string;
  /** Digest-pinned image (fixes the Node and npm versions) and the engine's OS/architecture. */
  readonly runtime: Readonly<{ image: string; os: string; arch: string }>;
  readonly npmArgs: readonly string[];
  readonly acknowledgedInstallScripts: readonly string[];
}
export function dependencyIdentity(report: Pick<NpmManifestReport, "packageJsonSha256" | "lockfileSha256">,
  runtime: DependencyIdentity["runtime"], acknowledgedInstallScripts: readonly string[] = []): DependencyIdentity {
  if (!SHA256.test(report.packageJsonSha256) || !SHA256.test(report.lockfileSha256))
    failWith("InvalidInput", "Dependency identity needs manifest digests.");
  // Fixed key order: the JSON text is canonical, so equal identities always hash equally.
  return Object.freeze({ schemaVersion: 1, manager: "npm", policyVersion: NPM_POLICY_VERSION,
    packageJsonSha256: report.packageJsonSha256, lockfileSha256: report.lockfileSha256,
    runtime: Object.freeze({ image: runtime.image, os: runtime.os, arch: runtime.arch }), npmArgs: NPM_CI_ARGS,
    acknowledgedInstallScripts: Object.freeze([...new Set(acknowledgedInstallScripts)].sort()) });
}
export const dependencyIdentityKey = (identity: DependencyIdentity): string =>
  sha256Hex(Buffer.from(JSON.stringify(identity), "utf8"));

/** Fails closed unless the candidate's manifests are exactly the host-approved ones. */
export function assertApprovedManifests(manifests: NpmManifests, requirement: Extract<DependencyRequirement, { kind: "npm-lockfile" }>): void {
  const approved = requirement.approved;
  if (!isRecord(approved) || !SHA256.test(approved.packageJsonSha256) || !SHA256.test(approved.lockfileSha256))
    refuse("approved-identity-invalid");
  if (sha256Hex(manifests.packageJson) !== approved.packageJsonSha256 || sha256Hex(manifests.lockfile) !== approved.lockfileSha256)
    refuse("manifests-not-approved");
}

/** Typed failure for the verification layer (codes are stable and path-free). */
export function dependencyFailure(error: unknown): never {
  if (!(error instanceof DependencyPolicyError)) throw error;
  const detail = error.detail.length > 0 ? ` (${error.detail.join(", ")})` : "";
  const kind = error.code === "manifests-not-approved" || error.code === "non-registry-resolved" ||
    error.code === "non-registry-dependency" || error.code === "linked-package-unsupported" ? "SecurityViolation" : "CapabilityUnavailable";
  return failWith(kind, `Dependency lane refused the project: ${error.code}${detail}.`);
}
