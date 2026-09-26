import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { REAL_WRITER_MODE_NOT_READY, REAL_WRITER_MODE_PREREQUISITES, writerReadiness } from "../src/app/writer-gate.js";
import { CONFINEMENT_FACTS, CONFINEMENT_LIMITS, decodeConfinementProof, evaluateConfinementProof,
  validateConfinementProof, type ConfinementFact } from "../src/platform/verification/confinement-proof.js";
import { FAKE_BACKEND, FAKE_HELPER_SHA256, FAKE_OBSERVED_AT, fakeExpectation, fakeProofResult,
  runFakeConfinementBackend } from "./fixtures/fake-confinement-backend.js";

const kind = (name: string, message?: RegExp) => (error: unknown): boolean => error instanceof FusionFailure &&
  error.error.kind === name && (message === undefined || message.test(error.error.safeMessage));
const observations = (): Record<string, unknown>[] => fakeProofResult().observations as Record<string, unknown>[];
const withObservations = (list: unknown): Record<string, unknown> => fakeProofResult({ patch: { observations: list } });
const replaceObservation = (index: number, change: Record<string, unknown>): Record<string, unknown> =>
  withObservations(observations().map((entry, i) => i === index ? { ...entry, ...change } : entry));
const others = (fact: ConfinementFact): ConfinementFact[] => CONFINEMENT_FACTS.filter(other => other !== fact);

test("O5.5B3 a complete fake proof decodes, validates canonically and evaluates complete", () => {
  const proof = decodeConfinementProof(runFakeConfinementBackend());
  assert.deepEqual(proof, fakeProofResult());
  assert.ok(Object.isFrozen(proof) && Object.isFrozen(proof.observations) && proof.observations.every(Object.isFrozen));
  const evaluation = evaluateConfinementProof(proof, fakeExpectation());
  assert.deepEqual(evaluation, { complete: true, passed: [...CONFINEMENT_FACTS], failed: [], notObserved: [],
    identityMismatches: [], productionEligible: false });
  assert.ok(Object.isFrozen(evaluation));
  // Helper order is not trusted: validation returns observations in canonical fact order.
  const reversed = validateConfinementProof(withObservations(observations().reverse()));
  assert.deepEqual(reversed.observations.map(o => o.fact), [...CONFINEMENT_FACTS]);
  // The validated copy is detached from its producer.
  const raw = fakeProofResult(), validated = validateConfinementProof(raw);
  (raw.observations as Record<string, unknown>[])[0]!.state = "observedFail";
  assert.equal(validated.observations[0]!.state, "observedPass");
});

test("O5.5B3 any single observedFail makes the proof incomplete, including cleanup failure", () => {
  for (const fact of CONFINEMENT_FACTS) {
    const evaluation = evaluateConfinementProof(fakeProofResult({ states: { [fact]: "observedFail" } }), fakeExpectation());
    assert.deepEqual([evaluation.complete, evaluation.failed, evaluation.notObserved, evaluation.passed],
      [false, [fact], [], others(fact)], fact);
  }
  const cleanup = evaluateConfinementProof(decodeConfinementProof(runFakeConfinementBackend(
    { states: { cleanupComplete: "observedFail" } })), fakeExpectation());
  assert.equal(cleanup.complete, false);
  assert.deepEqual(cleanup.failed, ["cleanupComplete"]);
  assert.deepEqual(cleanup.identityMismatches, []);
});

test("O5.5B3 notObserved is never a pass", () => {
  for (const fact of CONFINEMENT_FACTS) {
    const evaluation = evaluateConfinementProof(fakeProofResult({ states: { [fact]: "notObserved" } }), fakeExpectation());
    assert.deepEqual([evaluation.complete, evaluation.notObserved, evaluation.failed, evaluation.passed],
      [false, [fact], [], others(fact)], fact);
  }
  const nothing = evaluateConfinementProof(fakeProofResult({ states: Object.fromEntries(CONFINEMENT_FACTS.map(fact =>
    [fact, "notObserved"])) }), fakeExpectation());
  assert.deepEqual([nothing.complete, nothing.passed.length, nothing.notObserved.length], [false, 0, CONFINEMENT_FACTS.length]);
});

