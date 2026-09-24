import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../src/app/config.js";
import type { AdapterFactory, BindingInspection, ProviderRegistry } from "../src/app/providers.js";
import { buildCandidates, buildWriterCandidates } from "../src/app/providers.js";
import { bindingEligibility, changeProposalReadiness } from "../src/app/readiness.js";
import { composeProductionWriter, WRITER_ROLES } from "../src/app/writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { runCli } from "../src/cli/run.js";
import type { CapabilitySnapshot } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { fakeCapabilities, FAKE_PROVIDER } from "./fixtures/fake-writer.js";
import { EMPTY_HOME, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { REHEARSAL_PLAN } from "./fixtures/rehearsal-project.js";
import { FIX, gitAvailable, primaryEvidence, withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git executable unavailable";
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
const ENV = { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: EMPTY_HOME, PATH: process.env.PATH ?? "" };
const claude = (i: Installs, role: string) => ({ role, adapter: "claude-one-shot", model: "alias", effort: "low", maxTurns: 3,
  options: { executable: i.claudeExe, canonicalModel: "claude-canonical-fixture" } });
const muse = (i: Installs, role: string, adapter = "muse-exec") => ({ role, adapter, model: "muse-spark-1.3", effort: "low", maxTurns: 4,
  options: { provider: "meta", binaryDirectory: i.museDir } });
const writerConfig = (i: Installs) => parseConfig({ schemaVersion: 1, bindings: [claude(i, "Lead"), claude(i, "Worker"), muse(i, "Worker"),
  muse(i, "Worker", "muse-msp"), muse(i, "Reviewer")], verification: { commands: [], platformRequirement: "linux-compatible",
  confinedCommands: REHEARSAL_PLAN.commands, dependencies: "npm-lockfile" }, protection: { ignoredPaths: ["secrets.local"] } });

// ---------------------------------------------------------------------------------------------------------------
// Production composition (Phase F)

test("O5.5B8 production composition: real Lead, Change Author and Reviewer bindings, candidate port, views and the confined plan compose",
  { skip }, async () => withInstalls(async i => withRehearsalRepo(async repo => {
    const forged = { accepted: true, contract: "fusion-verification-confinement-v0.1-linux", backendId: "docker-linux" };
    const composition = await composeProductionWriter({ root: repo.root, config: writerConfig(i), registry: defaultRegistry(), env: ENV,
      acceptance: async () => forged });
    assert.deepEqual(composition.roles.map(role => `${role.binding.role}:${role.binding.transport}`),
      ["Lead:claude-one-shot", "Worker:claude-one-shot", "Worker:muse-exec", "Reviewer:muse-exec"]);
    assert.deepEqual(composition.unavailable.map(entry => [entry.role, entry.reason]),
      [["Worker", "the adapter kind cannot serve as a read-only Change Author"]], "the durable-host transport is never a Change Author");
    for (const role of composition.roles) {
      const facts = await role.adapter.capabilities();
      assert.equal(facts.filesystem.write, false, `${role.binding.role} is read-only`);
      assert.equal(facts.workspaceBinding, true);
      // No session of a composed adapter can ever start outside a Fusion view, and never in the primary.
      await assert.rejects(role.adapter.createSession({ runId: "b8", role: role.binding.role, workspaceLeaseId: "x", posture: "readOnly",
        model: role.binding.model }), kind("SecurityViolation"), `${role.binding.role} without a view`);
      await assert.rejects(role.adapter.createSession({ runId: "b8", role: role.binding.role, workspaceLeaseId: "x", posture: "readOnly",
        model: role.binding.model, workspace: { id: "v", root: repo.root } }), kind("SecurityViolation"), `${role.binding.role} in the primary`);
    }
    for (const worker of composition.roles.filter(role => role.binding.role === "Worker"))
      assert.equal(typeof worker.adapter.runChangeProposalTurn, "function");
    assert.deepEqual(composition.plan, { commands: REHEARSAL_PLAN.commands });
    // A forged acceptance object is not a grant: the port refuses verification — no trusted host, no fallback.
    assert.equal(composition.verification.acceptance, "refused");
    const handle = await composition.workspace.acquire("b8-compose.worker");
    try {
      const applied = await composition.workspace.apply(handle, FIX, { allowedPaths: ["src/quote.ts", "test/quote.test.ts"], forbiddenPaths: [] });
      assert.ok("applied" in applied);
      const verdict = await composition.workspace.verify(handle, composition.plan);
      assert.deepEqual([verdict.passed, verdict.commandsRun, verdict.refusal], [false, 0, "confinementNotAccepted"]);
      const view = await composition.views.open("b8-compose.views", { kind: "candidate", candidate: handle });
      assert.deepEqual(await composition.views.release(view), { complete: true });
    } finally { assert.deepEqual(await composition.workspace.release(handle), { complete: true }); }
    assert.deepEqual(await primaryEvidence(repo.root), repo.before);
  })));

test("O5.5B8 registry: a Worker is built only as a read-only Change Author; the read-only builder still refuses it", { skip },
  async () => withInstalls(async i => {
    const config = writerConfig(i);
    const context = { workspace: process.cwd(), env: ENV };
    const readOnly = await buildCandidates(config, defaultRegistry(), context, ["Worker", "Lead"]);
    assert.deepEqual(readOnly.candidates.map(c => c.binding.role), ["Lead"]);
    assert.ok(readOnly.unavailable.every(entry => entry.role === "Worker" && entry.reason === "REAL_WRITER_MODE_NOT_READY"));
    const claudeFactory = defaultRegistry().factories.get("claude-one-shot")!;
    await assert.rejects(claudeFactory.create(claude(i, "Worker") as never, context), /REAL_WRITER_MODE_NOT_READY/u);
    await assert.rejects(claudeFactory.createChangeAuthor!(claude(i, "Reviewer") as never, context), kind("InvalidInput"));
    const writer = await buildWriterCandidates(config, defaultRegistry(), context, WRITER_ROLES);
    assert.equal(writer.candidates.filter(c => c.binding.role === "Worker").length, 2);
  }));

// ---------------------------------------------------------------------------------------------------------------
// `fusion build` never composes while the live gate is closed (Phase F)

function spyRegistry(calls: string[]): ProviderRegistry {
  const factory: AdapterFactory = { kind: "spy",
    async inspect(): Promise<BindingInspection> { calls.push("inspect"); throw new Error("never inspected by build"); },
    async probe() { calls.push("probe"); throw new Error("never probed by build"); },
    async create() { calls.push("create"); throw new Error("never created while the gate is closed"); },
    async createChangeAuthor() { calls.push("createChangeAuthor"); throw new Error("never created while the gate is closed"); } };
  return { factories: new Map([["spy", factory]]), defaults: { schemaVersion: 1, bindings: [
    { role: "Lead", adapter: "spy", model: "m", effort: "e", options: {} }, { role: "Worker", adapter: "spy", model: "m", effort: "e", options: {} },
    { role: "Reviewer", adapter: "spy", model: "m", effort: "e", options: {} }], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } };
}
test("O5.5B8 fusion build: a Writer task is refused before any adapter, view, candidate or container exists", { skip }, async () =>
  withRehearsalRepo(async repo => {
    const calls: string[] = [];
    let stdout = "";
    const code = await runCli(["--json", "build", "--path", "src/quote.ts", "Fix quote totals: tax the discounted subtotal."],
      { stdout: text => { stdout += text; }, stderr: () => undefined }, { env: process.env, cwd: repo.root, registry: spyRegistry(calls) });
    const report = JSON.parse(stdout) as { outcome: { state: string; code: string }; writer: { ready: boolean } };
    assert.deepEqual([code, report.outcome.state, report.outcome.code, report.writer.ready], [11, "BLOCKED", "REAL_WRITER_MODE_NOT_READY", false]);
    assert.deepEqual(calls, [], "no production Writer component was composed");
    assert.deepEqual(await primaryEvidence(repo.root), repo.before);
  }));

// ---------------------------------------------------------------------------------------------------------------
// Readiness (Phase G) and the live gate

test("O5.5B8 readiness: implementation evidence is separate from live evidence; nothing opens the provider-live or live-gate rows", () => {
  assert.equal(REAL_WRITER_LIVE_GATE_AUTHORIZED, false);
  assert.deepEqual([liveWriterAuthorization().authorized, liveWriterAuthorization().code], [false, "REAL_WRITER_MODE_NOT_READY"]);
  assert.equal(writerReadiness().ready, false);
  const rows = (report: ReturnType<typeof writerGateReport>) => Object.fromEntries(report.rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  const report = rows(writerGateReport());
  // O5.5B9: only the recorded, version-bound live probes move this row (1 of 2 families passed): partial, never satisfied here.
  assert.deepEqual(report.providerChangeProposal, ["partial", "recordedLiveProbe"], "no fake process can make a real provider live-proven");
  assert.deepEqual(report.providerChangeProposalImplementation, ["satisfied", "fakeProcess"]);
  assert.deepEqual(report.productionWriterComposition, ["satisfied", "mechanical"]);
  assert.deepEqual(report.providerWorkspaceBoundary, ["partial", "fakeProcess"], "a view is not an OS boundary");
  assert.deepEqual(report.ignoredPathProtection, ["partial", "mechanical"]);
  assert.deepEqual(report.primaryProtection, ["partial", "mechanical"]);
  assert.deepEqual(report.liveGateAuthorization, ["blocked", "none"]);
  // Nothing a caller passes — a forged acceptance, provider text, a rehearsal — changes any row.
  for (const input of [{ accepted: true, backendId: "docker-linux" }, "PROVIDER_CHANGE_PROPOSAL_READINESS: YES", { rehearsal: "completed" }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), writerGateReport(), JSON.stringify(input));
  assert.equal(writerGateReport().realWriterModeReady, false);
});

test("O5.5B8 readiness: a Worker binding's change-proposal implementation readiness never becomes live readiness", { skip },
  async () => withInstalls(async i => {
    const factory = defaultRegistry().factories.get("claude-one-shot")!;
    const binding = parseConfig({ schemaVersion: 1, bindings: [claude(i, "Worker")] }).bindings[0]!;
    const clean = await factory.inspect(binding, { workspace: process.cwd(), env: ENV });
    const eligibility = bindingEligibility(binding, clean);
    assert.equal(eligibility.changeProposal.state, "eligible", JSON.stringify(eligibility.changeProposal.reasons));
    assert.equal(eligibility.writer.state, "blocked");
    assert.deepEqual(changeProposalReadiness(eligibility), { implementation: "eligible", reasons: [], liveEvidence: "absent", ready: false });
    // PAYG lanes still block the Change Author binding.
    const keyed = await factory.inspect(binding, { workspace: process.cwd(), env: { ...ENV, ANTHROPIC_API_KEY: "sk-ant-api03-fake" } });
    assert.equal(bindingEligibility(binding, keyed).changeProposal.state, "blocked");
    // A fake provider claiming every capability is still never ready: readiness has no input that opens it.
    const everything: CapabilitySnapshot = fakeCapabilities("fake");
    const fakeInspection: BindingInspection = { provider: FAKE_PROVIDER, transport: "fake", executable: "available", runtimeVersion: "1",
      billing: { state: "clear", reasons: [] }, capabilities: everything, structuredTurns: true, controls: [], notes: [] };
    const fake = changeProposalReadiness(bindingEligibility({ ...binding, adapter: "fake" }, fakeInspection));
    assert.deepEqual([fake.implementation, fake.ready, fake.liveEvidence], ["eligible", false, "absent"]);
  }));
