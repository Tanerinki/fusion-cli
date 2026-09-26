import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { runCli, type CliIO } from "../cli/run.js";
import { canonicalChangeSetJson } from "../core/change/contract.js";
import { canonicalJson, sha256Hex } from "../core/delivery/canonical.js";
import type { ChangeSet } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import type { WorkflowResult } from "../core/workflow/types.js";
import { readPrimaryIdentity } from "../platform/delivery/applier.js";
import { isContainedPath } from "../platform/events/shared.js";
import { comparablePath, ProcessGitClient } from "../platform/workspace/git.js";
import { liveDeliveryAuthorization, openDeliveryNamespace, prepareStoredDelivery } from "./delivery-service.js";
import type { ProviderRegistry } from "./providers.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED } from "./writer-gate.js";

/**
 * O5.5C3 — ONE human-approved rehearsal of the real delivery mechanics against a DISPOSABLE Git repository that Fusion
 * itself creates under a fresh temporary namespace. Not a provider test: no provider, model or network is involved or
 * authorized (the CLI runs with an empty provider registry). Not a delivery into the Fusion checkout or any user project.
 *
 * Everything real is reused: the preparation path and the delivery store (`prepareStoredDelivery`), and the CLI itself
 * (`runCli`) for `inspect-delivery`, `approve-delivery` (the human types the full manifest digest; nothing is fed) and
 * `apply` (store revalidation, the durable approval, the exclusive apply claim, the applier's precheck, staging, journaled
 * apply, postcheck and rollback). The only difference from a production `fusion apply` is that this entry registers the
 * one repository it created as the disposable target (`disposableDeliveryTargets`); the production entry point never can.
 *
 * Order: authorization (open, pinned fixture) -> interactive terminal -> fresh namespace -> disposable repository and
 * prepared delivery -> inspection -> the human types the digest (approval only on an exact match; otherwise DECLINED,
 * nothing applied, the authorization unconsumed) -> the one-shot claim (the authorization is consumed) -> apply ->
 * independent verification -> bounded evidence -> cleanup of the execution debris (the evidence is kept).
 */
export interface DeliveryRehearsalAuthorization {
  readonly milestone: string;
  /** The namespace directory under the system temporary directory. */
  readonly namespace: string;
  readonly state: "pending" | "open" | "consumed" | "retired";
  /** The Fusion-authored fixture and change this authorization was approved for. */
  readonly fixtureSha256: string;
  readonly changeSha256: string;
}

// ---------------------------------------------------------------- the Fusion-authored fixture (no model, no generation)

/** The disposable repository's committed baseline. */
export const REHEARSAL_FIXTURE: Readonly<Record<string, string>> = Object.freeze({
  ".gitignore": ".env\n",
  "CANARY.md": "# Canary\n\nFusion's O5.5C3 delivery rehearsal never changes this file.\n",
  "README.md": "# Fusion disposable delivery rehearsal\n\nCreated by Fusion for O5.5C3 under a temporary namespace; safe to delete.\n",
  "docs/obsolete.md": "# Obsolete notes\n\nThe approved delivery deletes this file.\n",
  "src/greeting.ts": "export function greeting(name: string): string {\n  return \"Hello \" + name;\n}\n",
});
/** An ignored, sensitive-looking canary (not a real secret): it must be byte-identical after the delivery. */
export const REHEARSAL_SENSITIVE_CANARY = Object.freeze({ path: ".env", content: "REHEARSAL_TOKEN=fusion-o5-5c3-sensitive-canary\n" });
export const REHEARSAL_UNTOUCHED_CANARY = "CANARY.md";
const GREETING_AFTER = "export function greeting(name: string): string {\n  return `Hello, ${name}!`;\n}\n";
const FAREWELL = "export function farewell(name: string): string {\n  return `Goodbye, ${name}.`;\n}\n";
/** The delivered change: one update, one create, one delete. */
export const REHEARSAL_CHANGE: ChangeSet = Object.freeze({ schemaVersion: 1 as const, operations: Object.freeze([
  Object.freeze({ kind: "writeText" as const, path: "src/greeting.ts", expectedSha256: sha256Hex(REHEARSAL_FIXTURE["src/greeting.ts"]!), content: GREETING_AFTER }),
  Object.freeze({ kind: "writeText" as const, path: "src/farewell.ts", expectedSha256: null, content: FAREWELL }),
  Object.freeze({ kind: "delete" as const, path: "docs/obsolete.md", expectedSha256: sha256Hex(REHEARSAL_FIXTURE["docs/obsolete.md"]!) }),
]) });
export const rehearsalFixtureIdentity = (): string => sha256Hex(canonicalJson({
  files: Object.fromEntries(Object.entries(REHEARSAL_FIXTURE).map(([path, content]) => [path, sha256Hex(content)])),
  sensitive: { path: REHEARSAL_SENSITIVE_CANARY.path, sha256: sha256Hex(REHEARSAL_SENSITIVE_CANARY.content) } }));
