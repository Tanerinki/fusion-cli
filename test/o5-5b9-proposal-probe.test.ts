import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { copyFile, link, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { classifyProbe, createProbeFixture, PROBE_BUGGY, PROBE_PACKET, PROBE_TARGET, singleProposalAdapter,
  type ProbeFacts } from "../src/app/proposal-probe.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { bindingEligibility, changeProposalReadiness } from "../src/app/readiness.js";
import type { WriterComposition } from "../src/app/writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import type { ProviderAdapter, Session } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { readStructuredEnvelope } from "../src/platform/process/structured-envelope.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION } from "../src/providers/muse/types.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { changeProposalLiveEvidence, changeProposalLiveRecords, liveChangeProposalCoverage } from "../src/runtime/provider-profiles.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { BASELINE_HASH, claudeBinding, cleanEnv, FIXED, launchesOf, museBinding, probe, PROFILES, PROPOSAL, PROPOSAL_PREFIX,
  rehearsalCompose, report, section, TEST_AUTHORIZATION, testRegistry, withRoot } from "./fixtures/probe-harness.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B9 Stage 1: the authorized real-provider probe harness, proven offline (harness: test/fixtures/probe-harness.ts).
 * Every such run is labelled `offlineRehearsal` and cannot count as live evidence.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const value = (args: readonly string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

// ---------------------------------------------------------------- refusals before anything exists

test("O5.5B9 probe: refused inside a Claude Code session and after a previous attempt, before any fixture or provider process", async () =>
  withRoot(async root => {
    const nested = await probe("muse", { env: cleanEnv({ CLAUDECODE: "1" }), registry: defaultRegistry(), evidenceRoot: join(root, "a") });
    assert.deepEqual([("refused" in nested) && nested.reason], ["nestedAgentSession"]);
    assert.equal(existsSync(join(root, "a")), false, "nothing was created");
    // O5.5B11: a claim counts only inside this authorization's own namespace; a foreign directory is refused outright.
    await writeFile(join(root, "claude.claim.json"), "{}\n");
    const foreign = await probe("claude", { env: cleanEnv(), registry: defaultRegistry(), evidenceRoot: root });
    assert.deepEqual([("refused" in foreign) && foreign.reason], ["namespaceMismatch"]);
    const own = join(root, "own");
    await mkdir(own);
    await writeFile(join(own, "authorization.json"), JSON.stringify({ authorization: TEST_AUTHORIZATION, milestone: "TEST" }));
    await writeFile(join(own, "claude.claim.json"), JSON.stringify({ authorization: TEST_AUTHORIZATION, milestone: "TEST", provider: "claude" }));
    const again = await probe("claude", { env: cleanEnv(), registry: defaultRegistry(), evidenceRoot: own });
    assert.deepEqual([("refused" in again) && again.reason], ["alreadyAttempted"]);
    const unknown = await probe("gemini" as never, { env: cleanEnv(), registry: defaultRegistry(), evidenceRoot: root });
    assert.deepEqual([("refused" in unknown) && unknown.reason], ["unknownProvider"]);
  }));

test("O5.5B9 probe: an unvalidated runtime version is VERSION_BLOCKED by static preflight — no provider process, no claim", { skip },
  async () => withInstalls(async i => withRoot(async root => {
    await writeFile(join(i.dir, "claude-code", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.281" }));
    const claude = report(await probe("claude", { env: cleanEnv(), registry: defaultRegistry(), evidenceRoot: root, binding: claudeBinding(i) }));
    assert.deepEqual([claude.outcome, claude.evidence.stage, claude.modelTurnLaunched], ["VERSION_BLOCKED", "preflight", false]);
    assert.match(claude.detail, /2\.1\.281/u);
    assert.equal(claude.evidence.launches, undefined, "no provider process was started");
    assert.equal(existsSync(join(root, "claude.claim.json")), false, "a preflight block consumes no authorization");
    // Muse: the version file names an unvalidated release whose executable exists.
    await writeFile(join(i.museDir, ".muse-version"), "1.3.1-R9999.1");
    try { await link(i.museExe, join(i.museDir, "muse-bin-1.3.1-R9999.1.exe")); }
    catch { await copyFile(i.museExe, join(i.museDir, "muse-bin-1.3.1-R9999.1.exe")); }
    const muse = report(await probe("muse", { env: cleanEnv(), registry: defaultRegistry(), evidenceRoot: root, binding: museBinding(i) }));
    assert.deepEqual([muse.outcome, muse.evidence.stage, muse.modelTurnLaunched], ["VERSION_BLOCKED", "preflight", false]);
    assert.equal(existsSync(join(root, "muse.claim.json")), false);
    await writeFile(join(i.museDir, ".muse-version"), VERIFIED_EXEC_WEB_DISABLE_VERSION);
  })));

test("O5.5B9 probe: an API key or gateway lane is AUTH_BLOCKED before any provider process (no PAYG fallback)", { skip },
  async () => withInstalls(async i => withRoot(async root => {
    for (const [provider, env, binding] of [["claude", { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" }, claudeBinding(i)],
      ["claude", { ANTHROPIC_BASE_URL: "https://gateway.invalid" }, claudeBinding(i)],
      ["muse", { MODEL_API_KEY: "fixture-key" }, museBinding(i)], ["muse", { META_API_KEY: "fixture-key" }, museBinding(i)]] as const) {
      const sub = join(root, `${provider}-${Object.keys(env)[0]}`);
      const r = report(await probe(provider, { env: cleanEnv(env), registry: defaultRegistry(), evidenceRoot: sub, binding }));
      assert.deepEqual([r.outcome, r.evidence.stage, r.modelTurnLaunched], ["AUTH_BLOCKED", "preflight", false], JSON.stringify(env));
      assert.equal(existsSync(join(sub, `${provider}.claim.json`)), false);
      const text = await readFile(r.evidencePath, "utf8");
      assert.ok(!text.includes("sk-ant-api03-fixture") && !text.includes("fixture-key") && !text.includes("gateway.invalid"),
        "no credential or endpoint value is ever recorded");
    }
  })));

// ---------------------------------------------------------------- the full path, one turn

test("O5.5B9 Claude probe path: one proposal turn in a Fusion view, Fusion baseline hash in the prompt, validated, host-applied and verified; evidence is rehearsal-labelled",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const r = report(await probe("claude", { env: cleanEnv(), evidenceRoot: root, binding: claudeBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: PROPOSAL, FUSION_FAKE_PROMPT_INCLUDES: BASELINE_HASH }),
      compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "PASS", `${r.detail} ${JSON.stringify(r.evidence.workflow)}`);
    assert.equal(r.evidence.evidenceKind, "offlineRehearsal", "a fake provider can never produce live evidence");
    assert.match(r.detail, /offline rehearsal/u);
    const counts = section<Record<string, number>>(r, "launchCounts");
    assert.deepEqual([counts.providerTurn, section<number>(r, "proposalCalls")], [1, 1], "exactly one proposal turn");
    assert.ok((counts.providerInitProbe ?? 0) >= 2 && (counts.providerAuthReadback ?? 0) >= 2 && counts.providerInventory === 1);
    const launches = launchesOf(r);
    assert.ok(launches.every(l => l.cwdClass === "providerView" && l.forbiddenEnvKeys.length === 0), JSON.stringify(launches.map(l => l.cwdClass)));
    const turn = launches.find(l => l.purpose === "providerTurn")!;
    assert.deepEqual(turn.posture, { missing: [], widening: [] });
    assert.deepEqual([value(turn.args, "--model"), value(turn.args, "--effort"), value(turn.args, "--max-turns"), value(turn.args, "--tools")],
      ["alias", "low", "3", "Read,Grep,Glob"]);
    const views = section<Array<{ kind: string; checks: Record<string, boolean>; unchanged: boolean }>>(r, "views");
    assert.deepEqual(views.map(v => [v.kind, v.unchanged, Object.values(v.checks).every(Boolean)]), [["baseline", true, true]]);
    const primary = section<{ unchanged: boolean; canariesUnchanged: boolean }>(r, "primary");
    assert.deepEqual([primary.unchanged, primary.canariesUnchanged], [true, true]);
    const proposal = section<{ validated: Array<{ path: string; expectedSha256: string; content?: string }> }>(r, "proposal");
    assert.deepEqual(proposal.validated.map(op => [op.path, op.expectedSha256, op.content]), [[PROBE_TARGET, BASELINE_HASH, FIXED]]);
    const candidate = section<{ changedPaths: string[]; cleanup: { complete: boolean } }>(r, "candidate");
    assert.deepEqual([candidate.changedPaths, candidate.cleanup.complete], [[PROBE_TARGET], true]);
    const verification = section<{ verdict: { passed: boolean; evidence: { acceptance: string } }; runs: unknown[] }>(r, "verification");
    assert.deepEqual([verification.verdict.passed, verification.verdict.evidence.acceptance, verification.runs.length, runs.count], [true, "offlineRehearsal", 1, 1]);
    const identity = section<Array<{ observedModel: string }>>(r, "identity");
    assert.deepEqual(identity.map(entry => entry.observedModel), ["claude-canonical-fixture"]);
    assert.equal(section<{ apiKeySource: string }>(r, "runtimeReadback").apiKeySource, "none");
    // View root, candidate root and the child-only plugin-settings directory: all attributed, all gone.
    const cleanup = section<{ attributedTemporaries: number; leftoverOwnedTemporaries: string[] }>(r, "cleanup");
    assert.deepEqual([cleanup.attributedTemporaries >= 3, cleanup.leftoverOwnedTemporaries], [true, []], JSON.stringify(cleanup));
    // Nothing opens: the live gate and the provider row are unchanged by any probe.
    assert.equal(REAL_WRITER_LIVE_GATE_AUTHORIZED, false);
    // The provider row reads only recorded live-probe data (O5.5B9 + O5.5B11): the same before and after a rehearsal.
    const recorded = writerGateReport().rows.find(row => row.id === "providerChangeProposal")?.state;
    assert.deepEqual(section<Record<string, unknown>>(r, "gatesAfter"), { liveGateAuthorized: false, providerChangeProposal: recorded });
    assert.equal(recorded, "satisfied");
    // The evidence carries no prompt, canary, account data or credential; the claim blocks a second run.
    const text = await readFile(r.evidencePath, "utf8");
    for (const secret of ["synthetic-not-a-secret-5c1e", "synthetic protected canary", PROPOSAL_PREFIX, "private@example.com", "private-org"])
      assert.ok(!text.includes(secret), `evidence leaks ${secret}`);
    assert.ok(existsSync(join(root, "claude.claim.json")));
    const second = await probe("claude", { env: cleanEnv(), evidenceRoot: root, binding: claudeBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, {}), compose: rehearsalCompose(root, runs) });
    assert.deepEqual([("refused" in second) && second.reason, runs.count], ["alreadyAttempted", 1], "no second turn, no second verification");
  })));

test("O5.5B9 Muse probe path: Exec with --workspace = its view, effort minimal, one turn, attestation outside every workspace; verified",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const r = report(await probe("muse", { env: cleanEnv(), evidenceRoot: root, binding: museBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: PROPOSAL, FUSION_FAKE_EXPECT_EFFORT: "minimal",
        FUSION_FAKE_PROMPT_INCLUDES: BASELINE_HASH }), compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "PASS", `${r.detail} ${JSON.stringify(r.evidence.workflow)}`);
    const counts = section<Record<string, number>>(r, "launchCounts");
    assert.deepEqual([counts.providerTurn, section<number>(r, "proposalCalls"), runs.count], [1, 1, 1]);
    const launches = launchesOf(r);
    const turn = launches.find(l => l.purpose === "providerTurn")!;
    assert.equal(turn.cwdClass, "providerView");
    assert.deepEqual(turn.posture, { missing: [], widening: [] });
    assert.deepEqual([value(turn.args, "--reasoning-effort"), value(turn.args, "--model"), value(turn.args, "--provider"), value(turn.args, "--max-model-steps")],
      ["minimal", "muse-spark-1.3", "meta", "4"]);
    const hosts = launches.filter(l => l.purpose === "providerHost");
    assert.ok(hosts.length >= 1 && hosts.every(l => l.cwdClass === "ownedTemporary"), "the attestation host runs in an empty Fusion-owned directory");
    assert.deepEqual(section<{ lane: string; evidence: string[] }>(r, "attestedAuth"), { state: "authenticated", lane: "subscription",
      evidence: ["msp:account/read:accountLogin"] });
    assert.deepEqual(section<Array<{ observedModel: string }>>(r, "identity").map(entry => entry.observedModel), ["muse-spark-1.3"]);
    assert.deepEqual(section<{ unchanged: boolean }>(r, "primary").unchanged, true);
    // View root, candidate root, the attestation directory and the Exec attempt directory: all attributed, all gone.
    const cleanup = section<{ attributedTemporaries: number; leftoverOwnedTemporaries: string[] }>(r, "cleanup");
    assert.deepEqual([cleanup.attributedTemporaries >= 4, cleanup.leftoverOwnedTemporaries], [true, []], JSON.stringify(cleanup));
  })));