test("O5.5B3 malformed payloads are rejected", () => {
  for (const bad of [null, undefined, 1, "text", [], [fakeProofResult()], new Date(), () => 1, Symbol("x")])
    assert.throws(() => validateConfinementProof(bad), kind("MalformedOutput"), String(typeof bad));
  const valid = fakeProofResult();
  const { observedAt: _omitted, ...missingKey } = valid;
  const payloads: Record<string, unknown>[] = [missingKey, { ...valid, protocolVersion: undefined },
    { backend: FAKE_BACKEND }, { ...valid, backend: 1 }, { ...valid, backend: "" }, { ...valid, backend: "Test-Fake" },
    { ...valid, backend: "test fake" }, { ...valid, backend: "test--fake" }, { ...valid, backend: "-fake" },
    { ...valid, backend: "../fake" }, { ...valid, helperSha256: FAKE_HELPER_SHA256.toUpperCase() },
    { ...valid, helperSha256: FAKE_HELPER_SHA256.slice(1) }, { ...valid, helperSha256: `${FAKE_HELPER_SHA256}0` },
    { ...valid, helperSha256: null }, { ...valid, platform: "win32" }, { ...valid, platform: "WIN32-X64" },
    { ...valid, platform: "freebsd-x64" }, { ...valid, observedAt: "2026-09-23T12:00:00Z" },
    { ...valid, observedAt: "2026-09-23T12:00:00.000+00:00" }, { ...valid, observedAt: "2026-02-30T12:00:00.000Z" },
    { ...valid, observedAt: "2026-09-23t12:00:00.000z" }, { ...valid, observedAt: Date.parse(FAKE_OBSERVED_AT) },
    { ...valid, observations: {} }, { ...valid, observations: null }, withObservations(observations().slice(1)),
    withObservations([]), replaceObservation(0, { fact: "somethingElse" }), replaceObservation(0, { fact: "GrantedReadWorks" }),
    replaceObservation(0, { state: "pass" }), replaceObservation(0, { state: true }), replaceObservation(0, { attempts: -1 }),
    replaceObservation(0, { attempts: 1.5 }), replaceObservation(0, { attempts: "2" }), replaceObservation(0, { failures: null }),
    withObservations([...observations().slice(1), "grantedReadWorks"])];
  for (const [index, payload] of payloads.entries())
    assert.throws(() => validateConfinementProof(payload), kind("MalformedOutput"), `payload ${index}`);
  for (const text of ["", "{", "not json", "null", "[]", `${runFakeConfinementBackend()} trailing`, 42 as unknown as string])
    assert.throws(() => decodeConfinementProof(text), kind("MalformedOutput"), String(text).slice(0, 20));
  const deep = runFakeConfinementBackend().replace(`"attempts":2`, `"attempts":{"nested":[1]}`);
  assert.throws(() => decodeConfinementProof(deep), kind("MalformedOutput", /tooDeep/u));
  // Getters and proxies never reach the validator.
  assert.throws(() => validateConfinementProof(new Proxy(fakeProofResult(), {})), kind("MalformedOutput"));
});

test("O5.5B3 unsupported protocol versions are refused before their shape is judged", () => {
  for (const version of [0, 2, 3, 999, -1, Number.MAX_SAFE_INTEGER])
    assert.throws(() => validateConfinementProof(fakeProofResult({ patch: { protocolVersion: version } })),
      kind("ProtocolError"), String(version));
  // A future version may have a different shape; it is still reported as unsupported, not malformed.
  assert.throws(() => validateConfinementProof({ protocolVersion: 2, facts: {} }), kind("ProtocolError"));
  assert.throws(() => decodeConfinementProof(JSON.stringify({ protocolVersion: 2 })), kind("ProtocolError"));
  for (const version of ["1", 1.5, null, true, [1], { v: 1 }, 1e400])
    assert.throws(() => validateConfinementProof(fakeProofResult({ patch: { protocolVersion: version } })),
      kind("MalformedOutput"), JSON.stringify(version));
});

