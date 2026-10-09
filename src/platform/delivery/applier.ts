import { randomBytes } from "node:crypto";
import { constants, copyFile, link, lstat, mkdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DeliveryRecord, DeliveryTerminalState } from "../../core/delivery/approval.js";
import { validateDeliveryBundle, type DeliveryBundle } from "../../core/delivery/bundle.js";
import { sha256Hex } from "../../core/delivery/canonical.js";
import { deliveryManifestSha256, deliveryPathKey, platformFamily, validateDeliveryManifest, type DeliveryManifest,
  type DeliveryManifestOperation } from "../../core/delivery/manifest.js";
import { FusionFailure } from "../../core/errors.js";
import { isContainedPath } from "../events/shared.js";
import { comparablePath, type GitClient } from "../workspace/git.js";

/**
 * O5.5C1 — the DELIVERY APPLIER: writes an APPROVED delivery's exact bytes into a primary checkout, in five phases.
 *
 *  1. PRECHECK (reads only): the manifest re-validated and its digest equal to the approval's; the bundle re-validated
 *     against it (every content digest recomputed); the required forbidden paths present; the platform family; the primary
 *     is a Git work-tree root without filter drivers (Git could otherwise run repository-configured commands); its
 *     repository identity, HEAD and HEAD tree are the manifest's; its working tree is clean (v0.1: no staged, unstaged
 *     or untracked change anywhere); and every touched path is contained, reached through real directories only, not
 *     ignored, and exactly its precondition (absent, or a regular file — never a link or reparse point — with the exact
 *     preimage digest). Every operation is checked before anything is written.
 *  2. STAGE: the post-images are written into Fusion-owned staging inside the repository's Git directory (same volume as
 *     the work tree, outside it) and read back against their digests.
 *  3. APPLY: only the manifest's operations, in order, each re-checked against its precondition right before it runs:
 *     create = exclusive hard link (never replaces), update = backup copy, then rename over the target, delete = rename
 *     into the backup. A journal records each step. No provider, model, shell or network is involved; Git runs only
 *     read-only commands with hooks and fsmonitor disabled.
 *  4. POSTCHECK: every touched path has exactly its post-image (or is absent); `git status` shows no path but the touched
 *     ones; HEAD is unchanged.
 *  5. ROLLBACK (on any failure after the first write): each touched path restored from its backup (or removed, for a
 *     create) in reverse order and verified against its preimage. Every restored and verified: `rolledBack`; any not:
 *     `rollbackFailed`, and the staging (with the backups) is kept for recovery.
 *
 * The guarantee is NOT a multi-file transaction: full prevalidation, per-file atomic replacement where the filesystem
 * provides it (rename within one volume), and a journaled, verified rollback. A crash of the whole process between two
 * operations leaves the journal and backups in the staging directory; no automatic crash recovery exists yet.
 */
export type DeliveryPhase = "precheck" | "stage" | "apply" | "postcheck" | "rollback" | "done";
export type DeliveryIssueReason = "manifestInvalid" | "manifestDigestMismatch" | "bundleInvalid" | "forbiddenPathsMissing" | "platformMismatch" |
  "notRepositoryRoot" | "filterDriverConfigured" | "repositoryMismatch" | "headMoved" | "baseTreeMismatch" | "dirtyTree" | "outsideWorkspace" |
  "parentNotDirectory" | "notRegularFile" | "fileChanged" | "fileAppeared" | "fileMissing" | "tooLarge" | "ignoredPath" | "stagingFailed" |
  "applyFailed" | "postcheckFailed" | "undeclaredChange" | "restoreFailed" | "evidenceUnrecorded" | "foreignModification" | "recoveryRequired";
