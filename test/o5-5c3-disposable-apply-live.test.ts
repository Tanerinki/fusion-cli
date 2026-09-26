import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { disposableApplyLiveRecords } from "../src/app/delivery-live-records.js";
import { DELIVERY_REHEARSAL_AUTHORIZATIONS, REHEARSAL_CHANGE, REHEARSAL_FIXTURE, REHEARSAL_SENSITIVE_CANARY, REHEARSAL_UNTOUCHED_CANARY,
  rehearsalChangeIdentity, rehearsalFixtureIdentity, validateDeliveryRehearsalEvidence, type DeliveryRehearsalEvidence } from "../src/app/delivery-rehearsal.js";
import { FusionFailure } from "../src/core/errors.js";

/**
 * O5.5C3 Stage 2 — the human's one live run of O5.5C3-DISPOSABLE-APPLY, revalidated offline from a byte-exact copy of its
 * evidence file (`test/fixtures/o5-5c3-rehearsal.evidence.json`, copied from %TEMP%\fusion-o5-5c3-delivery): the production
 * validator, then 21 named criteria recomputed here (final hashes and canary hashes from the pinned fixture bytes).
 */
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const STAGE1 = Object.freeze({ compiledSourceSha256: "9613897911222a5b0e40c45398324ee40d99adc578a10450b08b17fee106b2b5", compiledFiles: 126,
  liveEntrySha256: "f061e8463bd9cc9a58bb4661c14a08208393c845e4ba1369f9e9efbc7a608825" });
const RECORDED_EVENTS = ["prepared", "approved", "applyStarted", "precheckStarted", "precheckPassed", "applied"];

async function recordedEvidence(): Promise<{ bytes: Buffer; evidence: DeliveryRehearsalEvidence }> {
  // A checkout may convert the fixture's line endings; the recorded digest is over the original LF bytes.
  const bytes = Buffer.from((await readFile(resolve("test", "fixtures", "o5-5c3-rehearsal.evidence.json"), "utf8")).replace(/\r\n/gu, "\n"), "utf8");
  return { bytes, evidence: JSON.parse(bytes.toString("utf8")) as DeliveryRehearsalEvidence };
}