export const rehearsalChangeIdentity = (): string => sha256Hex(canonicalChangeSetJson(REHEARSAL_CHANGE));

/**
 * Human authorizations of the rehearsal, by the token the human passes (`--authorization`). O5.5C3-DISPOSABLE-APPLY is
 * CONSUMED: the human ran it once (PASS, 2026-09-26); its claim makes a second run refuse, and so does this state.
 */
export const DELIVERY_REHEARSAL_AUTHORIZATIONS: Readonly<Record<string, DeliveryRehearsalAuthorization>> = Object.freeze({
  "O5.5C3-DISPOSABLE-APPLY": Object.freeze({ milestone: "O5.5C3", namespace: "fusion-o5-5c3-delivery", state: "consumed" as const,
    fixtureSha256: "27fc9197c2c8aa6c45fd92147eeb5ff08672e84280d8efa29c48fb49efba8174",
    changeSha256: "fb9377ab9c1dc67bbb1a4eab92866bedd4d8808cd01d35802136af3d977b882a" }),
});

/**
 * The run result the real preparation path receives: completed, the pinned fixture change, its host-application ledger.
 * No verification backend runs in a rehearsal: the delivered bytes are Fusion-authored and pinned by the authorization,
 * which the manifest says openly (backend `fusion-fixture`, confinement `notApplicable`, one `fixture-pin` check).
 */
function rehearsalResult(): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: REHEARSAL_CHANGE,
    applied: REHEARSAL_CHANGE.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256Hex(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 1, evidence: { backendId: "fusion-fixture", confinement: "notApplicable", platformRequirement: "any",
      acceptance: "granted", commands: [{ id: "fixture-pin", status: "passed", exitCode: 0 }] } } };
}

// ---------------------------------------------------------------- dependencies, report, evidence

export interface DeliveryRehearsalDependencies {
  readonly authorization: string;
  readonly env: NodeJS.ProcessEnv;
  /** The human's terminal: it must be interactive; `prompt` reads what the human types. */
  readonly io: CliIO;
  /** The Fusion checkout the entry runs from: its state before and after is evidence; it is never a target. */
  readonly fusionCheckout: string;
  /** The compiled tree (`dist/`), fingerprinted into the evidence. */
  readonly compiledRoot?: string;
  readonly signal?: AbortSignal;
  /** TEST SEAM: the authorization table (the live entry uses DELIVERY_REHEARSAL_AUTHORIZATIONS). */
  readonly authorizations?: Readonly<Record<string, DeliveryRehearsalAuthorization>>;
  /** TEST SEAM: the namespace directory (default: the authorization's namespace under the system temporary directory). */
  readonly namespaceRoot?: string;
  /** TEST SEAM: runs after the claim, before the apply (drift injection). */
  readonly afterClaim?: (primaryRoot: string) => Promise<void>;
}
export type DeliveryRehearsalOutcome = "PASS" | "FAIL" | "DECLINED" | "ABORTED";
export interface DeliveryRehearsalReport {
  readonly outcome: DeliveryRehearsalOutcome;
  readonly detail: string;
  readonly evidencePath: string;
  readonly evidence: DeliveryRehearsalEvidence;
}
export interface DeliveryRehearsalRefusal {
  readonly refused: true;
  readonly reason: "unknownAuthorization" | "authorizationPending" | "authorizationConsumed" | "authorizationRetired" | "fixtureMismatch" |
    "nonInteractive" | "namespaceOutsideTemp" | "namespaceOverlapsCheckout" | "namespaceLink" | "namespaceMismatch" | "alreadyAttempted";
  readonly message: string;
}
export const DELIVERY_REHEARSAL_EVIDENCE_FORMAT = "fusion.deliveryRehearsalEvidence" as const;
export const DELIVERY_REHEARSAL_EVIDENCE_VERSION = 1 as const;
export const MAX_REHEARSAL_EVIDENCE_BYTES = 64 * 1024;
const EXPECTED_EVENTS = Object.freeze(["prepared", "approved", "applyStarted", "precheckStarted", "precheckPassed", "applied"]);
const NAMESPACE_MARKER = "namespace.json", CLAIM = "rehearsal.claim.json", EVIDENCE = "rehearsal.evidence.json";
const ATTEMPT = /^rehearsal\.attempt-[0-9TZ-]{1,40}\.json$/u, WORK = /^work-[0-9a-f]{16}$/u;