// ---------------------------------------------------------------- failures: classified, never retried

test("O5.5B9 Muse: a malformed proposal is MALFORMED_PROPOSAL after exactly one Exec turn — the adapter's retry is disabled for the probe",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const fakeEnv = { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: "{bad", FUSION_FAKE_EXPECT_EFFORT: "minimal" };
    const r = report(await probe("muse", { env: cleanEnv(), evidenceRoot: join(root, "probe"), binding: museBinding(i),
      offlineRehearsal: true, registry: testRegistry(i, fakeEnv), compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "MALFORMED_PROPOSAL", r.detail);
    assert.deepEqual([section<Record<string, number>>(r, "launchCounts").providerTurn, runs.count], [1, 0]);
    assert.equal(section<{ applied: unknown }>(r, "candidate").applied, null, "nothing was applied");
    // Without the probe's option the production default retries once: the probe would observe it and fail closed.
    const retrying = report(await probe("muse", { env: cleanEnv(), evidenceRoot: join(root, "default"),
      binding: { ...museBinding(i), options: Object.fromEntries(Object.entries(museBinding(i).options).filter(([key]) => key !== "malformedOutputRetries")) },
      offlineRehearsal: true, registry: testRegistry(i, fakeEnv), compose: rehearsalCompose(root, runs) }));
    // O5.5B11: the second Exec turn is refused BEFORE it starts; one model turn ran.
    assert.equal(section<Record<string, number>>(retrying, "launchCounts").providerTurn, 1);
    assert.deepEqual(section<{ refusals: unknown[] }>(retrying, "launchGuard").refusals,
      [{ purpose: "providerTurn", outcome: "PROVIDER_FAILED", reason: "a second provider model turn" }]);
    assert.deepEqual([retrying.outcome, retrying.detail],
      ["PROVIDER_FAILED", "a provider process was refused before it started: a second provider model turn"]);
  })));