export interface DeliveryIssue {
  readonly reason: DeliveryIssueReason;
  readonly path?: string;
  /** v0.6: sanitized drift detail for `fileChanged` — digests, sizes and an EOL-only flag; never file content. */
  readonly expectedSha256?: string;
  readonly observedSha256?: string;
  readonly expectedBytes?: number;
  readonly observedBytes?: number;
  /** True only when a bounded byte comparison proves the sole difference is CRLF↔LF (still a refusal). */
  readonly eolOnlyMismatch?: boolean;
}
type IssueDetail = Omit<DeliveryIssue, "reason" | "path">;
type IssueFn = (reason: DeliveryIssueReason, path?: string, detail?: IssueDetail) => void;
/** CRLF→LF normalization for a bounded EOL-only comparison (never written anywhere; drops a CR only before a LF). */
function stripCr(raw: Buffer): Buffer {
  const out = Buffer.allocUnsafe(raw.length);
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 0x0d && i + 1 < raw.length && raw[i + 1] === 0x0a) continue;
    out[n++] = raw[i]!;
  }
  return out.subarray(0, n);
}
export interface DeliveryOperationEvidence {
  readonly index: number;
  readonly kind: DeliveryManifestOperation["kind"];
  readonly path: string;
  readonly applied: boolean;
  /** `null`: no rollback ran; otherwise whether this path was restored to its verified preimage. */
  readonly restored: boolean | null;
}
/** Bounded, content-free evidence: identities, digests, labels, counts and repository-relative paths only. */
export interface DeliveryEvidence {
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly approval: Readonly<{ origin: string; approver: string }>;
  readonly phases: readonly Readonly<{ phase: DeliveryPhase; ok: boolean; ms: number }>[];
  readonly operations: readonly DeliveryOperationEvidence[];
  readonly issues: readonly DeliveryIssue[];
  /** Git subcommands the applier ran (all read-only). */
  readonly gitCommands: readonly string[];
  readonly staging: Readonly<{ location: "gitDirectory"; retained: boolean }>;
  readonly leftoverDirectories: number;
  /** The primary's HEAD as the precheck observed it (`null` when the precheck never read it). */
  readonly observedHead: string | null;
}
export interface DeliveryOutcome {
  readonly state: DeliveryTerminalState;
  /** The phase that decided the outcome. */
  readonly phase: DeliveryPhase;
  readonly issues: readonly DeliveryIssue[];
  readonly evidence: DeliveryEvidence;
}
export interface DeliveryApplier {
  apply(record: DeliveryRecord, primaryRoot: string, signal?: AbortSignal): Promise<DeliveryOutcome>;
}
/** TEST SEAM: failures injected at named points. Never set by a production composition. */
export interface DeliveryFaults {
  afterOperation?(index: number): void | Promise<void>;
  beforeRestore?(index: number): void | Promise<void>;
  beforePostcheck?(primaryRoot: string): void | Promise<void>;
}
export interface LocalDeliveryApplierOptions {
  readonly git: GitClient;
  /** Paths every manifest must forbid: the registered providers' workspace state paths (the composition supplies them). */
  readonly requiredForbiddenPaths: readonly string[];
  readonly faults?: DeliveryFaults;
  /**
   * O5.5C2: told when the precheck starts and how it ended, before any write — the delivery store records these events.
   * If it throws, the delivery fails before any write (evidence that cannot be recorded never precedes a mutation).
   */
  readonly observer?: (event: Readonly<{ phase: "precheck"; status: "started" | "passed" | "failed"; observedHead: string | null }>) => void | Promise<void>;
  readonly platform?: string;
}

const MAX_ISSUES = 64;
interface TargetState { readonly exists: boolean; readonly sha256: string | null; readonly regular: boolean; readonly size: number }
interface Step { readonly op: DeliveryManifestOperation; readonly target: string; createdDirectories: string[]; backup?: string; mutated: boolean;
  restored: boolean | null }