test("O5.5B3 identity metadata must match the host's pinned expectation", () => {
  const proof = decodeConfinementProof(runFakeConfinementBackend());
  const hash = evaluateConfinementProof(proof, fakeExpectation({ helperSha256: "0".repeat(64) }));
  assert.deepEqual([hash.complete, hash.identityMismatches, hash.passed.length], [false, ["helperSha256"], CONFINEMENT_FACTS.length]);
  const foreignHelper = evaluateConfinementProof(fakeProofResult({ patch: { helperSha256: "f".repeat(64) } }), fakeExpectation());
  assert.deepEqual([foreignHelper.complete, foreignHelper.identityMismatches], [false, ["helperSha256"]]);
  assert.deepEqual(evaluateConfinementProof(proof, fakeExpectation({ backend: "other-backend" })).identityMismatches, ["backend"]);
  assert.deepEqual(evaluateConfinementProof(proof, fakeExpectation({ platform: "linux-x64" })).identityMismatches, ["platform"]);
  const at = Date.parse(FAKE_OBSERVED_AT);
  for (const observedWindow of [{ notBeforeMs: at + 1, notAfterMs: at + 10_000 }, { notBeforeMs: at - 10_000, notAfterMs: at - 1 }])
    assert.deepEqual(evaluateConfinementProof(proof, fakeExpectation({ observedWindow })).identityMismatches, ["observedAt"],
      "stale, replayed or future observation");
  assert.equal(evaluateConfinementProof(proof, fakeExpectation({ observedWindow: { notBeforeMs: at, notAfterMs: at } })).complete, true);
  const all = evaluateConfinementProof(proof, { backend: "other", helperSha256: "0".repeat(64), platform: "darwin-arm64",
    observedWindow: { notBeforeMs: 0, notAfterMs: 1 } });
  assert.deepEqual(all.identityMismatches, ["backend", "helperSha256", "platform", "observedAt"]);
  // An identity mismatch and a failed fact are reported together; neither hides the other.
  const both = evaluateConfinementProof(fakeProofResult({ states: { networkIsolation: "observedFail" } }),
    fakeExpectation({ helperSha256: "0".repeat(64) }));
  assert.deepEqual([both.complete, both.failed, both.identityMismatches], [false, ["networkIsolation"], ["helperSha256"]]);
  const at0 = { notBeforeMs: 0, notAfterMs: 1 };
  for (const bad of [{ helperSha256: "abc" }, { helperSha256: FAKE_HELPER_SHA256.toUpperCase() }, { backend: "" },
    { backend: "Bad Backend" }, { platform: "win32" }, { observedWindow: { notBeforeMs: 2, notAfterMs: 1 } },
    { observedWindow: { notBeforeMs: -1, notAfterMs: 1 } }, { observedWindow: { ...at0, notAfterMs: 1.5 } },
    { observedWindow: null }] as const)
    assert.throws(() => evaluateConfinementProof(proof, fakeExpectation(bad as never)), kind("InvalidInput"), JSON.stringify(bad));
  assert.throws(() => evaluateConfinementProof(proof, null as never), kind("InvalidInput"));
});

test("O5.5B3 oversized values are malformed, never truncated into validity", () => {
  const valid = fakeProofResult();
  const long = "a".repeat(CONFINEMENT_LIMITS.maxBackendChars + 1);
  assert.equal(validateConfinementProof({ ...valid, backend: "a".repeat(CONFINEMENT_LIMITS.maxBackendChars) }).backend.length,
    CONFINEMENT_LIMITS.maxBackendChars);
  for (const payload of [{ ...valid, backend: long }, { ...valid, backend: "a".repeat(1024 * 1024) },
    { ...valid, helperSha256: "a".repeat(1024 * 1024) }, { ...valid, observedAt: `${FAKE_OBSERVED_AT}${" ".repeat(4096)}` },
    { ...valid, platform: "x".repeat(1024 * 1024) },
    withObservations([...observations(), observations()[0]]),
    withObservations(Array.from({ length: 100_000 }, () => observations()[0])),
    replaceObservation(0, { attempts: CONFINEMENT_LIMITS.maxAttempts + 1 }),
    replaceObservation(0, { attempts: Number.MAX_SAFE_INTEGER + 1 }), replaceObservation(0, { attempts: Infinity })])
    assert.throws(() => validateConfinementProof(payload), kind("MalformedOutput"));
  assert.equal(validateConfinementProof(replaceObservation(0, { attempts: CONFINEMENT_LIMITS.maxAttempts })).observations[0]!.attempts,
    CONFINEMENT_LIMITS.maxAttempts);
  const text = runFakeConfinementBackend();
  assert.ok(text.length < CONFINEMENT_LIMITS.maxResultBytes);
  const padded = `${text}${" ".repeat(CONFINEMENT_LIMITS.maxResultBytes - text.length)}`;
  assert.equal(decodeConfinementProof(padded).backend, FAKE_BACKEND);
  assert.throws(() => decodeConfinementProof(`${padded} `), kind("MalformedOutput", /size limit/u));
  // The byte bound, not the character count, decides: multi-byte padding within the character count is refused.
  const multiByte = `${text}${"\u00a0".repeat(CONFINEMENT_LIMITS.maxResultBytes - text.length)}`;
  assert.throws(() => decodeConfinementProof(multiByte), kind("MalformedOutput", /size limit/u));
  assert.throws(() => decodeConfinementProof("x".repeat(10 * 1024 * 1024)), kind("MalformedOutput", /size limit/u));
});