test("O5.5B9 Claude: a wrong effective model fails the turn (no application, no verification, no retry)", { skip },
  async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const r = report(await probe("claude", { env: cleanEnv(), evidenceRoot: root, binding: claudeBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_SCENARIO: "model-mismatch", FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: PROPOSAL }),
      compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "MODEL_BLOCKED", "O5.5B11: a wrong effective model is its own outcome");
    assert.match(r.detail, /identity/u);
    assert.deepEqual([section<Record<string, number>>(r, "launchCounts").providerTurn, runs.count], [1, 0]);
    assert.equal(section<{ applied: unknown }>(r, "candidate").applied, null);
  })));

test("O5.5B9: a view handed out as the primary is refused before any provider process starts", { skip },
  async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const hostile = rehearsalCompose(root, runs, (composition, options) => ({ ...composition, views: { viewRoot: composition.views.viewRoot,
      open: async () => ({ viewId: "hostile-view", kind: "baseline", path: options.root }), fingerprint: async () => "same",
      release: async () => ({ complete: true }) } as unknown as WriterComposition["views"] }));
    const r = report(await probe("claude", { env: cleanEnv(), evidenceRoot: root, binding: claudeBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: PROPOSAL }), compose: hostile }));
    assert.deepEqual([r.outcome, r.modelTurnLaunched, launchesOf(r).length, runs.count], ["POSTURE_BLOCKED", false, 0, 0]);
    assert.equal(section<{ unchanged: boolean }>(r, "primary").unchanged, true);
  })));