/** The 21 Stage-2 criteria, each recomputed from the evidence and the pinned fixture (never from the evidence's own checks alone). */
export function stage2Criteria(e: DeliveryRehearsalEvidence, bytes: Buffer): Array<readonly [string, boolean]> {
  const expectedFinal = Object.fromEntries(REHEARSAL_CHANGE.operations.map(op => [op.path, op.kind === "delete" ? null : sha256(op.content)]));
  const types = e.events.map(event => event.type);
  const canary = (path: string) => e.canaries.find(c => c.path === path);
  const untouched = sha256(REHEARSAL_FIXTURE[REHEARSAL_UNTOUCHED_CANARY]!), sensitive = sha256(REHEARSAL_SENSITIVE_CANARY.content);
  const text = bytes.toString("utf8");
  let schemaValid = true;
  try { validateDeliveryRehearsalEvidence(e); } catch { schemaValid = false; }
  return [
    ["1 evidence schema valid", schemaValid && e.format === "fusion.deliveryRehearsalEvidence" && e.version === 1 && e.outcome === "PASS"],
    ["2 Stage-1 compiled fingerprint", e.harness !== "notRecorded" && e.harness.compiledSourceSha256 === STAGE1.compiledSourceSha256 && e.harness.compiledFiles === STAGE1.compiledFiles],
    ["3 Stage-1 live-entry fingerprint", e.harness !== "notRecorded" && e.harness.liveEntrySha256 === STAGE1.liveEntrySha256],
    ["4 authorization consumed once", e.authorization.id === "O5.5C3-DISPOSABLE-APPLY" && e.authorization.claim === "claimed" && e.authorization.claimedAt !== null &&
      e.checks.authorizationClaimedOnce === true],
    ["5 exact human manifest digest confirmation", e.approval.confirmation === "typedManifestSha256" && e.exitCodes.approve === 0 && e.checks.exactDigestTyped === true],
    ["6 durable approval exact binding", e.approval.present && e.approval.bindsDeliveryId && e.approval.bindsManifest && e.approval.bindsBundle &&
      e.approval.bindsRepository && e.approval.bindsBase],
    ["7 disposable-target classification", e.target !== null && e.target.classification === "disposable" && e.target.createdBy === "fusion" &&
      e.target.underFreshNamespace && e.target.registeredDisposableTargets === 1 && e.target.namespace === "fusion-o5-5c3-delivery" &&
      e.target.fixtureSha256 === rehearsalFixtureIdentity() && e.target.changeSha256 === rehearsalChangeIdentity()],
    ["8 production gate remained closed", e.productionGate.plainApplyExitCode === 11 && e.productionGate.plainApplyResult === "blocked" &&
      !e.productionGate.liveDeliveryAuthorized && !e.productionGate.liveGateAuthorized],
    ["9 precheck before mutation", e.phases.precheck === "passed" && types.indexOf("precheckPassed") >= 0 && types.indexOf("precheckPassed") < types.indexOf("applied") &&
      e.heads.expected !== null && e.heads.expected === e.heads.observed && e.heads.expected === e.target?.baseCommit],
    ["10 exact declared M/A/D operations", JSON.stringify(e.files.map(f => [f.kind, f.path])) ===
      JSON.stringify([["update", "src/greeting.ts"], ["create", "src/farewell.ts"], ["delete", "docs/obsolete.md"]])],
    ["11 apply success", e.phases.apply === "applied" && e.exitCodes.apply === 0 && e.phases.rollback === null],
    ["12 postcheck success", e.phases.postcheck === "passed"],
    ["13 final hashes match (recomputed)", e.files.length === 3 && e.files.every(f => f.matches && f.finalSha256 === expectedFinal[f.path] && f.expectedSha256 === expectedFinal[f.path])],
    ["14 untouched canary unchanged (recomputed)", canary(REHEARSAL_UNTOUCHED_CANARY)?.before === untouched && canary(REHEARSAL_UNTOUCHED_CANARY)?.after === untouched],
    ["15 sensitive .env canary unchanged (recomputed)", canary(REHEARSAL_SENSITIVE_CANARY.path)?.class === "sensitive" &&
      canary(REHEARSAL_SENSITIVE_CANARY.path)?.before === sensitive && canary(REHEARSAL_SENSITIVE_CANARY.path)?.after === sensitive],
    ["16 no undeclared change", e.undeclaredChanged.length === 0 && e.git.statusMatchesExpected &&
      JSON.stringify(e.git.status) === JSON.stringify([{ code: "!!", path: ".env" }, { code: " D", path: "docs/obsolete.md" }, { code: "??", path: "src/farewell.ts" },
        { code: " M", path: "src/greeting.ts" }]) && e.git.numstat.every(n => n.path in expectedFinal)],
    ["17 event sequence valid", e.eventOrderValid && JSON.stringify(types) === JSON.stringify(RECORDED_EVENTS) && e.events.every((event, index) => event.seq === index + 1)],
    ["18 zero provider/model activity", e.processes.providerFactoriesReached === 0 && e.processes.modelTurns === 0],
    ["19 fusion-cli checkout unchanged", e.fusionCheckout.unchanged && e.fusionCheckout.before === e.fusionCheckout.after],
    ["20 cleanup complete", e.cleanup.workRemoved === true],
    ["21 no raw contents, secrets or provider replies", schemaValid && !text.includes("TOKEN=") && !text.includes(REHEARSAL_SENSITIVE_CANARY.content.trim()) &&
      !REHEARSAL_CHANGE.operations.some(op => op.kind !== "delete" && text.includes(op.content.split("\n")[1]!.trim())) &&
      !Object.values(REHEARSAL_FIXTURE).some(content => content.split("\n").some(line => line.trim().length >= 12 && text.includes(line.trim())))],
  ];
}