test("O5.5B3 unknown properties are rejected at every level", () => {
  for (const extra of [{ env: { PATH: "C:\\Windows" } }, { stdout: "log" }, { source: "const x = 1;" },
    { token: "secret" }, { detail: "free text" }, { complete: true }, { productionEligible: true }, { summary: "ok" }])
    assert.throws(() => validateConfinementProof(fakeProofResult({ patch: extra })),
      kind("MalformedOutput", /extra properties/u), Object.keys(extra)[0]);
  for (const extra of [{ detail: "denied" }, { path: "C:\\Users\\x\\secret" }, { message: "ok" }, { evidence: [] }])
    assert.throws(() => validateConfinementProof(replaceObservation(3, extra)), kind("MalformedOutput", /extra properties/u));
  // A JSON "__proto__" key is an own property, so it is an unknown property rather than a prototype change.
  const proto = runFakeConfinementBackend().replace(`{"protocolVersion"`, `{"__proto__":{"complete":true},"protocolVersion"`);
  assert.throws(() => decodeConfinementProof(proto), kind("MalformedOutput"));
});

test("O5.5B3 contradictory results are rejected", () => {
  const contradictions = [
    replaceObservation(0, { state: "observedPass", attempts: 0, failures: 0 }), // pass without any observation
    replaceObservation(0, { state: "observedPass", attempts: 2, failures: 1 }), // pass despite a failed attempt
    replaceObservation(0, { state: "observedFail", attempts: 2, failures: 0 }), // fail without a failed attempt
    replaceObservation(0, { state: "observedFail", attempts: 0, failures: 0 }),
    replaceObservation(0, { state: "notObserved", attempts: 1, failures: 0 }), // attempts contradict notObserved
    replaceObservation(0, { state: "notObserved", attempts: 1, failures: 1 }),
    replaceObservation(0, { attempts: 1, failures: 2 }), // more failures than attempts
  ];
  for (const [index, payload] of contradictions.entries())
    assert.throws(() => validateConfinementProof(payload), kind("MalformedOutput"), `contradiction ${index}`);
  // The same fact twice, even with agreeing or conflicting states, and one fact missing to keep the count.
  const list = observations();
  for (const duplicate of [{ ...list[0] }, { ...list[0], state: "observedFail", failures: 1 }])
    assert.throws(() => validateConfinementProof(withObservations([...list.slice(0, 9), duplicate])),
      kind("MalformedOutput", /more than once/u));
  // A duplicate JSON key is a contradiction, never resolved last-wins.
  const text = runFakeConfinementBackend();
  for (const duplicated of [text.replace(`"state":"observedPass"`, `"state":"observedFail","state":"observedPass"`),
    text.replace(`"backend":"${FAKE_BACKEND}"`, `"backend":"other","backend":"${FAKE_BACKEND}"`),
    text.replace(`{"protocolVersion":1`, `{"protocolVersion":2,"protocolVersion":1`)])
    assert.throws(() => decodeConfinementProof(duplicated), kind("MalformedOutput", /duplicateKey/u));
});

test("O5.5B3 the fake backend never satisfies production readiness", async () => {
  const evaluation = evaluateConfinementProof(decodeConfinementProof(runFakeConfinementBackend()), fakeExpectation());
  assert.equal(evaluation.complete, true);
  assert.equal(evaluation.productionEligible, false);
  // Readiness is unchanged: the Writer gate stays closed and verification isolation remains an open prerequisite.
  assert.deepEqual(writerReadiness(), { ready: false, code: REAL_WRITER_MODE_NOT_READY, prerequisites: REAL_WRITER_MODE_PREREQUISITES });
  assert.ok(REAL_WRITER_MODE_PREREQUISITES.some(prerequisite => prerequisite.id === "verificationIsolation"));
  // No production module can reach the test-only fake, and only the proof contract itself and the O5.5B4
  // verification backend abstraction may reference the proof. The backend references the proof TYPE
  // conservatively: it keeps productionEligible false and never makes a proof authoritative (see its tests).
  const root = join(process.cwd(), "src");
  const files = (await readdir(root, { recursive: true })).filter(file => file.endsWith(".ts"));
  assert.ok(files.length > 20);
  const proofReferrers = new Set(["verification/confinement-proof.ts", "verification/backend.ts"]);
  for (const file of files) {
    const rel = file.replace(/\\/gu, "/");
    const source = await readFile(join(root, file), "utf8");
    assert.doesNotMatch(source, /fake-confinement|test-fake|["'](?:\.\.\/)+test\//u, file);
    if (![...proofReferrers].some(allowed => rel.endsWith(allowed))) assert.doesNotMatch(source, /confinement-proof/u, file);
  }
});