// ---------------------------------------------------------------- units

test("O5.5B9 single-proposal latch: a second change-proposal call is refused before it reaches the provider", async () => {
  let reached = 0;
  const adapter = { runChangeProposalTurn: async () => { reached++; return { status: "completed" }; }, close: async function (this: unknown) { return this; } };
  const latched = singleProposalAdapter(adapter as unknown as ProviderAdapter);
  const session = {} as Session;
  await latched.adapter.runChangeProposalTurn!(session, { kind: "changeProposal", packet: PROBE_PACKET });
  await assert.rejects(async () => latched.adapter.runChangeProposalTurn!(session, { kind: "changeProposal", packet: PROBE_PACKET }),
    (error: unknown) => error instanceof FusionFailure && error.error.kind === "SecurityViolation");
  assert.deepEqual([reached, latched.calls()], [1, 2]);
  assert.equal(await latched.adapter.close(session), adapter, "other members stay bound to the adapter");
});

test("O5.5B9 baseline preconditions: the candidate port observes them read-only, the prompt carries them, nothing after application", { skip },
  async () => withRoot(async root => {
    const git = await ProcessGitClient.fromPath(process.env, true);
    const primary = await createProbeFixture(root, "claude", git);
    const port = new PrivateCandidateWorkspacePort({ primaryRoot: primary, git, confinement: OFFLINE_REHEARSAL,
      service: new VerificationService([]), declaredPlatform: "platform-neutral" });
    const handle = await port.acquire("b9-baseline.worker");
    try {
      assert.deepEqual(await port.baselineHashes(handle, [PROBE_TARGET, "src/new.js"]),
        [{ path: PROBE_TARGET, sha256: BASELINE_HASH }, { path: "src/new.js", sha256: null }]);
      await assert.rejects(() => port.baselineHashes(handle, ["../outside.js"]), (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
      await assert.rejects(() => port.baselineHashes(handle, []), (e: unknown) => e instanceof FusionFailure && e.error.kind === "InvalidInput");
      const applied = await port.apply(handle, changeSet([[PROBE_TARGET, PROBE_BUGGY, FIXED]]), { allowedPaths: [PROBE_TARGET], forbiddenPaths: [] });
      assert.ok("applied" in applied);
      await assert.rejects(() => port.baselineHashes(handle, [PROBE_TARGET]), (e: unknown) => e instanceof FusionFailure && e.error.kind === "WorkspaceConflict");
    } finally { assert.deepEqual(await port.release(handle), { complete: true }); }
    const prompt = structuredTurnPrompt({ kind: "changeProposal", packet: PROBE_PACKET, baseline: [{ path: PROBE_TARGET, sha256: BASELINE_HASH }] });
    assert.ok(prompt.includes(`Baseline (Fusion data): [{"path":"${PROBE_TARGET}","sha256":"${BASELINE_HASH}"}]`));
    assert.match(prompt, /Do not compute or guess hashes/u);
    assert.doesNotMatch(structuredTurnPrompt({ kind: "changeProposal", packet: PROBE_PACKET }), /Baseline \(Fusion data\)/u);
  }));

test("O5.5B9 registry: malformedOutputRetries is a validated Muse option (0 or 1) and reaches the Change Author", async () => {
  const muse = defaultRegistry().factories.get("muse-exec")!;
  const context = { workspace: resolve(tmpdir(), "b9-primary"), env: cleanEnv(), sessionWorkspaces: "required" as const };
  const built = await muse.createChangeAuthor!({ ...PROFILES.muse.binding }, context);
  assert.equal((built.adapter as MuseAdapter).config.malformedOutputRetries, 0);
  await assert.rejects(() => muse.createChangeAuthor!({ ...PROFILES.muse.binding, options: { ...PROFILES.muse.binding.options, malformedOutputRetries: 2 } }, context),
    (e: unknown) => e instanceof FusionFailure && e.error.kind === "InvalidInput");
});

test("O5.5B9 classification: Fusion's observations decide; a provider claim never does", () => {
  const base: ProbeFacts = { result: undefined, crash: undefined, turns: 1, proposalCalls: 1, viewsUnchanged: true, viewChecks: true,
    launchesInViews: true, forbiddenEnv: false, turnPosture: true, primaryUnchanged: true, cleanupComplete: true, acceptance: "granted", rehearsal: false };
  const run = (state: WorkflowResult["state"], reason: string, error?: WorkflowResult["error"], extra: Partial<WorkflowResult> = {}): WorkflowResult =>
    ({ state, transitions: [{ from: "delegating", to: state, reason }] as unknown as WorkflowResult["transitions"], delegateAttempts: 1, reviews: [],
      ...(error ? { error } : {}), ...extra }) as WorkflowResult;
  const error = (kind: string, safeMessage = "m") => ({ kind, safeMessage, retryable: false }) as WorkflowResult["error"];
  const completed = run("completed", "succeeded", undefined, { verification: { passed: true, commandsRun: 1 }, cleanup: { candidates: 1, released: 1, complete: true },
    providerViews: { created: 1, released: 1, complete: true } });
  const cases: Array<[Partial<ProbeFacts>, string]> = [
    [{ result: completed }, "PASS"],
    [{ result: completed, acceptance: "offlineRehearsal" }, "VERIFICATION_FAILED"],
    [{ result: completed, cleanupComplete: false }, "CLEANUP_FAILED"],
    [{ result: completed, turns: 2 }, "PROVIDER_FAILED"],
    [{ result: completed, primaryUnchanged: false }, "PRIMARY_MUTATED"],
    [{ result: completed, viewsUnchanged: false }, "VIEW_MUTATED"],
    [{ result: completed, launchesInViews: false }, "POSTURE_BLOCKED"],
    [{ result: completed, forbiddenEnv: true }, "AUTH_BLOCKED"],
    [{ result: run("failed", "proposalMalformed", error("MalformedOutput")) }, "MALFORMED_PROPOSAL"],
    [{ result: run("failed", "proposalRejected", error("SecurityViolation")) }, "INVALID_CHANGESET"],
    [{ result: run("decisionRequired", "applicationRejected", error("WorkspaceConflict")) }, "INVALID_CHANGESET"],
    [{ result: run("failed", "verificationFailed", error("VerificationFailure")) }, "VERIFICATION_FAILED"],
    [{ result: run("failed", "confinementNotAccepted", error("CapabilityUnavailable")) }, "VERIFICATION_FAILED"],
    [{ result: run("failed", "timedOut", error("Timeout")) }, "TIMEOUT"],
    [{ result: run("failed", "policyFailure", error("AuthMismatch")) }, "AUTH_BLOCKED"],
    [{ result: run("failed", "policyFailure", error("CapabilityUnavailable", "unvalidated for this runtime version")) }, "VERSION_BLOCKED"],
    [{ result: run("failed", "providerFailure", error("ProviderIdentityMismatch")) }, "MODEL_BLOCKED"],
    [{ result: completed, launchRefusals: [{ outcome: "POSTURE_BLOCKED", reason: "r" }] }, "POSTURE_BLOCKED"],
    [{ result: completed, launchRefusals: [{ outcome: "AUTH_BLOCKED", reason: "r" }] }, "AUTH_BLOCKED"],
    [{ result: completed, primaryUnchanged: false, launchRefusals: [{ outcome: "POSTURE_BLOCKED", reason: "r" }] }, "PRIMARY_MUTATED"],
    [{ result: run("failed", "securityViolation", error("SecurityViolation"), { risk: { level: "critical", signals: [{ code: "providerWorkspaceChanged" }] } as never }) }, "VIEW_MUTATED"],
    [{ result: run("failed", "cleanupIncomplete", error("WorkspaceConflict")) }, "CLEANUP_FAILED"],
    [{ crash: error("InternalError") }, "PROVIDER_FAILED"],
  ];
  for (const [facts, expected] of cases) assert.equal(classifyProbe({ ...base, ...facts })[0], expected, JSON.stringify(facts));
  assert.equal(classifyProbe({ ...base, result: completed, acceptance: "offlineRehearsal", rehearsal: true })[0], "PASS");
});

// ---------------------------------------------------------------- Stage 2: after the authorized live probes

test("O5.5B9 Stage 2 (O5.5B10 envelope): a fenced proposal with text after the fence is MALFORMED_PROPOSAL — one turn, nothing applied, the failed turn's init readback and reply shape kept",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const fenced = ["```json", PROPOSAL, "```", "Hope this helps!"].join("\n");
    const r = report(await probe("claude", { env: cleanEnv(), evidenceRoot: root, binding: claudeBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: fenced }), compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "MALFORMED_PROPOSAL");
    assert.equal(r.detail, "Claude structured output was refused: EXTRA_TEXT under the rawOrSingleJsonFence envelope.",
      "a valid ChangeSet followed by prose is refused; the message names only the reply's structure");
    assert.deepEqual([section<Record<string, number>>(r, "launchCounts").providerTurn, section<number>(r, "proposalCalls"), runs.count], [1, 1, 0]);
    assert.equal(section<{ applied: unknown }>(r, "candidate").applied, null);
    assert.deepEqual(section<{ events: unknown[] }>(r, "proposal").events, [], "the engine never saw a proposal");
    const shape = section<Record<string, unknown>>(r, "structuredOutput");
    assert.deepEqual([shape.classification, shape.accepted, shape.extraTextLocation, shape.exactlyOneFencePair, shape.bodyParsesAsJson,
      shape.bodyMatchesExpectedSchema], ["EXTRA_TEXT", false, "afterFence", true, true, true], "the evidence explains why without keeping the reply");
    const init = section<{ source: string; runtimeVersion: string; effectiveModel: string; apiKeySource: string; permissionMode: string;
      tools: string[]; mcpServers: number; auth: { lane: string } }>(r, "runtimeReadback");
    assert.deepEqual([init.source, init.runtimeVersion, init.effectiveModel, init.apiKeySource, init.permissionMode, init.tools, init.mcpServers,
      init.auth.lane], ["initOfFailedTurn", "2.1.280", "claude-canonical-fixture", "none", "dontAsk", ["Glob", "Grep", "Read"], 0, "subscription"]);
    assert.deepEqual(section<{ unchanged: boolean }>(r, "primary").unchanged, true);
    const text = await readFile(r.evidencePath, "utf8");
    assert.ok(!text.includes("trim()") && !text.includes("```") && !text.includes("Hope this helps"), "no part of the refused output is persisted");
  })));

