/** Recorded live delivery evidence: O5.5C3 Stage 2 and the v0.6 attended production builds (no imports; the readiness report reads them). */

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

/**
 * v0.6 O6 Phase 2 — recorded ATTENDED production builds. These are the normal `fusion build` (a human confirmed each
 * build) on disposable primaries, read back from Fusion's own run and delivery stores into
 * `docs/v0.6-o6-phase2-audit.json`; a test keeps each record equal to that audit. Ids and digests only. A record proves
 * the attended route up to its last recorded delivery event. It authorizes nothing: the unattended Writer stays refused,
 * and no ordinary checkout is a target.
 */
export interface AttendedProductionBuildRecord {
  readonly milestone: "O6-P2";
  readonly runId: string;
  readonly risk: "low" | "medium";
  readonly deliveryId: string;
  readonly manifestSha256: string;
  /** Real provider turns the run recorded, by role. */
  readonly turns: Readonly<{ lead: number; worker: number; reviewer: number; adjudication: number }>;
  readonly candidates: number;
  readonly verificationBackend: "docker-linux";
  readonly evidenceDecision: "VERIFIED";
  /**
   * The delivery's last lifecycle event. `prepared`: it awaits the human. `applied`: after the exact typed approval, the
   * precheck passed, the single-use claim was taken and the delivery was applied.
   */
  readonly lastDeliveryEvent: "prepared" | "applied";
  /** Every live delivery so far targeted a disposable primary, never an ordinary checkout. */
  readonly primary: "disposable";
}
const ATTENDED_PRODUCTION_BUILD_RECORDS: readonly AttendedProductionBuildRecord[] = Object.freeze([
  Object.freeze({ milestone: "O6-P2" as const, runId: "r-00muuocp5h-96b3f6edb2cec638ba22e46029226901", risk: "low" as const,
    deliveryId: "d-94044f8a3efb2126b9def0e9", manifestSha256: "9dbf29eccf197bbb63c7c173e9e24de8b47a88a63666db25334da7a95debdf0c",
    turns: Object.freeze({ lead: 0, worker: 1, reviewer: 0, adjudication: 0 }), candidates: 1, verificationBackend: "docker-linux" as const,
    evidenceDecision: "VERIFIED" as const, lastDeliveryEvent: "applied" as const, primary: "disposable" as const }),
  Object.freeze({ milestone: "O6-P2" as const, runId: "r-00muvvj46m-48b94c671ceea9abe8157481aff25922", risk: "medium" as const,
    deliveryId: "d-a866231c9d006fdda212f3fa", manifestSha256: "16c4b0e1295f3899b4cd9d2fe0d53ed63c451239ce4d92587692d5a55b919fe0",
    turns: Object.freeze({ lead: 2, worker: 2, reviewer: 2, adjudication: 0 }), candidates: 2, verificationBackend: "docker-linux" as const,
    evidenceDecision: "VERIFIED" as const, lastDeliveryEvent: "prepared" as const, primary: "disposable" as const }),
]);
export const attendedProductionBuildRecords = (): readonly AttendedProductionBuildRecord[] => ATTENDED_PRODUCTION_BUILD_RECORDS;
