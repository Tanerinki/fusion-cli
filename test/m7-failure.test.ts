import assert from "node:assert/strict";
import { test } from "node:test";
import { EXIT_CODES, exitCodeForTurn, presentFailure } from "../src/cli/failure-presentation.js";
import type { FusionError, FusionErrorKind, TurnResult } from "../src/core/domain.js";
import { internalError, safeCauseCode } from "../src/core/errors.js";
import { DiagnosticRedactor } from "../src/core/policy/redaction.js";
import { BoundedReadError } from "../src/platform/fs/bounded-read.js";
import { StorageError } from "../src/platform/events/shared.js";
import { InvalidProcessInputError } from "../src/platform/process/native-executable.js";

const redactor = new DiagnosticRedactor();
const EXPECTED: ReadonlyArray<[FusionErrorKind, string, number]> = [
  ["InvalidInput", "invalidInput", 2], ["BillingBlocked", "billingGuard", 3], ["AuthMismatch", "authentication", 3],
  ["ProviderIdentityMismatch", "securityPolicy", 4], ["SecurityViolation", "securityPolicy", 4],
  ["CapabilityUnavailable", "providerUnavailable", 5], ["SpawnFailure", "spawnFailure", 5], ["Timeout", "timeout", 7],
  ["Cancelled", "cancelled", 130], ["ProcessFailure", "providerFailure", 6], ["ProtocolError", "providerFailure", 6],
  ["MalformedOutput", "malformedResponse", 6], ["VerificationFailure", "verification", 9],
  ["WorkspaceConflict", "dirtyWorkspace", 8], ["InternalError", "internal", 1],
];

test("M7.9 every failure kind has a distinct title, a category and a documented exit status", () => {
  const titles = new Set<string>();
  for (const [kind, category, exitCode] of EXPECTED) {
    const shown = presentFailure({ kind, safeMessage: "Fixture message.", retryable: false }, { redactor });
    assert.equal(shown.category, category, kind);
    assert.equal(shown.exitCode, exitCode, kind);
    const [first, second] = shown.text.split("\n");
    assert.match(first ?? "", /^fusion: [A-Z][^:]+: Fixture message\.$/u, kind);
    assert.match(second ?? "", /^hint: \S/u, kind);
    titles.add((first ?? "").split(":")[1]!);
  }
  assert.equal(titles.size, EXPECTED.length, "distinct causes are never collapsed into one generic message");
  assert.equal(EXIT_CODES.success, 0);
});

test("M7.9 presentation is deterministic, concise and marks retryable failures", () => {
  const error: FusionError = { kind: "Timeout", safeMessage: "Claude exceeded its deadline.", retryable: true };
  const a = presentFailure(error, { redactor }), b = presentFailure(error, { redactor });
  assert.deepEqual(a, b);
  assert.equal(a.text, "fusion: Timed out: Claude exceeded its deadline.\n" +
    "hint: The provider exceeded its deadline and was stopped; retry or raise the configured timeout.\nretryable: yes");
  assert.ok(a.text.split("\n").length <= 3);
});

test("M7.9/M7.7 presented text is redacted and never includes stack traces or raw causes by default", () => {
  const secrets = new DiagnosticRedactor(["presented-secret-1234"]);
  const shown = presentFailure({ kind: "ProcessFailure", safeMessage: "failed near presented-secret-1234 token=abc123",
    retryable: false, causeCode: "Error:EACCES" }, { redactor: secrets });
  assert.doesNotMatch(shown.text, /presented-secret-1234|abc123|EACCES/u);
  const thrown = new Error("boom at C:\\Users\\someone\\presented-secret-1234");
  const hidden = presentFailure(thrown, { redactor: secrets });
  assert.equal(hidden.category, "internal");
  assert.equal(hidden.exitCode, 1);
  assert.doesNotMatch(hidden.text, /boom|someone|presented-secret|\n\s+at\s/u);
  const debug = presentFailure(thrown, { redactor: secrets, debug: true });
  assert.match(debug.text, /debug: cause Error/u);
  assert.doesNotMatch(debug.text, /presented-secret-1234|\n\s+at\s/u);
});

test("M7.9 storage, path-safety, bounded-read and process-input failures map to their own classes", () => {
  assert.equal(presentFailure(new StorageError("InvalidArtifactPath", "Artifact path escapes the run root."), { redactor }).category, "pathSafety");
  assert.equal(presentFailure(new StorageError("ArtifactTooLarge", "Artifact exceeds in-memory limit."), { redactor }).exitCode, EXIT_CODES.storage);
  assert.equal(presentFailure(new StorageError("CorruptEventLog", "Truncated."), { redactor }).category, "storage");
  assert.equal(presentFailure(new InvalidProcessInputError("cwd must be a directory"), { redactor }).exitCode, EXIT_CODES.invalidInput);
  assert.equal(presentFailure(new BoundedReadError("tooLarge"), { redactor }).category, "invalidInput");
  assert.equal(presentFailure("a thrown string", { redactor }).exitCode, EXIT_CODES.internal);
  assert.equal(presentFailure({ kind: "NotAKind", safeMessage: "x", retryable: false }, { redactor }).category, "internal",
    "unknown shapes are never trusted as typed failures");
});

test("M7.9 turn exit status is success only for a completed turn", () => {
  const base = { effectiveProvider: "p", effectiveModel: "m", artifactRefs: [] as string[] };
  const packet = { result: { status: "completed" as const }, changes: { files: [], summary: "" },
    verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [] };
  const completed: TurnResult = { ...base, status: "completed", output: packet };
  const cancelled: TurnResult = { ...base, status: "cancelled", output: packet,
    error: { kind: "Cancelled", safeMessage: "stopped", retryable: false } };
  const vetoed: TurnResult = { ...base, status: "failed", error: { kind: "SecurityViolation", safeMessage: "denied", retryable: false } };
  assert.deepEqual([exitCodeForTurn(completed), exitCodeForTurn(cancelled), exitCodeForTurn(vetoed)], [0, 130, 4]);
});

test("M7.9 internal errors keep a safe cause code and never a message", () => {
  const fsError = Object.assign(new Error("EACCES: permission denied, open 'C:\\Users\\someone\\secret.txt'"), { code: "EACCES" });
  assert.equal(safeCauseCode(fsError), "Error:EACCES");
  assert.equal(safeCauseCode(new StorageError("ArtifactError", "x")), "ArtifactError");
  assert.equal(safeCauseCode(new TypeError("bad")), "TypeError");
  assert.equal(safeCauseCode({ message: "not an error" }), "object");
  assert.equal(safeCauseCode(Object.assign(new Error("x"), { code: "has spaces and C:\\path" })), "Error");
  const error = internalError("Stopped safely.", fsError);
  assert.deepEqual(error, { kind: "InternalError", safeMessage: "Stopped safely.", retryable: false, causeCode: "Error:EACCES" });
  assert.doesNotMatch(JSON.stringify(error), /someone|secret|permission denied/u);
});
