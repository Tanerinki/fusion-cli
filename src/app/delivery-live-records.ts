/** O5.5C3 Stage 2 — recorded live delivery rehearsals (no imports; the readiness report reads them). */

/**
 * O5.5C3 Stage 2: the recorded live rehearsal — the human's one run of O5.5C3-DISPOSABLE-APPLY, its evidence file
 * independently revalidated offline (the production validator plus 21 named criteria; a byte-exact copy is kept in
 * `test/fixtures/o5-5c3-rehearsal.evidence.json`). Digests and ids only.
 */
export interface DisposableApplyLiveRecord {
  readonly milestone: "O5.5C3";
  readonly authorization: string;
  readonly outcome: "PASS" | "FAIL";
  readonly startedAt: string;
  readonly evidenceSha256: string;
  readonly evidenceBytes: number;
  readonly deliveryId: string;
  readonly manifestSha256: string;
  readonly bundleSha256: string;
  readonly baseCommit: string;
  readonly harness: Readonly<{ compiledSourceSha256: string; liveEntrySha256: string }>;
  /** The evidence's own pass criteria, and the independent Stage-2 criteria, all true. */
  readonly embeddedChecks: number;
  readonly validationCriteria: number;
}
const DISPOSABLE_APPLY_LIVE_RECORDS: readonly DisposableApplyLiveRecord[] = Object.freeze([Object.freeze({
  milestone: "O5.5C3" as const, authorization: "O5.5C3-DISPOSABLE-APPLY", outcome: "PASS" as const, startedAt: "2026-09-26T02:25:27.413Z",
  evidenceSha256: "551bd9a7972035a9f032aea0d7ac136482d5a8fd696d82bc57b0b64c397d1bdc", evidenceBytes: 5336, deliveryId: "d-0fdbffa15ca3cf3c4a15d8a6",
  manifestSha256: "36960644dad16664103174b06e37be2118bb0331ed33ba231cf1ba9dc84546e2",
  bundleSha256: "15fbbb775326d16a6b3f24ac1cdb7014c43bda5f86dd8cd488b7aad035e70bf0", baseCommit: "8cdef41a1c47ac0a68d6e62872399e2fe000201a",
  harness: Object.freeze({ compiledSourceSha256: "9613897911222a5b0e40c45398324ee40d99adc578a10450b08b17fee106b2b5",
    liveEntrySha256: "f061e8463bd9cc9a58bb4661c14a08208393c845e4ba1369f9e9efbc7a608825" }),
  embeddedChecks: 15, validationCriteria: 21 })]);
export const disposableApplyLiveRecords = (): readonly DisposableApplyLiveRecord[] => DISPOSABLE_APPLY_LIVE_RECORDS;