export interface DeliveryRehearsalEvidence {
  readonly format: typeof DELIVERY_REHEARSAL_EVIDENCE_FORMAT;
  readonly version: typeof DELIVERY_REHEARSAL_EVIDENCE_VERSION;
  readonly milestone: string;
  readonly outcome: DeliveryRehearsalOutcome;
  readonly detail: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly authorization: Readonly<{ id: string; claim: "claimed" | "notClaimed"; claimedAt: string | null }>;
  readonly harness: Readonly<{ compiledSourceSha256: string; compiledFiles: number; liveEntrySha256: string }> | "notRecorded";
  readonly delivery: Readonly<{ id: string; manifestSha256: string; bundleSha256: string }> | null;
  readonly store: Readonly<{ pathClass: "rehearsalNamespace"; outsideTarget: boolean; namespace: string }> | null;
  readonly target: Readonly<{ classification: "disposable"; createdBy: "fusion"; namespace: string; underFreshNamespace: boolean;
    repositoryIdentity: string; baseCommit: string; baseTree: string; fixtureSha256: string; changeSha256: string;
    registeredDisposableTargets: number }> | null;
  readonly approval: Readonly<{ present: boolean; confirmation: string | null; bindsDeliveryId: boolean; bindsManifest: boolean;
    bindsBundle: boolean; bindsRepository: boolean; bindsBase: boolean }>;
  readonly productionGate: Readonly<{ liveDeliveryAuthorized: boolean; liveGateAuthorized: boolean; plainApplyExitCode: number | null;
    plainApplyResult: string | null }>;
  readonly heads: Readonly<{ expected: string | null; observed: string | null }>;
  readonly phases: Readonly<{ precheck: "passed" | "failed" | "notRun"; apply: string; postcheck: "passed" | "failed" | "notReached";
    rollback: Readonly<{ restored: number; failed: number }> | null }>;
  readonly files: readonly Readonly<{ path: string; kind: string; expectedSha256: string | null; finalSha256: string | null; matches: boolean }>[];
  readonly canaries: readonly Readonly<{ path: string; class: "untouched" | "sensitive"; before: string | null; after: string | null; unchanged: boolean }>[];
  readonly undeclaredChanged: readonly string[];
  readonly git: Readonly<{ status: readonly Readonly<{ code: string; path: string }>[]; statusMatchesExpected: boolean;
    numstat: readonly Readonly<{ path: string; added: number; removed: number }>[] }>;
  readonly events: readonly Readonly<{ seq: number; type: string }>[];
  readonly eventOrderValid: boolean;
  readonly processes: Readonly<{ providerFactoriesReached: number; modelTurns: 0 }>;
  readonly fusionCheckout: Readonly<{ before: string; after: string | null; unchanged: boolean }>;
  readonly exitCodes: Readonly<{ inspect: number | null; approve: number | null; apply: number | null }>;
  readonly cleanup: Readonly<{ workRemoved: boolean }>;
  readonly checks: Readonly<Record<string, boolean>>;
}

// ---------------------------------------------------------------- helpers

const sha256 = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const overlaps = (a: string, b: string): boolean => isContainedPath(a, b) || isContainedPath(b, a);
async function gitOk(git: ProcessGitClient, args: string[], cwd: string, signal?: AbortSignal): Promise<string> {
  const result = await git.run(args, { cwd, ...(signal ? { signal } : {}) });
  if (result.exitCode !== 0) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `Git ${args.find(a => !a.startsWith("-"))} failed in the rehearsal.` });
  return result.stdout;
}
/** Every regular file below `root` (outside `.git`), by content digest. */
async function fileDigests(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path).split(sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/") || !entry.isFile()) continue;
    files[rel] = sha256(await readFile(path));
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}
/** The Fusion checkout's state: HEAD, status and the full diff against HEAD, as one digest (never content). */
async function checkoutState(git: ProcessGitClient, root: string): Promise<string> {
  const head = await gitOk(git, ["--no-optional-locks", "rev-parse", "HEAD"], root);
  const status = await gitOk(git, ["--no-optional-locks", "status", "--porcelain=v1", "-uall"], root);
  const diff = await gitOk(git, ["--no-optional-locks", "diff", "HEAD", "--no-ext-diff", "--binary"], root);
  return sha256(canonicalJson({ head: head.trim(), status: sha256(status), diff: sha256(diff) }));
}
/** The compiled tree's fingerprint and the live entry's digest. */
export async function compiledFingerprint(compiledRoot: string | undefined, liveEntry: string):
  Promise<Readonly<{ compiledSourceSha256: string; compiledFiles: number; liveEntrySha256: string }> | "notRecorded"> {
  if (compiledRoot === undefined) return "notRecorded";
  const srcRoot = join(resolve(compiledRoot), "src");
  const files = (await readdir(srcRoot, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile() && entry.name.endsWith(".js"))
    .map(entry => relative(srcRoot, join(entry.parentPath, entry.name)).split(sep).join("/")).sort();
  const digest = createHash("sha256");
  for (const file of files) digest.update(`${file}\0${sha256(await readFile(join(srcRoot, ...file.split("/"))))}\n`);
  let liveEntrySha256 = "absent";
  try { liveEntrySha256 = sha256(await readFile(join(dirname(srcRoot), "test", "live", liveEntry))); } catch { /* not built */ }
  return Object.freeze({ compiledSourceSha256: digest.digest("hex"), compiledFiles: files.length, liveEntrySha256 });
}
/** A registry with no provider at all; any access is counted (the rehearsal needs none). */
function emptyRegistry(): { registry: ProviderRegistry; reached: () => number } {
  let reached = 0;
  const factories = new Proxy(new Map(), { get(target, property) {
    reached++;
    const value = Reflect.get(target, property, target) as unknown;
    return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
  } }) as unknown as ProviderRegistry["factories"];
  return { reached: () => reached, registry: { factories, defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } } };
}
const silentIO = (): CliIO & { out: () => string } => {
  let text = "";
  return { stdout: t => { text += t; }, stderr: t => { text += t; }, interactive: false, out: () => text };
};