test("O5.5B9 Stage 2 (O5.5B10 envelope): the reply diagnostic is structural and content-free; under raw-only nothing fenced is accepted", () => {
  const body = JSON.stringify({ schemaVersion: 1, operations: [{ kind: "writeText", path: "src/secret-name.js", expectedSha256: null,
    content: "CANARY-BODY-7f3e" }] });
  const cases: Array<[string, string]> = [
    [["```json", body, "```"].join("\n"), "SINGLE_FENCED_VALID_JSON"],
    [["```", body, "```"].join("\n"), "SINGLE_FENCED_VALID_JSON"],
    [["```json", body, "```", "Hope this helps!"].join("\n"), "EXTRA_TEXT"],
    [["```json", body, "```", "```json", body, "```"].join("\n"), "MULTIPLE_FENCES"],
    [["```json", "{\"schemaVersion\": 1,", "```"].join("\n"), "SINGLE_FENCED_INVALID_JSON"],
    [["```json", body].join("\n"), "UNCLOSED_FENCE"],
    [["```CANARY-TAG-2b1d", "[1, 2]", "```"].join("\n"), "UNSUPPORTED_FENCE"],
    [`Here is the ChangeSet:\n\`\`\`json\n${body}\n\`\`\``, "EXTRA_TEXT"],
    [`${body}\nDone.`, "EXTRA_TEXT"],
    ["   ", "EMPTY"],
  ];
  for (const [text, classification] of cases) {
    const reading = readStructuredEnvelope(text, { policy: "rawOnly" });
    assert.deepEqual([reading.accepted, reading.diagnostic.classification], [false, classification], text);
    assert.ok(!/CANARY|secret-name|Hope/u.test(JSON.stringify(reading.diagnostic)), "never content, paths or the fence tag");
  }
});

