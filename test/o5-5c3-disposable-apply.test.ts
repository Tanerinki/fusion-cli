import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DELIVERY_REHEARSAL_AUTHORIZATIONS, REHEARSAL_CHANGE, REHEARSAL_FIXTURE, REHEARSAL_SENSITIVE_CANARY, rehearsalChangeIdentity,
  rehearsalFixtureIdentity, runDeliveryRehearsal, validateDeliveryRehearsalEvidence, type DeliveryRehearsalAuthorization,
  type DeliveryRehearsalDependencies, type DeliveryRehearsalReport } from "../src/app/delivery-rehearsal.js";
import { REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { APPROVAL_QUESTION } from "../src/cli/render-delivery.js";
import { FusionFailure } from "../src/core/errors.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5C3 Stage 1 — the disposable apply rehearsal, offline: every run uses a namespace inside a fresh temporary directory
 * (never the live %TEMP%\fusion-o5-5c3-delivery), a stand-in Git repository as "the Fusion checkout", and an injected
 * terminal whose prompt types the digest it read from the rehearsal's own output (the live run waits for the human).
 */
const skip = gitAvailable ? false : "git executable unavailable";
const ID = "O5.5C3-DISPOSABLE-APPLY";
/** The real authorization is consumed (O5.5C3 Stage 2): offline runs use an open copy of it, in temporary namespaces only. */
const OPEN_FOR_TESTS: Readonly<Record<string, DeliveryRehearsalAuthorization>> = { [ID]: { ...DELIVERY_REHEARSAL_AUTHORIZATIONS[ID]!, state: "open" } };
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;

async function withTemp<T>(work: (dir: string, checkout: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-c3-")));
  try {
    const checkout = join(dir, "fusion-standin");
    await mkdir(checkout);
    await writeFile(join(checkout, "README.md"), "# stand-in for the Fusion checkout\n");
    git(checkout, "init", "-q"); git(checkout, "add", "."); git(checkout, "commit", "-qm", "standin");
    return await work(dir, checkout);
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
interface Rehearsal { report: Awaited<ReturnType<typeof runDeliveryRehearsal>>; output: string; questions: string[] }
async function rehearse(dir: string, checkout: string, options: { answer?: "digest" | string | null; interactive?: boolean; authorization?: string;
  authorizations?: Readonly<Record<string, DeliveryRehearsalAuthorization>>; namespaceRoot?: string; fusionCheckout?: string;
  afterClaim?: DeliveryRehearsalDependencies["afterClaim"] } = {}): Promise<Rehearsal> {
  let output = "";
  const questions: string[] = [];
  const answer = "answer" in options ? options.answer : "digest";
  const report = await runDeliveryRehearsal({ authorization: options.authorization ?? ID, env: process.env, compiledRoot: resolve("dist"),
    fusionCheckout: options.fusionCheckout ?? checkout, namespaceRoot: options.namespaceRoot ?? join(dir, "ns"),
    authorizations: options.authorizations ?? OPEN_FOR_TESTS, ...(options.afterClaim ? { afterClaim: options.afterClaim } : {}),
    io: { stdout: text => { output += text; }, stderr: text => { output += text; }, interactive: options.interactive ?? true,
      prompt: async question => {
        questions.push(question);
        // The injected "human" reads the digest from the summary it was shown, exactly as the live human does.
        return answer === "digest" ? /^Manifest SHA-256: ([0-9a-f]{64})$/mu.exec(output)?.[1] ?? null : answer;
      } } });
  return { report, output, questions };
}
const completed = (run: Rehearsal): DeliveryRehearsalReport => {
  assert.ok(!("refused" in run.report), `refused: ${JSON.stringify(run.report)}`);
  return run.report as DeliveryRehearsalReport;
};
const refusedFor = (run: Rehearsal, reason: string) => {
  assert.ok("refused" in run.report, `expected a refusal: ${JSON.stringify(run.report).slice(0, 300)}`);
  assert.equal((run.report as { reason: string }).reason, reason);
};

test("O5.5C3 (2, 16): the authorization pins the Fusion-authored fixture and change, has no provider or turn budget, and targets the fresh namespace", () => {
  const entry = DELIVERY_REHEARSAL_AUTHORIZATIONS[ID]!;
  assert.deepEqual(Object.keys(entry).sort(), ["changeSha256", "fixtureSha256", "milestone", "namespace", "state"], "no roles, families or turns");
  assert.deepEqual([entry.milestone, entry.namespace, entry.state, entry.fixtureSha256, entry.changeSha256],
    ["O5.5C3", "fusion-o5-5c3-delivery", "consumed", rehearsalFixtureIdentity(), rehearsalChangeIdentity()], "consumed by the human's one run (Stage 2)");
  assert.deepEqual(REHEARSAL_CHANGE.operations.map(op => [op.kind, op.path, op.expectedSha256 === null ? "absent" : "present"]),
    [["writeText", "src/greeting.ts", "present"], ["writeText", "src/farewell.ts", "absent"], ["delete", "docs/obsolete.md", "present"]]);
  assert.ok(REHEARSAL_FIXTURE[".gitignore"]!.includes(REHEARSAL_SENSITIVE_CANARY.path), "the sensitive canary is ignored");
});

test("O5.5C3 (3, 4, 7, 9, 10, 12, 13, 15): one full offline rehearsal through the real CLI passes every criterion; bounded evidence", { skip }, async () =>
  withTemp(async (dir, checkout) => {
    const connects: string[] = [];
    const originalConnect = Socket.prototype.connect, originalFetch = globalThis.fetch;
    Socket.prototype.connect = function (this: Socket, ...args: unknown[]) { connects.push(JSON.stringify(args[0] ?? null)); return originalConnect.apply(this, args as never); } as typeof originalConnect;
    globalThis.fetch = (async () => { connects.push("fetch"); throw new Error("no network"); }) as typeof fetch;
    let run: Rehearsal;
    try { run = await rehearse(dir, checkout); }
    finally { Socket.prototype.connect = originalConnect; globalThis.fetch = originalFetch; }
    const report = completed(run);
    assert.equal(report.outcome, "PASS", `${report.detail}\n${run.output}`);
    const e = report.evidence;
    // (3) The real CLI rendered the inspection, the approval summary and the apply report.
    for (const shown of ["--- fusion inspect-delivery ---", "Delivery: d-", "Approve delivery d-", "Result: applied (phase done)"]) assert.ok(run.output.includes(shown), shown);
    assert.match(run.output, new RegExp(`^Manifest: sha256:${e.delivery!.manifestSha256}$`, "mu"), "the full digest is printed");
    assert.deepEqual(e.exitCodes, { inspect: 0, approve: 0, apply: 0 });
    // (4) The approval came from the CLI's own question, answered with the exact digest.
    assert.deepEqual(run.questions, [APPROVAL_QUESTION]);
    // (10) The durable approval binds exactly this delivery.
    assert.deepEqual(e.approval, { present: true, confirmation: "typedManifestSha256", bindsDeliveryId: true, bindsManifest: true, bindsBundle: true,
      bindsRepository: true, bindsBase: true });
    // (7) The target is the repository this rehearsal created inside its fresh namespace; the store is outside it.
    assert.deepEqual([e.target!.classification, e.target!.createdBy, e.target!.underFreshNamespace, e.target!.registeredDisposableTargets,
      e.target!.fixtureSha256, e.target!.changeSha256], ["disposable", "fusion", true, 1, rehearsalFixtureIdentity(), rehearsalChangeIdentity()]);
    assert.deepEqual([e.store!.pathClass, e.store!.outsideTarget], ["rehearsalNamespace", true]);
    // (9) A plain `fusion apply` of the approved delivery stayed blocked: the production gate is closed.
    assert.deepEqual(e.productionGate, { liveDeliveryAuthorized: false, liveGateAuthorized: false, plainApplyExitCode: 11, plainApplyResult: "blocked" });
    // (11, 12) Precheck, apply and postcheck; exact final hashes; canaries unchanged; no undeclared change; valid event order.
    assert.deepEqual(e.phases, { precheck: "passed", apply: "applied", postcheck: "passed", rollback: null });
    assert.equal(e.heads.expected, e.heads.observed);
    assert.deepEqual(e.files.map(f => [f.path, f.kind, f.matches]), [["src/greeting.ts", "update", true], ["src/farewell.ts", "create", true], ["docs/obsolete.md", "delete", true]]);
    assert.equal(e.files[2]!.finalSha256, null);
    assert.deepEqual(e.canaries.map(c => [c.path, c.class, c.unchanged]), [["CANARY.md", "untouched", true], [".env", "sensitive", true]]);
    assert.deepEqual(e.undeclaredChanged, []);
    assert.deepEqual(e.git.status, [{ code: "!!", path: ".env" }, { code: " D", path: "docs/obsolete.md" }, { code: "??", path: "src/farewell.ts" },
      { code: " M", path: "src/greeting.ts" }]);
    assert.equal(e.git.statusMatchesExpected, true);
    assert.deepEqual(e.events.map(event => event.type), ["prepared", "approved", "applyStarted", "precheckStarted", "precheckPassed", "applied"]);
    assert.ok(Object.values(e.checks).every(Boolean), JSON.stringify(e.checks));
    // (15) No provider, no model, no network.
    assert.deepEqual(e.processes, { providerFactoriesReached: 0, modelTurns: 0 });
    assert.deepEqual(connects, []);
    // The Fusion checkout is untouched; the disposable repository is removed; only the bounded evidence stays.
    assert.equal(e.fusionCheckout.unchanged, true);
    assert.equal(e.cleanup.workRemoved, true);
    assert.deepEqual((await readdir(join(dir, "ns"))).sort(), ["namespace.json", "rehearsal.claim.json", "rehearsal.evidence.json"]);
    // (13) The evidence file validates, is bounded, and carries no file content, fixture text or canary value.
    const stored = JSON.parse(await readFile(report.evidencePath, "utf8")) as unknown;
    validateDeliveryRehearsalEvidence(stored);
    const text = JSON.stringify(stored);
    assert.ok(text.length < 64 * 1024);
    for (const hidden of ["Hello, ${name}!", "Goodbye", "Obsolete notes", "never changes this file", REHEARSAL_SENSITIVE_CANARY.content.trim(), "TOKEN="])
      assert.ok(!text.includes(hidden), hidden);
    const leaked = { ...(stored as Record<string, unknown>), detail: `leak ${REHEARSAL_SENSITIVE_CANARY.content.trim()}` };
    assert.throws(() => validateDeliveryRehearsalEvidence(leaked), kind("SecurityViolation"));
    assert.throws(() => validateDeliveryRehearsalEvidence({ ...(stored as Record<string, unknown>), extra: 1 }), kind("SecurityViolation"));
    // (1, 16) The authorization is consumed: it cannot be replayed.
    refusedFor(await rehearse(dir, checkout), "alreadyAttempted");
  }));

test("O5.5C3 (5, 6): a wrong or empty digest applies nothing and leaves the authorization unconsumed; a non-interactive run creates nothing", { skip }, async () =>
  withTemp(async (dir, checkout) => {
    // (6) Non-interactive: refused before the namespace exists.
    refusedFor(await rehearse(dir, checkout, { interactive: false }), "nonInteractive");
    assert.ok(!existsSync(join(dir, "ns")));
    // (5) Wrong answers: DECLINED, nothing claimed, the disposable repository removed, attempt evidence kept.
    for (const answer of [null, "", "yes", "0".repeat(64)]) {
      const run = completed(await rehearse(dir, checkout, { answer }));
      assert.equal(run.outcome, "DECLINED", String(answer));
      assert.deepEqual([run.evidence.authorization.claim, run.evidence.approval.present, run.evidence.exitCodes.apply, run.evidence.phases.apply],
        ["notClaimed", false, null, "notRun"]);
      assert.deepEqual(run.evidence.events, []);
      assert.equal(run.evidence.cleanup.workRemoved, true);
    }
    const entries = (await readdir(join(dir, "ns"))).sort();
    assert.ok(!entries.includes("rehearsal.claim.json") && !entries.includes("rehearsal.evidence.json"));
    assert.equal(entries.filter(name => name.startsWith("rehearsal.attempt-")).length, 4);
    assert.ok(!entries.some(name => name.startsWith("work-")), "no disposable repository left behind");
    // Still unconsumed: the exact digest now passes in the same namespace.
    assert.equal(completed(await rehearse(dir, checkout)).outcome, "PASS");
  }));

test("O5.5C3 (11, 12): drift after the claim fails the precheck before any write; a changed ignored canary is caught by the independent check", { skip }, async () =>
  withTemp(async (dir, checkout) => {
    const drift = completed(await rehearse(dir, checkout, { namespaceRoot: join(dir, "ns-drift"),
      afterClaim: async primary => { await writeFile(join(primary, "README.md"), "# moved\n"); git(primary, "commit", "-qam", "moved"); } }));
    assert.equal(drift.outcome, "FAIL");
    assert.deepEqual([drift.evidence.phases.precheck, drift.evidence.phases.apply, drift.evidence.authorization.claim], ["failed", "failed", "claimed"]);
    assert.notEqual(drift.evidence.heads.observed, drift.evidence.heads.expected, "the observed HEAD is recorded");
    assert.ok(drift.evidence.files.every(file => !file.matches), "no declared file was written");
    assert.deepEqual(drift.evidence.canaries.map(c => c.unchanged), [true, true]);
    // An ignored canary changed during the run: the applier does not look at it, the independent verification does.
    const canary = completed(await rehearse(dir, checkout, { namespaceRoot: join(dir, "ns-canary"),
      afterClaim: async primary => writeFile(join(primary, ".env"), "REHEARSAL_TOKEN=changed\n") }));
    assert.equal(canary.outcome, "FAIL");
    assert.equal(canary.evidence.checks.canariesUnchanged, false);
    assert.match(canary.detail, /canariesUnchanged/u);
  }));

test("O5.5C3 (1, 7, 8, 14, 16): refusals before anything is created — authorization states, namespaces outside TEMP, foreign or claimed namespaces, the Fusion checkout", { skip }, async () =>
  withTemp(async (dir, checkout) => {
    const base = OPEN_FOR_TESTS[ID]!;
    for (const [state, reason] of [["pending", "authorizationPending"], ["consumed", "authorizationConsumed"], ["retired", "authorizationRetired"]] as const)
      refusedFor(await rehearse(dir, checkout, { authorizations: { [ID]: { ...base, state } }, namespaceRoot: join(dir, `ns-${state}`) }), reason);
    refusedFor(await rehearse(dir, checkout, { authorization: "O5.5C3-UNKNOWN" }), "unknownAuthorization");
    // The real, consumed authorization refuses before anything exists.
    refusedFor(await rehearse(dir, checkout, { authorizations: DELIVERY_REHEARSAL_AUTHORIZATIONS, namespaceRoot: join(dir, "ns-real") }), "authorizationConsumed");
    assert.ok(!existsSync(join(dir, "ns-real")));
    refusedFor(await rehearse(dir, checkout, { authorizations: { [ID]: { ...base, fixtureSha256: "0".repeat(64) } } }), "fixtureMismatch");
    // (14) The real Fusion checkout is never a target: a namespace inside it is outside TEMP; a stand-in checkout in TEMP overlaps.
    refusedFor(await rehearse(dir, checkout, { namespaceRoot: resolve("rehearsal-ns"), fusionCheckout: resolve(".") }), "namespaceOutsideTemp");
    assert.ok(!existsSync(resolve("rehearsal-ns")));
    refusedFor(await rehearse(dir, checkout, { namespaceRoot: join(checkout, "ns") }), "namespaceOverlapsCheckout");
    refusedFor(await rehearse(dir, checkout, { namespaceRoot: await realpath(tmpdir()) }), "namespaceOutsideTemp");
    // (8) A namespace holding anything Fusion did not create there — another repository — or another authorization's marker.
    const foreign = join(dir, "ns-foreign");
    await mkdir(join(foreign, "other-repo"), { recursive: true });
    await writeFile(join(foreign, "namespace.json"), `${JSON.stringify({ authorization: ID, milestone: "O5.5C3" })}\n`);
    refusedFor(await rehearse(dir, checkout, { namespaceRoot: foreign }), "namespaceMismatch");
    const other = join(dir, "ns-other");
    await mkdir(other);
    await writeFile(join(other, "namespace.json"), `${JSON.stringify({ authorization: "O5.5B31-CORRECTION", milestone: "O5.5B31" })}\n`);
    refusedFor(await rehearse(dir, checkout, { namespaceRoot: other }), "namespaceMismatch");
    // (16) A claim already present: refused, nothing else created.
    const claimed = join(dir, "ns-claimed");
    await mkdir(claimed);
    await writeFile(join(claimed, "namespace.json"), `${JSON.stringify({ authorization: ID, milestone: "O5.5C3" })}\n`);
    await writeFile(join(claimed, "rehearsal.claim.json"), "{}\n");
    refusedFor(await rehearse(dir, checkout, { namespaceRoot: claimed }), "alreadyAttempted");
    assert.deepEqual((await readdir(claimed)).sort(), ["namespace.json", "rehearsal.claim.json"]);
  }));

test("O5.5C3 (3, 9, 15): static — the rehearsal reuses the CLI and the delivery service, builds no parallel apply engine; the production entry never enables it", async () => {
  const text = await readFile(resolve("dist", "src", "app", "delivery-rehearsal.js"), "utf8");
  for (const reused of ["../cli/run.js", "./delivery-service.js", "\"inspect-delivery\"", "\"approve-delivery\"", "\"apply\""]) assert.ok(text.includes(reused), reused);
  for (const banned of ["LocalFilesystemDeliveryApplier", "DeliveryRecord", "issueTestOnlyApproval", "humanApprovalRecord", "writeApproval", "beginApply",
    "/providers/", "child_process", "node:net", "node:http", "fetch(", "process.env"]) assert.ok(!text.includes(banned), banned);
  for (const file of ["main.js", "run.js", "args.js"]) {
    const cli = await readFile(resolve("dist", "src", "cli", file), "utf8");
    for (const banned of ["delivery-rehearsal", "disposableDeliveryTargets", "deliveryStoreRoot"]) assert.ok(!cli.includes(banned), `${file}: ${banned}`);
  }
  const entry = await readFile(resolve("dist", "test", "live", "delivery-apply-rehearsal.js"), "utf8");
  assert.ok(entry.includes("interactiveTerminal()") && entry.includes("prompt: promptLine"), "the live entry asks the human at the terminal");
  assert.ok(!/manifestSha256\s*[,)]/u.test(entry.split("runDeliveryRehearsal(")[1]!.split("});")[0]!), "the live entry feeds no digest");
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
