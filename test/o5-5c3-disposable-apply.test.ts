import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import * as rehearsal from "../src/app/delivery-rehearsal.js";
import { DELIVERY_REHEARSAL_AUTHORIZATIONS, REHEARSAL_CHANGE, REHEARSAL_FIXTURE, REHEARSAL_SENSITIVE_CANARY, rehearsalChangeIdentity,
  rehearsalFixtureIdentity } from "../src/app/delivery-rehearsal.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";

/**
 * O5.5C3 — the disposable apply rehearsal after its one live run (PASS, recorded in `o5-5c3-disposable-apply-live.test.ts`).
 * O5.5C4 retired its runner: the production apply policy removed the closed gate and the disposable-target seam the
 * rehearsal was built on (one of its pass criteria was "a plain `fusion apply` stays blocked"). Its offline flow tests went
 * with it; everything they exercised — typed digest, durable approval, precheck before mutation, exact final hashes,
 * canaries, no provider, no network — is exercised on the normal production path by `o5-5c4-production-apply-policy.test.ts`.
 */
const ID = "O5.5C3-DISPOSABLE-APPLY";

test("O5.5C3 (2, 16): the authorization pins the Fusion-authored fixture and change, has no provider or turn budget, and is consumed", () => {
  const entry = DELIVERY_REHEARSAL_AUTHORIZATIONS[ID]!;
  assert.deepEqual(Object.keys(entry).sort(), ["changeSha256", "fixtureSha256", "milestone", "namespace", "state"], "no roles, families or turns");
  assert.deepEqual([entry.milestone, entry.namespace, entry.state, entry.fixtureSha256, entry.changeSha256],
    ["O5.5C3", "fusion-o5-5c3-delivery", "consumed", rehearsalFixtureIdentity(), rehearsalChangeIdentity()], "consumed by the human's one run (Stage 2)");
  assert.deepEqual(REHEARSAL_CHANGE.operations.map(op => [op.kind, op.path, op.expectedSha256 === null ? "absent" : "present"]),
    [["writeText", "src/greeting.ts", "present"], ["writeText", "src/farewell.ts", "absent"], ["delete", "docs/obsolete.md", "present"]]);
  assert.ok(REHEARSAL_FIXTURE[".gitignore"]!.includes(REHEARSAL_SENSITIVE_CANARY.path), "the sensitive canary is ignored");
  assert.ok(Object.values(DELIVERY_REHEARSAL_AUTHORIZATIONS).every(authorization => authorization.state !== "open"), "no rehearsal authorization is open");
});

test("O5.5C3 retired by O5.5C4: no runner, no live entry, no disposable-target seam — the recorded evidence stays validatable", async () => {
  assert.ok(!("runDeliveryRehearsal" in rehearsal), "the runner is gone");
  assert.equal(typeof rehearsal.validateDeliveryRehearsalEvidence, "function", "the evidence validator stays");
  assert.ok(!existsSync(resolve("test", "live", "delivery-apply-rehearsal.ts")) && !existsSync(resolve("dist", "test", "live", "delivery-apply-rehearsal.js")),
    "the live entry is gone");
  for (const file of ["src/app/control-plane.js", "src/app/delivery-service.js", "src/app/delivery-rehearsal.js", "src/cli/run.js", "src/cli/main.js"])
    assert.ok(!(await readFile(resolve("dist", file), "utf8")).includes("disposableDeliveryTargets"), `${file}: no disposable-target seam`);
});

test("O5.5C3 readiness: the recorded live pass satisfies its own row only; every listed flag unchanged", () => {
  const report = writerGateReport();
  const rows = Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.disposablePrimaryApplyLive, ["satisfied", "recordedLiveProbe"]);
  assert.deepEqual([rows.humanApprovedDelivery, rows.hostControlledWriterWorkflow, rows.liveGateAuthorization],
    [["partial", "mechanical"], ["satisfied", "recordedLiveProbe"], ["blocked", "none"]]);
  assert.deepEqual([rows.deliveryStoreImplementation, rows.deliveryInspectImplementation, rows.humanApprovalImplementation],
    [["satisfied", "mechanical"], ["satisfied", "mechanical"], ["satisfied", "mechanical"]]);
  assert.deepEqual([report.realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED], [false, false]);
});