/**
 * The namespace: a real directory strictly inside the system temporary directory, never overlapping the Fusion checkout,
 * holding only this authorization's marker, claim, evidence and work directories. Created (with its marker) when absent.
 */
async function openNamespace(root: string, temp: string, fusion: string, id: string, milestone: string): Promise<DeliveryRehearsalRefusal | undefined> {
  if (!isContainedPath(temp, root) || comparablePath(root) === comparablePath(temp))
    return { refused: true, reason: "namespaceOutsideTemp", message: "The rehearsal namespace must be inside the system temporary directory." };
  if (overlaps(fusion, root)) return { refused: true, reason: "namespaceOverlapsCheckout", message: "The rehearsal namespace may never overlap the Fusion checkout." };
  const info = await lstat(root).catch(() => undefined);
  if (info === undefined) {
    await mkdir(root);
    await writeFile(join(root, NAMESPACE_MARKER), `${canonicalJson({ authorization: id, milestone })}\n`, { flag: "wx" });
  } else if (!info.isDirectory() || info.isSymbolicLink() || comparablePath(await realpath(root)) !== comparablePath(root))
    return { refused: true, reason: "namespaceLink", message: "The rehearsal namespace is a link, a reparse point or not a directory." };
  const entries = await readdir(root);
  let marker: unknown;
  try { marker = JSON.parse(await readFile(join(root, NAMESPACE_MARKER), "utf8")); } catch { marker = undefined; }
  const mark = marker as { authorization?: unknown; milestone?: unknown } | undefined;
  if (mark?.authorization !== id || mark.milestone !== milestone)
    return { refused: true, reason: "namespaceMismatch", message: "The rehearsal namespace does not belong to this authorization." };
  if (entries.some(name => name !== NAMESPACE_MARKER && name !== CLAIM && name !== EVIDENCE && !ATTEMPT.test(name) && !WORK.test(name)))
    return { refused: true, reason: "namespaceMismatch", message: "The rehearsal namespace holds content Fusion did not create there." };
  if (entries.includes(CLAIM))
    return { refused: true, reason: "alreadyAttempted", message: "This rehearsal authorization was already claimed; another run needs a new human authorization." };
  return undefined;
}

// ---------------------------------------------------------------- the rehearsal

