import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import type { Diagnostics } from "../src/app/diagnostics.js";
import { writerGateReport } from "../src/app/writer-gate.js";
import { renderDoctor } from "../src/cli/render.js";

/**
 * v0.3 — the LIVE ACCEPTANCE RUNNER's preconditions (scripts/v03-live-preconditions.mjs), decided from the STRUCTURED report
 * of `fusion --json doctor --probe`.
 *
 * Regression: a real run from a normal PowerShell window printed
 *   Lead: probe: auth authenticated (subscription OAuth token)
 *   Lead: runtime posture 2.1.283: attested — canary check passed on this runtime (11 checks: …)
 * and then STOPPED with "the Lead binding's subscription login is not confirmed". The runner scraped doctor's TEXT and
 * accepted only the wording "(subscription login)", the label of the `subscription` lane; a subscription OAuth token
 * (`CLAUDE_CODE_OAUTH_TOKEN`) is the `subscriptionToken` lane, which Fusion's own read-only policy accepts
 * (src/app/readiness.ts SUBSCRIPTION_LANES). The fix reads the structured report and mirrors exactly those lanes, and adds
 * the posture conditions: the Lead's runtime attested by the probe, the Reviewer the validated launch-time binding.
 */
type Verdict = { confirmed: boolean; lines: string[]; reasons: string[] };
type Module = { parseDoctorReport(stdout: string): unknown; evaluatePreconditions(report: unknown): Verdict;
  LEAD_LANES: readonly string[]; REVIEWER_LANES: readonly string[] };
const REPO = process.cwd();
const RUNNER = resolve(REPO, "scripts", "v03-live-acceptance.mjs");
const load = async (): Promise<Module> => await import(pathToFileURL(join(REPO, "scripts", "v03-live-preconditions.mjs")).href) as Module;

const CANARY = "canary check passed on this runtime (11 checks: settings, hooks, MCP, agents, skills, commands, tools, plugins)";
type Probe = Record<string, unknown> | undefined;
interface Binding { role: string; adapter: string; probe?: Probe; postureEvidence?: string; readOnly?: string; version?: string }
const provider = (b: Binding, index: number) => ({ index, role: b.role, adapter: b.adapter, requestedModel: "m", effort: "low",
  inspection: { executable: "available", runtimeVersion: b.version ?? "x", billing: { state: "clear", reasons: [] }, controls: [], structuredTurns: true },
  identity: { requested: `p/${b.role}`, observed: "unobserved" }, capabilities: {}, postureEvidence: b.postureEvidence ?? "none",
  eligibility: { readOnly: { state: b.readOnly ?? "unknown", reasons: [] }, review: { state: "unknown", reasons: [] },
    changeProposal: { state: "unknown", reasons: [] }, writer: { state: "blocked", reasons: [] } }, ...(b.probe ? { probe: b.probe } : {}) });
/** The structured shape of the maintainer's observed Lead: an OAuth-token subscription login, the runtime attested now. */
const OBSERVED_LEAD: Binding = { role: "Lead", adapter: "claude-one-shot", version: "2.1.283",
  probe: { auth: { state: "authenticated", lane: "subscriptionToken", detail: "claude auth status" },
    posture: { state: "attested", version: "2.1.283", detail: CANARY } } };
const VALIDATED_REVIEWER: Binding = { role: "Reviewer", adapter: "muse-exec", version: "1.4.0-R4302.1", postureEvidence: "launchTime", readOnly: "eligible",
  probe: { auth: { state: "authenticated", lane: "subscription", detail: "account/read" } } };
const WORKER: Binding = { role: "Worker", adapter: "claude-one-shot", version: "2.1.283" };
const EXPLORER: Binding = { role: "Explorer", adapter: "muse-exec", version: "1.4.0-R4302.1",
  probe: { auth: { state: "authenticated", lane: "subscription", detail: "account/read" } } };