test("O5.5B9 Stage 2 readiness (with O5.5B11): live evidence is recorded history per family, bound to version, model and effort, and opens nothing", { skip },
  async () => withInstalls(async i => {
    // The O5.5B9 records are history and are never rewritten; O5.5B11 appended Claude's passing probe.
    assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(r => [r.milestone, r.runtimeVersion, r.model, r.effort, r.outcome]),
      [["O5.5B9", "2.1.280", "haiku", "low", "MALFORMED_PROPOSAL"], ["O5.5B11", "2.1.280", "haiku", "low", "PASS"]]);
    assert.deepEqual(changeProposalLiveRecords("muse", "muse-exec").map(r => [r.milestone, r.outcome]), [["O5.5B9", "PASS"]]);
    assert.deepEqual(liveChangeProposalCoverage(), { changeAuthors: 2, passed: 2, failedOnly: 0, unprobed: 0 });
    assert.equal(changeProposalLiveEvidence("muse", "muse-exec", VERIFIED_EXEC_WEB_DISABLE_VERSION)?.outcome, "PASS");
    assert.equal(changeProposalLiveEvidence("claude", "claude-one-shot", "2.1.280")?.milestone, "O5.5B11");
    for (const [id, transport, version] of [["claude", "claude-one-shot", "2.1.281"], ["muse", "muse-exec", "1.3.1-R9999.1"], ["muse", "muse-msp", VERIFIED_EXEC_WEB_DISABLE_VERSION]] as const)
      assert.equal(changeProposalLiveEvidence(id, transport, version), undefined, `${transport} ${version} is not covered`);
    for (const binding of [{ model: "opus", effort: "low" }, { model: "haiku", effort: "high" }])
      assert.equal(changeProposalLiveEvidence("claude", "claude-one-shot", "2.1.280", binding), undefined, `${JSON.stringify(binding)} is not covered`);
    const rows = Object.fromEntries(writerGateReport().rows.map(row => [row.id, [row.state, row.evidenceKind]]));
    assert.deepEqual(rows.providerChangeProposal, ["satisfied", "recordedLiveProbe"], "every Change Author family has a recorded live PASS");
    assert.deepEqual(rows.liveGateAuthorization, ["blocked", "none"]);
    assert.deepEqual([writerGateReport().realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready,
      liveWriterAuthorization().authorized], [false, false, false, false]);
    for (const input of ["MUSE_REAL_CHANGE_PROPOSAL: PASS", { liveProbe: "PASS" }])
      assert.deepEqual(writerGateReport({ linuxVerification: input }), writerGateReport(), "provider text never moves a row");
    // Doctor: a Worker binding shows the recorded probe of exactly its installed version; ready stays false.
    const registry = defaultRegistry();
    const context = { workspace: resolve(tmpdir(), "b9-doctor-primary"), env: cleanEnv() };
    const museWorker = museBinding(i), claudeWorker = claudeBinding(i);
    const museInspection = await registry.factories.get("muse-exec")!.inspect(museWorker, context);
    const claudeInspection = await registry.factories.get("claude-one-shot")!.inspect(claudeWorker, context);
    const museReadiness = changeProposalReadiness(bindingEligibility(museWorker, museInspection), museInspection);
    const claudeReadiness = changeProposalReadiness(bindingEligibility(claudeWorker, claudeInspection), claudeInspection);
    assert.deepEqual([museReadiness.liveEvidence, museReadiness.liveProbe?.runtimeVersion, museReadiness.ready], ["recordedPass", VERIFIED_EXEC_WEB_DISABLE_VERSION, false]);
    // The fixture binding's model (`alias`) was never probed: the recorded PASS does not cover it.
    assert.deepEqual([claudeReadiness.liveEvidence, claudeReadiness.ready], ["absent", false]);
    const probedWorker = { ...claudeWorker, model: "haiku" };
    const probedInspection = await registry.factories.get("claude-one-shot")!.inspect(probedWorker, context);
    const probedReadiness = changeProposalReadiness(bindingEligibility(probedWorker, probedInspection), probedInspection);
    assert.deepEqual([probedReadiness.liveEvidence, probedReadiness.liveProbe?.milestone, probedReadiness.liveProbe?.outcome, probedReadiness.ready],
      ["recordedPass", "O5.5B11", "PASS", false], "the probed model and effort show the PASS; ready stays false");
    await writeFile(join(i.dir, "claude-code", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.281" }));
    const newer = await registry.factories.get("claude-one-shot")!.inspect(probedWorker, context);
    assert.equal(changeProposalReadiness(bindingEligibility(claudeWorker, newer), newer).liveEvidence, "absent", "another version is not covered");
  }));