export async function runDeliveryRehearsal(deps: DeliveryRehearsalDependencies): Promise<DeliveryRehearsalReport | DeliveryRehearsalRefusal> {
  const table = deps.authorizations ?? DELIVERY_REHEARSAL_AUTHORIZATIONS;
  const id = deps.authorization;
  const authorization = Object.hasOwn(table, id) ? table[id] : undefined;
  if (authorization === undefined) return { refused: true, reason: "unknownAuthorization", message: "The rehearsal authorization is not one Fusion knows." };
  if (authorization.state === "pending") return { refused: true, reason: "authorizationPending", message: `${id} awaits explicit human approval; it cannot run.` };
  if (authorization.state === "retired") return { refused: true, reason: "authorizationRetired", message: `${id} was retired.` };
  if (authorization.state !== "open") return { refused: true, reason: "authorizationConsumed", message: `${id} is consumed; another run needs a new human authorization.` };
  if (authorization.fixtureSha256 !== rehearsalFixtureIdentity() || authorization.changeSha256 !== rehearsalChangeIdentity())
    return { refused: true, reason: "fixtureMismatch", message: `The fixture or change is not the one ${id} was approved for.` };
  if (deps.io.interactive !== true || deps.io.prompt === undefined)
    return { refused: true, reason: "nonInteractive", message: "The rehearsal needs a human at an interactive terminal to type the manifest digest; nothing was created." };
  const temp = await realpath(tmpdir());
  const root = resolve(deps.namespaceRoot ?? join(temp, authorization.namespace));
  const fusion = await realpath(deps.fusionCheckout);
  const refusal = await openNamespace(root, temp, fusion, id, authorization.milestone);
  if (refusal !== undefined) return refusal;

  const started = new Date(), clock = performance.now();
  const git = await ProcessGitClient.fromPath(deps.env, true);
  const fusionBefore = await checkoutState(git, fusion);
  const work = join(root, `work-${randomBytes(8).toString("hex")}`);
  await mkdir(work);
  const primary = join(work, "primary"), storeBase = join(work, "delivery-state");
  const { registry, reached } = emptyRegistry();
  const say = (text: string): void => deps.io.stdout(`${text}\n`);
  const state = {
    claimedAt: null as string | null, delivery: null as DeliveryRehearsalEvidence["delivery"], store: null as DeliveryRehearsalEvidence["store"],
    target: null as DeliveryRehearsalEvidence["target"], expectedHead: null as string | null,
    approval: { present: false, confirmation: null as string | null, bindsDeliveryId: false, bindsManifest: false, bindsBundle: false,
      bindsRepository: false, bindsBase: false },
    gate: { liveDeliveryAuthorized: liveDeliveryAuthorization().authorized as boolean, liveGateAuthorized: REAL_WRITER_LIVE_GATE_AUTHORIZED as boolean,
      plainApplyExitCode: null as number | null, plainApplyResult: null as string | null },
    exit: { inspect: null as number | null, approve: null as number | null, apply: null as number | null },
    canaryBefore: {} as Record<string, string | null>, before: {} as Record<string, string>,
  };
  let outcome: DeliveryRehearsalOutcome = "ABORTED", detail = "the rehearsal stopped before its approval";
  let verified: Pick<DeliveryRehearsalEvidence, "heads" | "phases" | "files" | "canaries" | "undeclaredChanged" | "git" | "events" | "eventOrderValid"> = {
    heads: { expected: null, observed: null }, phases: { precheck: "notRun", apply: "notRun", postcheck: "notReached", rollback: null }, files: [],
    canaries: [], undeclaredChanged: [], git: { status: [], statusMatchesExpected: false, numstat: [] }, events: [], eventOrderValid: false };
  let checks: Record<string, boolean> = {};
  try {
    // 1. The disposable repository, built by Fusion host code: a clean committed baseline and an ignored sensitive canary.
    say(`O5.5C3 disposable delivery rehearsal (${id}): creating the disposable repository under the rehearsal namespace.`);
    for (const [path, content] of Object.entries(REHEARSAL_FIXTURE)) {
      await mkdir(dirname(join(primary, ...path.split("/"))), { recursive: true });
      await writeFile(join(primary, ...path.split("/")), content, { flag: "wx" });
    }
    await gitOk(git, ["-c", "init.defaultBranch=main", "init", "-q"], primary, deps.signal);
    await gitOk(git, ["-c", "core.autocrlf=false", "add", "--", ...Object.keys(REHEARSAL_FIXTURE)], primary, deps.signal);
    await gitOk(git, ["-c", "user.name=Fusion Rehearsal", "-c", "user.email=fusion-rehearsal@example.invalid", "-c", "commit.gpgsign=false",
      "-c", "core.autocrlf=false", "commit", "-q", "-m", "O5.5C3 disposable baseline"], primary, deps.signal);
    await writeFile(join(primary, REHEARSAL_SENSITIVE_CANARY.path), REHEARSAL_SENSITIVE_CANARY.content, { flag: "wx" });
    const identity = await readPrimaryIdentity(primary, git, deps.signal);
    state.expectedHead = identity.headCommit;
    state.before = await fileDigests(primary);
    state.canaryBefore = { [REHEARSAL_UNTOUCHED_CANARY]: state.before[REHEARSAL_UNTOUCHED_CANARY] ?? null,
      [REHEARSAL_SENSITIVE_CANARY.path]: state.before[REHEARSAL_SENSITIVE_CANARY.path] ?? null };
    // 2. The real preparation path and delivery store (its base inside the namespace, outside the repository).
    const delivery = await prepareStoredDelivery({ runId: "o5-5c3-disposable-apply", taskSha256: sha256Hex("O5.5C3 disposable delivery rehearsal"),
      workflowEvidenceSha256: sha256Hex(canonicalJson({ kind: "fusionFixtureAttestation", fixture: rehearsalFixtureIdentity(), change: rehearsalChangeIdentity() })),
      result: rehearsalResult(), scope: { allowedPaths: REHEARSAL_CHANGE.operations.map(op => op.path), forbiddenPaths: [] }, baseCommit: identity.headCommit,
      primaryRoot: primary, git, storeBase, ...(deps.signal ? { signal: deps.signal } : {}) });
    const namespace = await openDeliveryNamespace({ root: await realpath(primary), git, storeBase }, false);
    const stored = await namespace.store.load(delivery.deliveryId);
    state.delivery = { id: delivery.deliveryId, manifestSha256: stored.record.manifestSha256, bundleSha256: stored.record.bundleSha256 };
    state.store = { pathClass: "rehearsalNamespace", outsideTarget: !overlaps(await realpath(primary), namespace.base), namespace: namespace.repositoryIdentity };
    state.target = { classification: "disposable", createdBy: "fusion", namespace: authorization.namespace,
      underFreshNamespace: isContainedPath(root, primary) && isContainedPath(temp, primary), repositoryIdentity: identity.repositoryIdentity,
      baseCommit: identity.headCommit, baseTree: identity.headTree, fixtureSha256: rehearsalFixtureIdentity(), changeSha256: rehearsalChangeIdentity(),
      registeredDisposableTargets: 1 };
    const host = { env: deps.env, cwd: primary, registry, deliveryStoreRoot: storeBase, ...(deps.signal ? { signal: deps.signal } : {}) };
    // 3. The same inspection `fusion inspect-delivery` renders, with the full manifest digest.
    say("\n--- fusion inspect-delivery ---");
    state.exit.inspect = await runCli(["inspect-delivery", delivery.deliveryId], deps.io, host);
    // 4. The real approval command: its summary, then the human types the exact full digest (nothing is fed).
    say("\n--- fusion approve-delivery ---");
    state.exit.approve = await runCli(["approve-delivery", delivery.deliveryId], deps.io, host);
    const approved = await namespace.store.load(delivery.deliveryId);
    const approval = approved.approval;
    state.approval = { present: approval !== null && approved.state === "approved", confirmation: approval?.confirmation ?? null,
      bindsDeliveryId: approval?.deliveryId === delivery.deliveryId, bindsManifest: approval?.manifestSha256 === stored.record.manifestSha256,
      bindsBundle: approval?.bundleSha256 === stored.record.bundleSha256, bindsRepository: approval?.repositoryIdentity === identity.repositoryIdentity,
      bindsBase: approval?.baseCommit === identity.headCommit };
    if (state.exit.approve !== 0 || !state.approval.present) {
      outcome = "DECLINED";
      detail = "no exact digest was typed: nothing was approved or applied, and the authorization was not consumed";
      return await finish();
    }
    // 5. The production gate stays closed: a plain `fusion apply` of this approved delivery is blocked and uses nothing.
    const plain = silentIO();
    state.gate.plainApplyExitCode = await runCli(["--json", "apply", delivery.deliveryId], plain, host);
    try { state.gate.plainApplyResult = String((JSON.parse(plain.out()) as { delivery?: { result?: unknown } }).delivery?.result ?? "none"); }
    catch { state.gate.plainApplyResult = "unreadable"; }
    // 6. The one-shot claim: from here on the authorization is consumed, whatever happens.
    state.claimedAt = new Date().toISOString();
    await writeFile(join(root, CLAIM), `${canonicalJson({ authorization: id, milestone: authorization.milestone, deliveryId: delivery.deliveryId,
      manifestSha256: stored.record.manifestSha256, claimedAt: state.claimedAt })}\n`, { flag: "wx" });
    await deps.afterClaim?.(primary);
    // 7-9. The real `fusion apply`: store revalidation, approval, apply claim, precheck, staging, apply, postcheck, rollback —
    // with the one repository this rehearsal created registered as the disposable target.
    say("\n--- fusion apply (disposable target registered by this rehearsal) ---");
    state.exit.apply = await runCli(["apply", delivery.deliveryId], deps.io, { ...host, disposableDeliveryTargets: [primary] });
    // 10. Independent verification: final hashes, canaries, undeclared paths, Git status and diff, the event log.
    verified = await verify(git, primary, state.before, namespace.store, delivery.deliveryId, stored.manifest.operations);
    checks = {
      exactDigestTyped: state.approval.present && state.exit.approve === 0 && state.approval.confirmation === "typedManifestSha256",
      approvalBindsExactly: state.approval.bindsDeliveryId && state.approval.bindsManifest && state.approval.bindsBundle && state.approval.bindsRepository &&
        state.approval.bindsBase,
      authorizationClaimedOnce: state.claimedAt !== null,
      productionGateClosed: !state.gate.liveDeliveryAuthorized && !state.gate.liveGateAuthorized && state.gate.plainApplyExitCode === 11 &&
        state.gate.plainApplyResult === "blocked",
      targetIsFusionDisposable: state.target.underFreshNamespace && state.target.registeredDisposableTargets === 1,
      precheckPassed: verified.phases.precheck === "passed",
      applyCompleted: verified.phases.apply === "applied" && state.exit.apply === 0,
      postcheckPassed: verified.phases.postcheck === "passed",
      finalHashesMatch: verified.files.length === REHEARSAL_CHANGE.operations.length && verified.files.every(file => file.matches),
      canariesUnchanged: verified.canaries.length === 2 && verified.canaries.every(canary => canary.unchanged),
      noUndeclaredChange: verified.undeclaredChanged.length === 0 && verified.git.statusMatchesExpected,
      eventOrderValid: verified.eventOrderValid,
      noProviderReached: reached() === 0,
      storeOutsideTarget: state.store.outsideTarget,
    };
    const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name);
    outcome = failed.length === 0 ? "PASS" : "FAIL";
    detail = failed.length === 0 ? "every pass criterion held" : `failed: ${failed.join(", ")}`;
    return await finish();
  } catch (error) {
    detail = error instanceof FusionFailure ? `stopped: ${error.error.safeMessage}` : "stopped by an unexpected error";
    outcome = state.claimedAt === null ? "ABORTED" : "FAIL";
    return await finish();
  }

  async function finish(): Promise<DeliveryRehearsalReport> {
    const fusionAfter = await checkoutState(git, fusion).catch(() => null);
    const workRemoved = await rm(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).then(() => !existsSync(work), () => false);
    if (outcome === "PASS" && (fusionAfter !== fusionBefore || !workRemoved)) {
      outcome = "FAIL";
      detail = `failed: ${fusionAfter !== fusionBefore ? "fusionCheckoutUnchanged" : "cleanup"}`;
    }
    const evidence: DeliveryRehearsalEvidence = { format: DELIVERY_REHEARSAL_EVIDENCE_FORMAT, version: DELIVERY_REHEARSAL_EVIDENCE_VERSION,
      milestone: authorization!.milestone, outcome, detail, startedAt: started.toISOString(), durationMs: Math.round(performance.now() - clock),
      authorization: { id, claim: state.claimedAt === null ? "notClaimed" : "claimed", claimedAt: state.claimedAt },
      harness: await compiledFingerprint(deps.compiledRoot, "delivery-apply-rehearsal.js"), delivery: state.delivery, store: state.store, target: state.target,
      approval: state.approval, productionGate: state.gate, ...verified,
      processes: { providerFactoriesReached: reached(), modelTurns: 0 },
      fusionCheckout: { before: fusionBefore, after: fusionAfter, unchanged: fusionAfter === fusionBefore },
      exitCodes: state.exit, cleanup: { workRemoved }, checks: { ...checks, fusionCheckoutUnchanged: fusionAfter === fusionBefore } };
    validateDeliveryRehearsalEvidence(evidence);
    const name = state.claimedAt === null ? `rehearsal.attempt-${started.toISOString().replace(/[:.]/gu, "-")}.json` : EVIDENCE;
    const path = join(root, name);
    await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, { flag: "wx" });
    return { outcome, detail, evidencePath: path, evidence };
  }
}