const report = (...bindings: Binding[]) => ({ command: "doctor", exitCode: 15, readiness: { classes: ["DEGRADED"] }, runtime: { platform: "win32", nodeVersion: "v22", git: "available" },
  repository: { detected: false }, config: { state: "valid", bindings: bindings.length, verificationCommands: 0 }, storage: { state: "unknown" },
  leases: { state: "unknown" }, workspaceLease: { state: "available", reasons: [] },
  verification: { state: "notConfigured", commands: 0, notes: [], confinedCommands: 0, platformRequirement: "unknown" },
  providers: bindings.map(provider), roles: {}, verificationPlatform: { assessment: { declared: "missing", effective: "unknown", signals: [] }, autonomousBackends: [] },
  // The Writer gate table exactly as `doctor --probe` builds it (a probed run always establishes the Windows runtime state),
  // so the fixture keeps the current WriterGateReport contract (verificationIsolation.windows included) by construction.
  writer: { code: "REAL_WRITER_MODE_NOT_READY", prerequisites: [] },
  writerGates: writerGateReport({ hostPlatform: "win32", windowsRuntime: "unavailable" }), probed: true });
const DEFAULTS = () => report(OBSERVED_LEAD, WORKER, EXPLORER, VALIDATED_REVIEWER);
const verdict = async (value: unknown) => { const m = await load(); return m.evaluatePreconditions(m.parseDoctorReport(typeof value === "string" ? value : JSON.stringify(value))); };
const lead = (probe: Probe) => ({ ...OBSERVED_LEAD, probe });

test("regression: the maintainer's real Lead (subscription OAuth token, runtime attested) is CONFIRMED; the old text rule refused it", async () => {
  // The structured fixture prints, through Fusion's own doctor renderer, exactly the lines the maintainer saw.
  const text = renderDoctor(DEFAULTS() as unknown as Diagnostics);
  assert.ok(text.includes("\n  probe: auth authenticated (subscription OAuth token)\n"), text);
  assert.ok(text.includes(`\n  runtime posture 2.1.283: attested — ${CANARY}\n`), text);
  assert.ok(text.includes("\nWindows verification readiness: blocked\n"), "the required Windows isolation status is rendered");
  // The defect, reproduced: the old runner accepted only the wording of the OTHER subscription lane.
  const observed = "  Lead: probe: auth authenticated (subscription OAuth token)\n  Lead: runtime posture 2.1.283: attested — " + CANARY;
  assert.equal(/probe: auth authenticated \(subscription login\)/u.test(observed), false, "the old check refused this real output");
  const v = await verdict(DEFAULTS());
  assert.deepEqual(v.reasons, []);
  assert.equal(v.confirmed, true);
  assert.deepEqual(v.lines, ["Lead (claude-one-shot): auth authenticated (subscription OAuth token); runtime posture 2.1.283: attested",
    "Reviewer (muse-exec): auth authenticated (subscription login); posture evidence launchTime; read-only eligible"]);
});

test("the Lead's subscription lanes are exactly Fusion's own; the runtime must be attested (or the recorded release) by the probe", async () => {
  const m = await load();
  assert.deepEqual([...m.LEAD_LANES], ["subscription", "subscriptionToken"]);
  assert.deepEqual([...m.REVIEWER_LANES], ["subscription"]);
  const ok = (probe: Probe) => verdict(report(lead(probe), WORKER, EXPLORER, VALIDATED_REVIEWER));
  const auth = (state: string, lane: string) => ({ state, lane, detail: "d" });
  const attested = { state: "attested", version: "2.1.283", detail: CANARY };
  assert.equal((await ok({ auth: auth("authenticated", "subscription"), posture: attested })).confirmed, true, "an interactive subscription login");
  assert.equal((await ok({ auth: auth("authenticated", "subscriptionToken"), posture: { state: "recorded", version: "2.1.280", detail: "the validated release" } })).confirmed, true,
    "the recorded validated release (its canary passed too)");
  const refused = async (probe: Probe, reason: RegExp) => {
    const v = await ok(probe);
    assert.equal(v.confirmed, false, JSON.stringify(probe));
    assert.ok(v.reasons.some(r => reason.test(r)), `${JSON.stringify(v.reasons)} ~ ${reason}`);
  };
  await refused({ auth: auth("authenticated", "api"), posture: attested }, /api lane, not a subscription lane/u);
  await refused({ auth: auth("authenticated", "thirdParty"), posture: attested }, /not a subscription lane/u);
  await refused({ auth: auth("authenticated", "unknown"), posture: attested }, /not a subscription lane/u);
  await refused({ auth: auth("unauthenticated", "subscription"), posture: attested }, /login is unauthenticated/u);
  await refused({ auth: auth("ambiguous", "subscriptionToken"), posture: attested }, /login is ambiguous/u);
  await refused({ auth: auth("failed", "unknown") }, /login is failed/u);
  await refused({ error: "probe failed" }, /Lead probe failed: probe failed/u);
  await refused(undefined, /Lead binding was not probed/u);
  await refused({ auth: auth("authenticated", "subscriptionToken") }, /runtime posture was not attested/u);
  await refused({ auth: auth("authenticated", "subscriptionToken"), posture: { state: "refused", version: "2.2.0", detail: "outside the release line" } },
    /runtime posture is refused, not attested/u);
});

