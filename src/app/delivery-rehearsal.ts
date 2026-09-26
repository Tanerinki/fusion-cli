import { canonicalChangeSetJson } from "../core/change/contract.js";
import { canonicalJson, sha256Hex } from "../core/delivery/canonical.js";
import type { ChangeSet } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";

/**
 * O5.5C3 — the disposable apply rehearsal: ONE human-approved run of the real delivery mechanics against a Git repository
 * Fusion itself created under %TEMP%\fusion-o5-5c3-delivery, while the production `fusion apply` was still closed and a
 * disposable-target seam let only that repository be applied. The human ran it once (PASS, 2026-09-26; recorded in
 * `delivery-live-records.ts`, evidence copy in `test/fixtures/o5-5c3-rehearsal.evidence.json`).
 *
 * RETIRED in O5.5C4: the production apply policy replaced the closed gate and removed the disposable-target seam, so the
 * rehearsal (whose premise and pass criteria included "the production gate stays closed") can no longer run; its runner
 * and live entry are gone and its authorization is consumed. What stays is what the recorded evidence needs: the pinned
 * Fusion-authored fixture and change, their identities, the consumed authorization, and the evidence format and validator.
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

// ---------------------------------------------------------------- recorded evidence (format v1)

export type DeliveryRehearsalOutcome = "PASS" | "FAIL" | "DECLINED" | "ABORTED";
export const DELIVERY_REHEARSAL_EVIDENCE_FORMAT = "fusion.deliveryRehearsalEvidence" as const;
export const DELIVERY_REHEARSAL_EVIDENCE_VERSION = 1 as const;
export const MAX_REHEARSAL_EVIDENCE_BYTES = 64 * 1024;

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