/** Independent verification after the apply: never trusts the applier's own report. */
async function verify(git: ProcessGitClient, primary: string, before: Readonly<Record<string, string>>, store: { load(id: string): Promise<StoredForVerify> },
  deliveryId: string, operations: readonly Readonly<{ kind: string; path: string; afterSha256: string | null }>[]):
  Promise<Pick<DeliveryRehearsalEvidence, "heads" | "phases" | "files" | "canaries" | "undeclaredChanged" | "git" | "events" | "eventOrderValid">> {
  const after = await fileDigests(primary);
  const files = operations.map(op => ({ path: op.path, kind: op.kind, expectedSha256: op.afterSha256, finalSha256: after[op.path] ?? null,
    matches: (after[op.path] ?? null) === op.afterSha256 }));
  const canaries = [{ path: REHEARSAL_UNTOUCHED_CANARY, class: "untouched" as const }, { path: REHEARSAL_SENSITIVE_CANARY.path, class: "sensitive" as const }]
    .map(c => ({ ...c, before: before[c.path] ?? null, after: after[c.path] ?? null, unchanged: before[c.path] !== undefined && before[c.path] === after[c.path] }));
  const declared = new Set(operations.map(op => op.path));
  const undeclaredChanged = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => !declared.has(path) && before[path] !== after[path]).sort();
  const status = (await gitOk(git, ["--no-optional-locks", "status", "--porcelain=v1", "-uall", "--ignored"], primary)).split(/\r?\n/u).filter(Boolean)
    .map(line => ({ code: line.slice(0, 2), path: line.slice(3) })).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const expected = [...operations.map(op => ({ code: op.kind === "delete" ? " D" : op.kind === "create" ? "??" : " M", path: op.path })),
    { code: "!!", path: REHEARSAL_SENSITIVE_CANARY.path }].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const numstat = (await gitOk(git, ["--no-optional-locks", "diff", "--numstat", "--no-ext-diff", "HEAD"], primary)).split(/\r?\n/u).filter(Boolean)
    .map(line => line.split("\t")).map(([added, removed, path]) => ({ path: path ?? "", added: Number(added), removed: Number(removed) }));
  const loaded = await store.load(deliveryId);
  const events = loaded.events.map(event => ({ seq: event.seq, type: event.type }));
  const terminal = loaded.events.at(-1);
  const types = events.map(event => event.type);
  return { heads: { expected: loaded.manifest.primary.baseCommit, observed: loaded.events.find(event => event.type === "precheckPassed" || event.type === "precheckFailed")?.observedHead ?? null },
    phases: { precheck: types.includes("precheckPassed") ? "passed" : types.includes("precheckFailed") ? "failed" : "notRun", apply: terminal?.type ?? "notRun",
      postcheck: terminal?.type === "applied" ? "passed" : (terminal?.issues ?? []).some(issue => /^(postcheckFailed|undeclaredChange)/u.test(issue)) ? "failed" : "notReached",
      rollback: terminal?.rollback ?? null },
    files, canaries, undeclaredChanged, git: { status, statusMatchesExpected: canonicalJson(status) === canonicalJson(expected), numstat },
    events, eventOrderValid: canonicalJson(types) === canonicalJson(EXPECTED_EVENTS) };
}
type StoredForVerify = Readonly<{ manifest: Readonly<{ primary: Readonly<{ baseCommit: string }> }>;
  events: readonly Readonly<{ seq: number; type: string; observedHead: string | null; issues: readonly string[]; rollback: Readonly<{ restored: number; failed: number }> | null }>[] }>;