test("roles never stand in for each other: Muse's login cannot confirm the Lead, the Lead's cannot confirm Muse", async () => {
  // Every Muse binding authenticated, the Lead's probe failed (the real state inside an AI coding tool): refused for the Lead.
  const noLead = await verdict(report(lead({ auth: { state: "failed", lane: "unknown", detail: "d" } }), WORKER, EXPLORER, VALIDATED_REVIEWER));
  assert.equal(noLead.confirmed, false);
  assert.deepEqual(noLead.reasons, ["the Lead's login is failed, not authenticated", "the Lead's runtime posture was not attested by the probe"]);
  // The Lead authenticated and attested, the Reviewer's probe failed: refused for the Reviewer.
  const noReviewer = await verdict(report(OBSERVED_LEAD, WORKER, EXPLORER, { ...VALIDATED_REVIEWER, probe: { auth: { state: "failed", lane: "unknown", detail: "d" } } }));
  assert.deepEqual(noReviewer.reasons, ["the Reviewer's login is failed, not authenticated"]);
  // An OAuth token is a Claude lane, not Muse's.
  const tokenReviewer = await verdict(report(OBSERVED_LEAD, WORKER, EXPLORER, { ...VALIDATED_REVIEWER, probe: { auth: { state: "authenticated", lane: "subscriptionToken", detail: "d" } } }));
  assert.deepEqual(tokenReviewer.reasons, ["the Reviewer authenticated on the subscription OAuth token lane, not its subscription login"]);
  // The Explorer's login never stands in for the Reviewer, and the Worker never for the Lead.
  const reviewerless = await verdict(report(OBSERVED_LEAD, WORKER, EXPLORER));
  assert.deepEqual(reviewerless.reasons, ["no Reviewer binding is configured"]);
  const leadless = await verdict(report({ ...OBSERVED_LEAD, role: "Worker" }, EXPLORER, VALIDATED_REVIEWER));
  assert.deepEqual(leadless.reasons, ["no Lead binding is configured"]);
});

test("Muse: an authenticated login is not enough — its runtime must be the validated binding (the installed release updated itself)", async () => {
  // The state after a Muse self-update to a release not validated for this binding (as 1.4.0-R4302.1 was, until V0.3-R4302
  // validated it; the real report of that validated binding is test/v03-muse-r4302-reviewer-validation.test.ts):
  // authenticated, posture unproven.
  const updated = await verdict(report(OBSERVED_LEAD, WORKER, EXPLORER, { ...VALIDATED_REVIEWER, version: "1.4.0-R4303.1", postureEvidence: "none", readOnly: "unknown" }));
  assert.equal(updated.confirmed, false);
  assert.deepEqual(updated.reasons, ["the Reviewer's read-only posture is not proven at launch time: Muse 1.4.0-R4303.1 is not a validated release for this " +
    "binding (Fusion will not let it investigate or review)"]);
  const launchOnly = await verdict(report(OBSERVED_LEAD, WORKER, EXPLORER, { ...VALIDATED_REVIEWER, readOnly: "unknown" }));
  assert.equal(launchOnly.confirmed, false, "launch-time evidence without read-only eligibility is not enough");
});