/** The primary's identity as a delivery pins it: the repository (its sorted root commits), HEAD and HEAD's tree. */
export async function readPrimaryIdentity(primaryRoot: string, git: GitClient, signal?: AbortSignal):
  Promise<Readonly<{ repositoryIdentity: string; headCommit: string; headTree: string }>> {
  const run = async (args: string[]): Promise<string> => {
    const result = await git.run(args, { cwd: primaryRoot, ...(signal ? { signal } : {}) });
    if (result.exitCode !== 0) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The primary is not a readable Git repository." });
    return result.stdout.trim();
  };
  const roots = (await run(["rev-list", "--max-parents=0", "HEAD"])).split(/\r?\n/u).filter(Boolean).sort();
  return Object.freeze({ repositoryIdentity: sha256Hex(roots.join("\n")), headCommit: await run(["rev-parse", "--verify", "--quiet", "HEAD"]),
    headTree: await run(["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]) });
}

async function targetState(path: string): Promise<TargetState> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined) return { exists: false, sha256: null, regular: false, size: 0 };
  const regular = info.isFile() && !info.isSymbolicLink();
  return { exists: true, regular, size: info.size, sha256: regular ? sha256Hex(await readFile(path)) : null };
}
const matchesBefore = (state: TargetState, op: DeliveryManifestOperation): boolean =>
  op.beforeSha256 === null ? !state.exists : state.exists && state.regular && state.sha256 === op.beforeSha256;
const matchesAfter = (state: TargetState, op: DeliveryManifestOperation): boolean =>
  op.afterSha256 === null ? !state.exists : state.exists && state.regular && state.sha256 === op.afterSha256 && state.size === op.afterBytes;

export class LocalFilesystemDeliveryApplier implements DeliveryApplier {
  constructor(private readonly options: LocalDeliveryApplierOptions) {}

  async apply(record: DeliveryRecord, primaryRoot: string, signal?: AbortSignal): Promise<DeliveryOutcome> {
    // Only an approved record ever starts; this consumes its approval (a refused record stays exactly as it was).
    const approval = record.beginApplying();
    const phases: Array<{ phase: DeliveryPhase; ok: boolean; ms: number }> = [];
    const gitCommands: string[] = [];
    const issues: DeliveryIssue[] = [];
    const issue: IssueFn = (reason, path, detail) => {
      if (issues.length < MAX_ISSUES) issues.push(Object.freeze({ reason, ...(path !== undefined ? { path } : {}), ...(detail ?? {}) }));
    };
    const steps: Step[] = [];
    let staging: string | undefined, retained = false, leftoverDirectories = 0, bundleSha256 = record.manifest.change.bundleSha256;
    const git = async (root: string, args: string[]) => {
      gitCommands.push(args[0]!);
      return this.options.git.run(args, { cwd: root, ...(signal ? { signal } : {}) });
    };
    const timed = async <T>(phase: DeliveryPhase, work: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      try { const value = await work(); phases.push({ phase, ok: true, ms: Date.now() - started }); return value; }
      catch (error) { phases.push({ phase, ok: false, ms: Date.now() - started }); throw error; }
    };
    const finish = async (state: DeliveryTerminalState, phase: DeliveryPhase): Promise<DeliveryOutcome> => {
      if (staging !== undefined && !retained) await rm(staging, { recursive: true, force: true }).catch(() => { retained = true; });
      record.finish(state);
      const evidence: DeliveryEvidence = Object.freeze({ deliveryId: record.manifest.deliveryId, manifestSha256: record.manifestSha256, bundleSha256,
        approval: Object.freeze({ origin: approval.origin, approver: approval.approver }), phases: Object.freeze(phases.map(p => Object.freeze(p))),
        operations: Object.freeze(record.manifest.operations.map(op => {
          const step = steps.find(s => s.op.index === op.index);
          return Object.freeze({ index: op.index, kind: op.kind, path: op.path, applied: step?.mutated === true, restored: step?.restored ?? null });
        })), issues: Object.freeze([...issues]), gitCommands: Object.freeze([...gitCommands]),
        staging: Object.freeze({ location: "gitDirectory" as const, retained: staging !== undefined && retained }), leftoverDirectories, observedHead });
      return Object.freeze({ state, phase, issues: evidence.issues, evidence });
    };

    let observedHead: string | null = null;
    const notify = async (status: "started" | "passed" | "failed"): Promise<boolean> => {
      try { await this.options.observer?.({ phase: "precheck", status, observedHead }); return true; }
      catch { issue("evidenceUnrecorded"); return false; }
    };
    if (!await notify("started")) return finish("failed", "precheck");
    // 1. PRECHECK — nothing is written until every check of every operation passed.
    let manifest: DeliveryManifest, bundle: DeliveryBundle, root: string;
    try {
      ({ manifest, bundle, root } = await timed("precheck", async () => {
        let manifest: DeliveryManifest;
        try { manifest = validateDeliveryManifest(record.manifest); } catch { issue("manifestInvalid"); throw new PrecheckStop(); }
        const digest = deliveryManifestSha256(manifest);
        if (digest !== record.manifestSha256 || digest !== approval.manifestSha256 || approval.deliveryId !== manifest.deliveryId) {
          issue("manifestDigestMismatch"); throw new PrecheckStop();
        }
        let bundle: DeliveryBundle;
        try { bundle = validateDeliveryBundle(record.bundle, manifest); } catch { issue("bundleInvalid"); throw new PrecheckStop(); }
        const forbidden = new Set(manifest.safety.forbiddenPaths.map(deliveryPathKey));
        if (this.options.requiredForbiddenPaths.some(path => !forbidden.has(deliveryPathKey(path)))) issue("forbiddenPathsMissing");
        if (manifest.safety.platform !== platformFamily(this.options.platform)) issue("platformMismatch");
        const root = await realpath(primaryRoot).catch(() => undefined);
        if (root === undefined) { issue("notRepositoryRoot"); throw new PrecheckStop(); }
        const top = await git(root, ["rev-parse", "--show-toplevel"]);
        const topReal = top.exitCode === 0 ? await realpath(top.stdout.trim()).catch(() => undefined) : undefined;
        if (topReal === undefined || comparablePath(topReal) !== comparablePath(root)) { issue("notRepositoryRoot"); throw new PrecheckStop(); }
        // A configured filter driver would let `git status` run a repository-defined command: refused (v0.1).
        // Exit 1 means "no such key"; anything else but a clean empty answer fails closed.
        const filters = await git(root, ["config", "--includes", "-z", "--get-regexp", "^filter\\."]);
        if (filters.exitCode !== 1) issue("filterDriverConfigured");
        const identity = await readPrimaryIdentity(root, { run: (args, options) => { gitCommands.push(args[0]!); return this.options.git.run(args, options); } }, signal)
          .catch(() => undefined);
        observedHead = identity?.headCommit ?? null;
        if (identity === undefined || identity.repositoryIdentity !== manifest.primary.repositoryIdentity) issue("repositoryMismatch");
        if (identity?.headCommit !== manifest.primary.baseCommit) issue("headMoved");
        if (identity?.headTree !== manifest.primary.baseTree) issue("baseTreeMismatch");
        if (issues.some(i => i.reason === "filterDriverConfigured")) throw new PrecheckStop();
        const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]);
        if (status.exitCode !== 0 || status.stdout.length > 0) issue("dirtyTree");
        // Exit 0 lists the ignored paths, one per line (a delivery path holds no newline or quote, and quotePath is off; `-z`
        // needs stdin), exit 1 means none is ignored; anything else fails closed.
        const ignored = await git(root, ["check-ignore", "--", ...manifest.operations.map(op => op.path)]);
        if (ignored.exitCode !== 0 && ignored.exitCode !== 1) issue("ignoredPath");
        for (const path of ignored.exitCode === 0 ? ignored.stdout.split(/\r?\n/u).filter(Boolean) : []) issue("ignoredPath", path);
        for (const op of manifest.operations) await this.#checkTarget(root, op, manifest, issue);
        if (issues.length > 0) throw new PrecheckStop();
        return { manifest, bundle, root };
      }));
    } catch (error) {
      if (!(error instanceof PrecheckStop)) issue("manifestInvalid");
      await notify("failed");
      return finish("failed", "precheck");
    }
    if (!await notify("passed")) return finish("failed", "precheck");
    bundleSha256 = manifest.change.bundleSha256;

    // 2. STAGE — the post-images in Fusion-owned staging inside the Git directory, read back against their digests.
    try {
      await timed("stage", async () => {
        const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
        if (gitDir.exitCode !== 0) throw new Error("git directory");
        const parent = join(await realpath(gitDir.stdout.trim()), "fusion-delivery");
        await mkdir(parent, { recursive: true });
        staging = join(parent, `${manifest.deliveryId}.${randomBytes(6).toString("hex")}`);
        await mkdir(staging);
        await mkdir(join(staging, "stage"));
        await mkdir(join(staging, "backup"));
        for (const entry of bundle.entries) {
          const staged = join(staging, "stage", String(entry.index));
          await writeFile(staged, entry.content, { flag: "wx" });
          if (sha256Hex(await readFile(staged)) !== entry.sha256) throw new Error("staged digest");
        }
        await this.#journal(staging, manifest, steps, "staged");
      });
    } catch {
      issue("stagingFailed");
      return finish("failed", "stage");
    }

    // 3. APPLY — only the manifest's operations, each re-checked right before it runs; any failure rolls back.
    let failedAt: DeliveryPhase | undefined;
    try {
      await timed("apply", async () => {
        for (const op of manifest.operations) {
          if (signal?.aborted) throw new Error("cancelled");
          const target = join(root, ...op.path.split("/"));
          if (!matchesBefore(await targetState(target), op)) { issue("fileChanged", op.path); throw new Error("drift"); }
          const step: Step = { op, target, createdDirectories: [], mutated: false, restored: null };
          steps.push(step);
          const staged = join(staging!, "stage", String(op.index)), backup = join(staging!, "backup", String(op.index));
          if (op.kind === "create") {
            await createParents(root, op.path.split("/").slice(0, -1), step.createdDirectories);
            step.mutated = true;
            await placeExclusive(staged, target);
          } else if (op.kind === "update") {
            await copyFile(target, backup, constants.COPYFILE_EXCL);
            step.backup = backup;
            if (sha256Hex(await readFile(backup)) !== op.beforeSha256) throw new Error("backup digest");
            step.mutated = true;
            await moveReplacing(staged, target);
          } else {
            step.backup = backup;
            step.mutated = true;
            await moveReplacing(target, backup);
            if (sha256Hex(await readFile(backup)) !== op.beforeSha256) throw new Error("backup digest");
          }
          await this.#journal(staging!, manifest, steps, "applying");
          await this.options.faults?.afterOperation?.(op.index);
        }
      });
    } catch {
      if (!issues.some(i => i.reason === "fileChanged")) issue("applyFailed");
      failedAt = "apply";
    }

    // 4. POSTCHECK — every touched path is its post-image; Git sees no other change; HEAD did not move.
    if (failedAt === undefined) {
      try {
        await timed("postcheck", async () => {
          await this.options.faults?.beforePostcheck?.(root);
          for (const step of steps) if (!matchesAfter(await targetState(step.target), step.op)) issue("postcheckFailed", step.op.path);
          const declared = new Set(manifest.operations.map(op => deliveryPathKey(op.path)));
          const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]);
          if (status.exitCode !== 0) issue("postcheckFailed");
          for (const entry of status.stdout.split("\0").filter(Boolean)) {
            const path = entry.slice(3);
            if (!declared.has(deliveryPathKey(path))) issue("undeclaredChange", path);
          }
          const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
          if (head.stdout.trim() !== manifest.primary.baseCommit) issue("headMoved");
          if (issues.length > 0) throw new Error("postcheck");
        });
      } catch {
        if (issues.length === 0) issue("postcheckFailed");
        failedAt = "postcheck";
      }
    }
    if (failedAt === undefined) {
      await this.#journal(staging!, manifest, steps, "applied");
      return finish("applied", "done");
    }

    // 5. ROLLBACK — in reverse, each touched path back to its verified preimage.
    let restoredAll = true;
    await timed("rollback", async () => {
      for (const step of [...steps].reverse()) {
        try {
          await this.options.faults?.beforeRestore?.(step.op.index);
          if (step.op.kind === "create") {
            const state = await targetState(step.target);
            if (state.exists) await unlink(step.target);
            for (const directory of [...step.createdDirectories].reverse())
              await rmdir(directory).catch(() => { leftoverDirectories++; });
          } else if (step.backup !== undefined) {
            const state = await targetState(step.target);
            if (!matchesBefore(state, step.op) && (await targetState(step.backup)).exists) await moveReplacing(step.backup, step.target);
          }
          step.restored = matchesBefore(await targetState(step.target), step.op);
        } catch { step.restored = false; }
        if (!step.restored) { restoredAll = false; issue("restoreFailed", step.op.path); }
      }
      await this.#journal(staging!, manifest, steps, restoredAll ? "rolledBack" : "rollbackFailed");
    }).catch(() => { restoredAll = false; });
    if (!restoredAll) retained = true;
    return finish(restoredAll ? "rolledBack" : "rollbackFailed", "rollback");
  }

  /**
   * v0.6 I1 — RECOVER an INTERRUPTED apply (the delivery is durably `applying`: its single-use claim was taken and
   * `applyStarted` recorded, but no terminal event). Reconstruction is idempotent and rests only on IMMUTABLE state —
   * the manifest's before/after digests and the bundle's exact post-images (both revalidated) — plus the current target
   * files. It never depends on the ephemeral staging directory of the crashed process, so a fresh process can always
   * reconstruct.
   *
   * Fresh precheck (§44): repository identity, HEAD and tree unchanged, no filter drivers. Then, per file, classify the
   * CURRENT content against its before/after image:
   *  - any file that is NEITHER its before- nor its after-image → FOREIGN_MODIFICATION: nothing is written, the human
   *    decides (§43); the foreign content is never overwritten.
   *  - every file already at its after-image → the writes completed before the crash; verify and finish COMMITTED.
   *  - otherwise resume FORWARD: for each not-yet-applied file, re-check its before-image (a foreign change stops the
   *    run) and write the bundle's exact post-image (atomic rename / move-aside for a delete). Idempotent: an
   *    already-applied file is skipped. Then postcheck and finish `applied`.
   * The single-use claim is NOT re-taken (recovery completes the SAME claimed transaction); a NEW apply of a consumed
   * claim stays refused by the store. Terminology is accurate: a durable, recoverable local apply, not multi-file ACID.
   */
  async recover(record: DeliveryRecord, primaryRoot: string, signal?: AbortSignal): Promise<DeliveryOutcome> {
    const approval = record.beginApplying(); // in-memory approved -> applying, mirroring the persisted `applying`
    const phases: Array<{ phase: DeliveryPhase; ok: boolean; ms: number }> = [];
    const gitCommands: string[] = [];
    const issues: DeliveryIssue[] = [];
    const issue: IssueFn = (reason, path, detail) => { if (issues.length < MAX_ISSUES) issues.push(Object.freeze({ reason, ...(path !== undefined ? { path } : {}), ...(detail ?? {}) })); };
    const steps: Step[] = [];
    let staging: string | undefined, retained = false, observedHead: string | null = null;
    let bundleSha256 = record.manifest.change.bundleSha256;
    const git = async (root: string, args: string[]) => { gitCommands.push(args[0]!); return this.options.git.run(args, { cwd: root, ...(signal ? { signal } : {}) }); };
    const timed = async <T>(phase: DeliveryPhase, work: () => Promise<T>): Promise<T> => {
      const started = Date.now();
      try { const value = await work(); phases.push({ phase, ok: true, ms: Date.now() - started }); return value; }
      catch (error) { phases.push({ phase, ok: false, ms: Date.now() - started }); throw error; }
    };
    const finish = async (state: DeliveryTerminalState, phase: DeliveryPhase): Promise<DeliveryOutcome> => {
      if (staging !== undefined && !retained) await rm(staging, { recursive: true, force: true }).catch(() => { retained = true; });
      record.finish(state);
      const evidence: DeliveryEvidence = Object.freeze({ deliveryId: record.manifest.deliveryId, manifestSha256: record.manifestSha256, bundleSha256,
        approval: Object.freeze({ origin: approval.origin, approver: approval.approver }), phases: Object.freeze(phases.map(p => Object.freeze(p))),
        operations: Object.freeze(record.manifest.operations.map(op => { const step = steps.find(s => s.op.index === op.index);
          return Object.freeze({ index: op.index, kind: op.kind, path: op.path, applied: step?.mutated === true, restored: step?.restored ?? null }); })),
        issues: Object.freeze([...issues]), gitCommands: Object.freeze([...gitCommands]),
        staging: Object.freeze({ location: "gitDirectory" as const, retained: staging !== undefined && retained }), leftoverDirectories: 0, observedHead });
      return Object.freeze({ state, phase, issues: evidence.issues, evidence });
    };

    let manifest: DeliveryManifest, bundle: DeliveryBundle, root: string;
    try {
      ({ manifest, bundle, root } = await timed("precheck", async () => {
        const manifest = validateDeliveryManifest(record.manifest);
        if (deliveryManifestSha256(manifest) !== record.manifestSha256 || deliveryManifestSha256(manifest) !== approval.manifestSha256) { issue("manifestDigestMismatch"); throw new PrecheckStop(); }
        const bundle = validateDeliveryBundle(record.bundle, manifest);
        const root = await realpath(primaryRoot).catch(() => undefined);
        if (root === undefined) { issue("notRepositoryRoot"); throw new PrecheckStop(); }
        const top = await git(root, ["rev-parse", "--show-toplevel"]);
        const topReal = top.exitCode === 0 ? await realpath(top.stdout.trim()).catch(() => undefined) : undefined;
        if (topReal === undefined || comparablePath(topReal) !== comparablePath(root)) { issue("notRepositoryRoot"); throw new PrecheckStop(); }
        const filters = await git(root, ["config", "--includes", "-z", "--get-regexp", "^filter\\."]);
        if (filters.exitCode !== 1) { issue("filterDriverConfigured"); throw new PrecheckStop(); }
        const identity = await readPrimaryIdentity(root, { run: (args, options) => { gitCommands.push(args[0]!); return this.options.git.run(args, options); } }, signal).catch(() => undefined);
        observedHead = identity?.headCommit ?? null;
        if (identity === undefined || identity.repositoryIdentity !== manifest.primary.repositoryIdentity) issue("repositoryMismatch");
        if (identity?.headCommit !== manifest.primary.baseCommit) issue("headMoved");
        if (identity?.headTree !== manifest.primary.baseTree) issue("baseTreeMismatch");
        if (issues.length > 0) throw new PrecheckStop();
        return { manifest, bundle, root };
      }));
    } catch { return finish("failed", "precheck"); }
    bundleSha256 = manifest.change.bundleSha256;

    // Classify each file against its before/after image; a file that is neither is a foreign modification (§43).
    const classes = new Map<number, "before" | "after" | "foreign">();
    for (const op of manifest.operations) {
      const state = await targetState(join(root, ...op.path.split("/")));
      classes.set(op.index, matchesAfter(state, op) ? "after" : matchesBefore(state, op) ? "before" : "foreign");
    }
    const foreign = manifest.operations.filter(op => classes.get(op.index) === "foreign");
    if (foreign.length > 0) { for (const op of foreign) issue("foreignModification", op.path); return finish("failed", "apply"); }
    if (manifest.operations.every(op => classes.get(op.index) === "after")) {
      // Every write completed before the crash; verify and finalize (idempotent — no writes).
      try { await timed("postcheck", async () => { await this.#postcheck(root, manifest, git, issue); if (issues.length > 0) throw new Error("postcheck"); }); }
      catch { if (issues.length === 0) issue("postcheckFailed"); return finish("failed", "postcheck"); }
      return finish("applied", "done");
    }

    // Resume forward: stage the immutable post-images from the bundle, then write only the not-yet-applied files.
    try {
      await timed("stage", async () => {
        const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
        if (gitDir.exitCode !== 0) throw new Error("git directory");
        const parent = join(await realpath(gitDir.stdout.trim()), "fusion-delivery");
        await mkdir(parent, { recursive: true });
        staging = join(parent, `${manifest.deliveryId}.recover.${randomBytes(6).toString("hex")}`);
        await mkdir(staging); await mkdir(join(staging, "stage")); await mkdir(join(staging, "backup"));
        for (const entry of bundle.entries) {
          const staged = join(staging, "stage", String(entry.index));
          await writeFile(staged, entry.content, { flag: "wx" });
          if (sha256Hex(await readFile(staged)) !== entry.sha256) throw new Error("staged digest");
        }
      });
    } catch { issue("stagingFailed"); return finish("failed", "stage"); }

    let failedAt: DeliveryPhase | undefined;
    try {
      await timed("apply", async () => {
        for (const op of manifest.operations) {
          if (signal?.aborted) throw new Error("cancelled");
          const target = join(root, ...op.path.split("/"));
          const step: Step = { op, target, createdDirectories: [], mutated: false, restored: null };
          steps.push(step);
          if (classes.get(op.index) === "after") continue; // already applied — idempotent skip
          const current = await targetState(target);
          if (!matchesBefore(current, op)) { issue("foreignModification", op.path); throw new Error("foreign"); } // changed since classification
          const staged = join(staging!, "stage", String(op.index));
          if (op.kind === "create") { await createParents(root, op.path.split("/").slice(0, -1), step.createdDirectories); step.mutated = true; await placeExclusive(staged, target); }
          else if (op.kind === "update") { step.mutated = true; await moveReplacing(staged, target); }
          else { step.mutated = true; await moveReplacing(target, join(staging!, "backup", String(op.index))); }
          await this.options.faults?.afterOperation?.(op.index);
        }
      });
    } catch { if (!issues.some(i => i.reason === "foreignModification")) issue("applyFailed"); failedAt = "apply"; }

    if (failedAt === undefined) {
      try { await timed("postcheck", async () => { await this.#postcheck(root, manifest, git, issue); if (issues.length > 0) throw new Error("postcheck"); }); }
      catch { if (issues.length === 0) issue("postcheckFailed"); failedAt = "postcheck"; }
    }
    if (failedAt === undefined) return finish("applied", "done");
    // A resume that could not complete does not attempt a rollback (the crashed apply's backups are gone); it stops for
    // recovery so a human decides — the target is never left in a guessed state.
    issue("recoveryRequired");
    retained = true;
    return finish("failed", failedAt);
  }

  /** The shared postcheck: every touched path is its post-image; Git sees no other change; HEAD did not move. */
  async #postcheck(root: string, manifest: DeliveryManifest, git: (root: string, args: string[]) => Promise<{ exitCode: number | null; stdout: string }>,
    issue: IssueFn): Promise<void> {
    for (const op of manifest.operations) if (!matchesAfter(await targetState(join(root, ...op.path.split("/"))), op)) issue("postcheckFailed", op.path);
    const declared = new Set(manifest.operations.map(op => deliveryPathKey(op.path)));
    const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=none"]);
    if (status.exitCode !== 0) issue("postcheckFailed");
    for (const entry of status.stdout.split("\0").filter(Boolean)) { const path = entry.slice(3); if (!declared.has(deliveryPathKey(path))) issue("undeclaredChange", path); }
    const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    if (head.stdout.trim() !== manifest.primary.baseCommit) issue("headMoved");
  }

  /** One touched path against its precondition, without writing: containment, real parents, no link, existence, digest, size. */
  async #checkTarget(root: string, op: DeliveryManifestOperation, manifest: DeliveryManifest, issue: IssueFn): Promise<void> {
    const parts = op.path.split("/"), target = join(root, ...parts);
    if (!isContainedPath(root, target)) return issue("outsideWorkspace", op.path);
    let parent = root;
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      const info = await lstat(parent).catch(() => undefined);
      if (info === undefined) { if (op.beforeSha256 !== null) return issue("fileMissing", op.path); return; }
      if (!info.isDirectory() || info.isSymbolicLink() || comparablePath(await realpath(parent)) !== comparablePath(parent))
        return issue("parentNotDirectory", op.path);
    }
    const info = await lstat(target).catch(() => undefined);
    if (info === undefined) { if (op.beforeSha256 !== null) issue("fileMissing", op.path); return; }
    if (!info.isFile() || info.isSymbolicLink()) return issue("notRegularFile", op.path);
    if (op.beforeSha256 === null) return issue("fileAppeared", op.path);
    if (info.size > manifest.safety.caps.maxFileBytes) return issue("tooLarge", op.path);
    const raw = await readFile(target);
    const observedSha256 = sha256Hex(raw);
    if (observedSha256 === op.beforeSha256) return;
    // v0.6: the raw working bytes differ from the preimage. Record sanitized digests/sizes, and prove an EOL-only
    // difference (a CRLF checkout of an LF blob) by a bounded normalization — reported, never treated as acceptable.
    const eolOnlyMismatch = sha256Hex(stripCr(raw)) === op.beforeSha256;
    issue("fileChanged", op.path, { expectedSha256: op.beforeSha256, observedSha256, observedBytes: raw.length,
      ...(eolOnlyMismatch ? { eolOnlyMismatch: true, expectedBytes: stripCr(raw).length } : {}) });
  }

  /** The journal: each step's path, kind and progress (no content), rewritten after every step. */
  async #journal(staging: string, manifest: DeliveryManifest, steps: readonly Step[], phase: string): Promise<void> {
    await writeFile(join(staging, "journal.json"), `${JSON.stringify({ deliveryId: manifest.deliveryId, phase,
      steps: steps.map(step => ({ index: step.op.index, kind: step.op.kind, path: step.op.path, mutated: step.mutated, restored: step.restored,
        backup: step.backup !== undefined })) }, null, 2)}\n`);
  }
}

class PrecheckStop extends Error {}

/** Creates each missing parent directory (top-down), recording each one in `created` as it is made, for rollback. */
async function createParents(root: string, parts: readonly string[], created: string[]): Promise<void> {
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined) { await mkdir(current); created.push(current); }
    else if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("parent");
  }
}
/** Places a staged file at a path that must not exist: an exclusive hard link (never replaces), else an exclusive copy. */
async function placeExclusive(staged: string, target: string): Promise<void> {
  try { await link(staged, target); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    await copyFile(staged, target, constants.COPYFILE_EXCL);
  }
}
/**
 * Moves `from` onto `to`, replacing it: one rename within a volume (atomic replacement where the filesystem provides it).
 * Across volumes: an exclusive copy into `to`'s own directory, then that rename, then the source removed.
 */
async function moveReplacing(from: string, to: string): Promise<void> {
  try { await rename(from, to); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error; }
  const temporary = join(dirname(to), `.fusion-delivery-${randomBytes(6).toString("hex")}.tmp`);
  await copyFile(from, temporary, constants.COPYFILE_EXCL);
  try { await rename(temporary, to); } catch (error) { await unlink(temporary).catch(() => undefined); throw error; }
  await unlink(from);
}