const HEX64 = /^[0-9a-f]{64}$/u, OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u, REL_PATH = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u;
const EVIDENCE_KEYS = ["format", "version", "milestone", "outcome", "detail", "startedAt", "durationMs", "authorization", "harness", "delivery", "store", "target",
  "approval", "productionGate", "heads", "phases", "files", "canaries", "undeclaredChanged", "git", "events", "eventOrderValid", "processes", "fusionCheckout",
  "exitCodes", "cleanup", "checks"];
/**
 * Validates rehearsal evidence (it can be checked without running the rehearsal): the exact top-level shape, bounded size,
 * digests and object ids where digests belong, repository-relative fixture paths only, and no file content, no fixture
 * text and no canary value anywhere. Throws a SecurityViolation otherwise.
 */
export function validateDeliveryRehearsalEvidence(value: unknown): DeliveryRehearsalEvidence {
  const fail = (why: string): never => { throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: `Invalid rehearsal evidence (${why}).` }); };
  const e = value as DeliveryRehearsalEvidence;
  if (e === null || typeof e !== "object" || Object.keys(e).length !== EVIDENCE_KEYS.length || !EVIDENCE_KEYS.every(key => Object.hasOwn(e, key))) return fail("shape");
  const text = JSON.stringify(e);
  if (Buffer.byteLength(text) > MAX_REHEARSAL_EVIDENCE_BYTES) return fail("too large");
  if (e.format !== DELIVERY_REHEARSAL_EVIDENCE_FORMAT || e.version !== DELIVERY_REHEARSAL_EVIDENCE_VERSION) return fail("format");
  if (!["PASS", "FAIL", "DECLINED", "ABORTED"].includes(e.outcome) || typeof e.detail !== "string" || e.detail.length > 400) return fail("outcome");
  const contents = [...Object.values(REHEARSAL_FIXTURE), REHEARSAL_SENSITIVE_CANARY.content, ...REHEARSAL_CHANGE.operations.flatMap(op => op.kind === "delete" ? [] : [op.content])];
  for (const content of contents) for (const line of content.split("\n").filter(line => line.trim().length >= 12))
    if (text.includes(JSON.stringify(line).slice(1, -1))) return fail("file content");
  if (text.includes("fusion-o5-5c3-sensitive-canary")) return fail("canary value");
  if (e.delivery !== null && (!HEX64.test(e.delivery.manifestSha256) || !HEX64.test(e.delivery.bundleSha256))) return fail("delivery digests");
  if (e.target !== null && (!HEX64.test(e.target.repositoryIdentity) || !OBJECT_ID.test(e.target.baseCommit) || !OBJECT_ID.test(e.target.baseTree))) return fail("target");
  for (const file of e.files) if (!REL_PATH.test(file.path) || (file.expectedSha256 !== null && !HEX64.test(file.expectedSha256)) ||
    (file.finalSha256 !== null && !HEX64.test(file.finalSha256))) return fail("files");
  for (const canary of e.canaries) if ((canary.before !== null && !HEX64.test(canary.before)) || (canary.after !== null && !HEX64.test(canary.after))) return fail("canaries");
  for (const entry of e.git.status) if (!REL_PATH.test(entry.path) || !/^[ MADRCU?!]{2}$/u.test(entry.code)) return fail("git status");
  if (!HEX64.test(e.fusionCheckout.before) || (e.fusionCheckout.after !== null && !HEX64.test(e.fusionCheckout.after))) return fail("checkout");
  if (e.processes.modelTurns !== 0) return fail("model turns");
  if (e.events.length > 64 || e.files.length > 32 || e.git.status.length > 64 || e.undeclaredChanged.length > 64) return fail("bounds");
  return e;
}