test("O5.5C3 Stage 2: the recorded evidence is the human's run, byte-exact, and passes the production validator and all 21 criteria", async () => {
  const { bytes, evidence } = await recordedEvidence();
  const [record] = disposableApplyLiveRecords();
  assert.ok(record !== undefined);
  assert.deepEqual([bytes.length, sha256(bytes)], [record.evidenceBytes, record.evidenceSha256], "the fixture is the recorded evidence");
  assert.deepEqual([evidence.delivery?.id, evidence.delivery?.manifestSha256, evidence.delivery?.bundleSha256, evidence.target?.baseCommit, evidence.startedAt],
    [record.deliveryId, record.manifestSha256, record.bundleSha256, record.baseCommit, record.startedAt]);
  assert.deepEqual([record.harness.compiledSourceSha256, record.harness.liveEntrySha256], [STAGE1.compiledSourceSha256, STAGE1.liveEntrySha256]);
  validateDeliveryRehearsalEvidence(evidence);
  const criteria = stage2Criteria(evidence, bytes);
  assert.equal(criteria.length, record.validationCriteria);
  for (const [name, ok] of criteria) assert.ok(ok, name);
  assert.equal(Object.keys(evidence.checks).length, record.embeddedChecks);
  assert.ok(Object.values(evidence.checks).every(Boolean));
  assert.equal(DELIVERY_REHEARSAL_AUTHORIZATIONS["O5.5C3-DISPOSABLE-APPLY"]!.state, "consumed");
});

test("O5.5C3 Stage 2: the criteria are not vacuous — tampered evidence fails the validator or a named criterion", async () => {
  const { bytes, evidence } = await recordedEvidence();
  const mutate = (change: (e: Record<string, any>) => void): Record<string, any> => { const copy = JSON.parse(bytes.toString("utf8")) as Record<string, any>; change(copy); return copy; };
  const failing = (e: Record<string, any>) => stage2Criteria(e as DeliveryRehearsalEvidence, Buffer.from(JSON.stringify(e))).filter(([, ok]) => !ok).map(([name]) => name);
  assert.deepEqual(failing(evidence as unknown as Record<string, any>), []);
  const cases: Array<[string, (e: Record<string, any>) => void, string]> = [
    ["another build", e => { e.harness.compiledSourceSha256 = "0".repeat(64); }, "2 Stage-1 compiled fingerprint"],
    ["gate opened", e => { e.productionGate.plainApplyExitCode = 0; }, "8 production gate remained closed"],
    ["HEAD drift", e => { e.heads.observed = "0".repeat(40); }, "9 precheck before mutation"],
    ["wrong final bytes", e => { e.files[0].finalSha256 = "0".repeat(64); }, "13 final hashes match (recomputed)"],
    ["canary changed", e => { e.canaries[1].after = "0".repeat(64); }, "15 sensitive .env canary unchanged (recomputed)"],
    ["undeclared change", e => { e.undeclaredChanged = ["README.md"]; }, "16 no undeclared change"],
    ["events reordered", e => { e.events = [...e.events].reverse(); }, "17 event sequence valid"],
    ["provider reached", e => { e.processes.providerFactoriesReached = 1; }, "18 zero provider/model activity"],
    ["checkout changed", e => { e.fusionCheckout.unchanged = false; }, "19 fusion-cli checkout unchanged"],
  ];
  for (const [name, change, criterion] of cases) assert.ok(failing(mutate(change)).includes(criterion), name);
  assert.throws(() => validateDeliveryRehearsalEvidence(mutate(e => { e.detail = `leak ${REHEARSAL_SENSITIVE_CANARY.content}`; })),
    (error: unknown) => error instanceof FusionFailure && error.error.kind === "SecurityViolation");
});