test("the report's formatting does not matter; only a structured report counts; the configuration must be the default one", async () => {
  const value = DEFAULTS();
  for (const text of [JSON.stringify(value), JSON.stringify(value, null, 2), `${JSON.stringify(value, null, 4).replace(/\n/gu, "\r\n")}\r\n`, `\n\n  ${JSON.stringify(value)}  \n`])
    assert.equal((await verdict(text)).confirmed, true);
  // Doctor's human-readable text (with the confirming words in it) is not a report and is refused.
  const readable = "binding 0: Lead via claude-one-shot (claude/opus)\n  probe: auth authenticated (subscription OAuth token)\n  runtime posture 2.1.283: attested — x\n" +
    "binding 3: Reviewer via muse-exec (meta/muse-spark-1.3)\n  probe: auth authenticated (subscription login)\n";
  for (const text of [readable, "", "null", "[]", "{}", JSON.stringify({ providers: "none" })])
    assert.deepEqual((await verdict(text)).reasons, ["fusion --json doctor --probe did not produce a readable report"], text.slice(0, 30));
  // Several bindings for one role, or the role on another adapter: not the configuration this acceptance is for.
  assert.deepEqual((await verdict(report(OBSERVED_LEAD, OBSERVED_LEAD, WORKER, EXPLORER, VALIDATED_REVIEWER))).reasons,
    ["2 Lead bindings are configured; the live acceptance needs exactly one"]);
  assert.deepEqual((await verdict(report({ ...OBSERVED_LEAD, adapter: "muse-exec" }, WORKER, EXPLORER, VALIDATED_REVIEWER))).reasons,
    ["the Lead binding uses muse-exec, not claude-one-shot (the default this acceptance is for)"]);
});

// ---------------------------------------------------------------- black box: the runner as a process

test("black box: the runner confirms the observed real report, refuses the others before any model turn, and never runs a session from a saved report",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "v03-live-pre-"));
    try {
      const run = async (name: string, value: unknown) => {
        const file = join(dir, `${name}.json`);
        await writeFile(file, JSON.stringify(value, null, 2));
        return spawnSync(process.execPath, [RUNNER, "--preconditions-from", file], { cwd: REPO, encoding: "utf8", windowsHide: true, timeout: 60_000 });
      };
      const observed = await run("observed", DEFAULTS());
      assert.equal(observed.status, 0, observed.stdout + observed.stderr);
      assert.match(observed.stdout, /^ {2}Lead \(claude-one-shot\): auth authenticated \(subscription OAuth token\); runtime posture 2\.1\.283: attested$/mu);
      assert.match(observed.stdout, /^ {2}PRECONDITIONS: CONFIRMED /mu);
      assert.match(observed.stdout, /^ {2}\(saved report: no session is run in this mode\)$/mu);
      assert.doesNotMatch(observed.stdout, /not confirmed|STOPPED|=== L1/u, "no false negative, and no session");
      const apiKey = await run("api-key", report(lead({ auth: { state: "authenticated", lane: "api", detail: "d" }, posture: { state: "attested", version: "2.1.283", detail: CANARY } }),
        WORKER, EXPLORER, VALIDATED_REVIEWER));
      assert.equal(apiKey.status, 2);
      assert.match(apiKey.stdout, /STOPPED: the required logins and postures are not confirmed: the Lead authenticated on the api lane, not a subscription lane .* No model turn was spent\./u);
      const updatedMuse = await run("muse-updated", report(OBSERVED_LEAD, WORKER, EXPLORER, { ...VALIDATED_REVIEWER, version: "1.4.0-R4303.1", postureEvidence: "none", readOnly: "unknown" }));
      assert.equal(updatedMuse.status, 2);
      assert.match(updatedMuse.stdout, /Muse 1\.4\.0-R4303\.1 is not a validated release for this binding/u);
      assert.doesNotMatch(apiKey.stdout + updatedMuse.stdout, /=== L1/u, "nothing started");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
