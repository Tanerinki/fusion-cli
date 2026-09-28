import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { EVIDENCE_LIMITS, EvidenceGraph, parseEvidenceGraph, type EvidenceGraphRecord } from "../src/core/evidence/graph.js";
import { decide, evaluateObligations, obligationLabel, obligationWord, type BuildFacts, type ObligationRequirement } from "../src/core/evidence/obligations.js";
import { classifyTask, reliabilityPlan } from "../src/core/evidence/policy.js";
import { FusionFailure } from "../src/core/errors.js";
import { assessRisk, escalateRisk } from "../src/core/policy/risk.js";
import { inspectTask } from "../src/core/policy/task-inspector.js";

/**
 * v0.4 PR A — the pure reliability core as EXECUTABLE INVARIANTS: the evidence graph (models propose, Fusion's own
 * observations decide), proof obligations evaluated from host facts only, the decision and delivery permission, and the
 * reliability policy that chooses how much proof a task needs.
 */
const low = assessRisk([]);
const medium = assessRisk([{ code: "multiFile", level: "medium", source: "scope", evidence: "two files" }]);
const high = assessRisk([{ code: "securitySensitivePath", level: "high", source: "scope", evidence: "auth" }]);
const finding = (graph: EvidenceGraph, key = "claim") => graph.addClaim({ key, kind: "finding", origin: "user", ref: "session", subject: "finding 1",
  statement: "configuration.yaml has no trusted_proxies entry", files: ["configuration.yaml"] })!;
const pass = (id: string) => ({ id, passed: true }), fail = (id: string) => ({ id, passed: false });
const facts = (extra: Partial<BuildFacts> = {}): BuildFacts => ({ changedPaths: ["configuration.yaml"], allowedScope: ["configuration.yaml"],
  scopeViolation: false, protectedChanged: [], verification: { passed: true, complete: true, commands: [pass("configuration")] },
  reproduction: { ran: true, commands: [fail("configuration")] }, ...extra });

// ---------------------------------------------------------------- the evidence graph

test("v0.4 invariant 1: model agreement never makes a claim SUPPORTED — however many models agree, it stays UNVERIFIED", () => {
  const graph = new EvidenceGraph();
  const claim = finding(graph);
  for (const [source, label] of [["investigator", "b1-i1"], ["investigator", "b1-i2"], ["lead", "synthesis"], ["reviewer", "cycle-1"], ["worker", "attempt-1"]] as const)
    graph.addEvidence({ claim, source, relation: "supports", label, detail: "I checked and it holds; the tests pass." });
  graph.addEvidence({ claim, source: "citation", relation: "supports", label: "configuration.yaml", detail: "the cited file was shared" });
  graph.addEvidence({ claim, source: "human", relation: "supports", label: "approval", detail: "the human approved the delivery" });
  const a = graph.assess(claim);
  assert.equal(a.status, "UNVERIFIED");
  assert.deepEqual([a.models.supports, a.citations, a.human, a.deterministic.supports], [5, 1, 1, 0]);
  // The same claim as a root cause: its obligation stays UNKNOWN and the decision UNVERIFIED — a provider's claim is not proof.
  const results = evaluateObligations([{ kind: "rootCauseSupported", tier: "correctness" }], facts({ rootCause: a }));
  assert.equal(results[0]!.status, "UNKNOWN");
  assert.match(results[0]!.reason, /5 model judgement\(s\) agree, which is not evidence/u);
  assert.equal(decide(results).decision, "UNVERIFIED");
});

test("v0.4 invariant 3: one deterministic contradiction outranks every model — the claim is CONTRADICTED and stays so", () => {
  const graph = new EvidenceGraph();
  const claim = finding(graph);
  graph.addEvidence({ claim, source: "investigator", relation: "supports", label: "b1-i1", detail: "supported" });
  graph.addEvidence({ claim, source: "investigator", relation: "supports", label: "b1-i2", detail: "supported" });
  graph.addEvidence({ claim, source: "fileCheck", relation: "supports", label: "k1", detail: "configuration.yaml contains `http:` (as predicted)" });
  graph.addEvidence({ claim, source: "fileCheck", relation: "contradicts", label: "k2", detail: "configuration.yaml contains `trusted_proxies` (predicted absent)" });
  graph.addEvidence({ claim, source: "lead", relation: "supports", label: "diagnosis", detail: "the claim holds" });
  const a = graph.assess(claim);
  assert.equal(a.status, "CONTRADICTED");
  assert.deepEqual([a.deterministic.supports, a.deterministic.contradicts, a.models.supports], [1, 1, 3]);
  // History is kept, never overwritten: claimed → judged → tested (supported) → tested (contradicted) → concluded.
  assert.deepEqual(graph.timeline(claim).map(t => "source" in t.entry ? `${t.entry.source}:${t.entry.relation}` : "claim"),
    ["claim", "investigator:supports", "investigator:supports", "fileCheck:supports", "fileCheck:contradicts", "lead:supports"]);
  // Deterministic support only ever when no deterministic contradiction exists.
  const other = new EvidenceGraph();
  const id = finding(other);
  other.addEvidence({ claim: id, source: "reproduction", relation: "supports", label: "configuration", detail: "fails on the unchanged baseline" });
  assert.equal(other.assess(id).status, "SUPPORTED");
});

test("v0.4 invariant 5: contradiction stays visible — model conflict, open counterexamples and refuted counterexamples", () => {
  const graph = new EvidenceGraph();
  const claim = finding(graph);
  graph.addEvidence({ claim, source: "investigator", relation: "supports", label: "b1-i1", detail: "supported" });
  graph.addEvidence({ claim, source: "investigator", relation: "contradicts", label: "b1-i2", detail: "contradicted" });
  assert.deepEqual([graph.assess(claim).modelConflict, graph.assess(claim).challenged], [true, true]);
  const quiet = new EvidenceGraph();
  const q = finding(quiet);
  quiet.addEvidence({ claim: q, source: "fileCheck", relation: "supports", label: "k1", detail: "as predicted" });
  const counter = quiet.addClaim({ kind: "counterexample", origin: "falsifier", ref: "falsification", subject: "counterexample 1",
    statement: "trusted_proxies is set in packages/http.yaml instead", files: ["packages/http.yaml"], challenges: q })!;
  assert.equal(quiet.assess(q).status, "SUPPORTED", "an untested counterexample never changes a status");
  assert.equal(quiet.assess(q).challenged, true, "but it is an open challenge");
  quiet.addEvidence({ claim: counter, source: "fileCheck", relation: "contradicts", label: "k2", detail: "packages/http.yaml does not exist" });
  assert.equal(quiet.assess(q).challenged, false, "Fusion refuted it");
  assert.equal(quiet.assess(counter).status, "CONTRADICTED");
  assert.throws(() => quiet.addClaim({ kind: "counterexample", origin: "falsifier", ref: "x", subject: "s", statement: "t", challenges: "nope" }), FusionFailure);
});

test("v0.4 invariant 12: stale evidence never settles a claim where freshness matters", () => {
  const graph = new EvidenceGraph();
  const claim = finding(graph);
  graph.addEvidence({ claim, source: "fileCheck", relation: "supports", label: "k1", detail: "as predicted", basis: "view:aaaa" });
  assert.equal(graph.assess(claim).status, "SUPPORTED");
  const current = (basis: string) => basis === "view:bbbb";
  const stale = graph.assess(claim, current);
  assert.deepEqual([stale.status, stale.deterministic.stale], ["STALE", 1]);
  const results = evaluateObligations([{ kind: "rootCauseSupported", tier: "correctness" }], facts({ rootCause: stale }));
  assert.deepEqual([results[0]!.status, results[0]!.reason], ["UNKNOWN", "its evidence is stale: the repository changed after it was observed"]);
  // Fresh evidence of the current state settles it again; a stale contradiction does not hide behind a fresh support.
  graph.addEvidence({ claim, source: "reproduction", relation: "supports", label: "configuration", detail: "fails on the baseline", basis: "view:bbbb" });
  assert.equal(graph.assess(claim, current).status, "SUPPORTED");
});

test("v0.4 graph bounds: an overflowed graph reports nothing SUPPORTED and is never deliverable", () => {
  const graph = new EvidenceGraph();
  const claim = finding(graph);
  graph.addEvidence({ claim, source: "verification", relation: "supports", label: "unit", detail: "passed" });
  for (let i = 1; i < EVIDENCE_LIMITS.maxEvidence; i++) graph.addEvidence({ claim, source: "investigator", relation: "supports", label: `b1-i${i}`, detail: "ok" });
  assert.equal(graph.overflowed, false);
  assert.equal(graph.addEvidence({ claim, source: "fileCheck", relation: "contradicts", label: "k9", detail: "dropped" }), undefined);
  assert.equal(graph.overflowed, true);
  assert.equal(graph.assess(claim).status, "UNVERIFIED", "a dropped contradiction could hide: no SUPPORTED");
  const all: ObligationRequirement[] = [{ kind: "verificationPassed", tier: "safety" }];
  const verdict = decide(evaluateObligations(all, facts()), { overflowed: true });
  assert.deepEqual([verdict.decision, verdict.deliverable], ["UNVERIFIED", false]);
  for (let i = 0; i < EVIDENCE_LIMITS.maxClaims; i++) graph.addClaim({ kind: "hypothesis", origin: "investigator", ref: "b1", subject: "h", statement: "x" });
  assert.equal(graph.claims.length, EVIDENCE_LIMITS.maxClaims);
});

test("v0.4 graph text and labels: model text is bounded to one clean line; host labels and paths are validated", () => {
  const graph = new EvidenceGraph();
  const id = graph.addClaim({ kind: "hypothesis", origin: "investigator", ref: "b1-i1", subject: "hypothesis\u202e 1",
    statement: `${"x".repeat(1_000)}\n\u001b[31mred`, files: ["ok/file.ts", "../escape", "C:\\abs", "/abs", "a//b", "ok/file.ts"] })!;
  const claim = graph.claim(id)!;
  assert.equal(claim.statement.length, EVIDENCE_LIMITS.maxStatementChars);
  assert.ok(claim.statement.endsWith("…"));
  assert.doesNotMatch(claim.subject, /\u202e/u);
  assert.deepEqual(claim.files, ["ok/file.ts"]);
  assert.throws(() => graph.addEvidence({ claim: id, source: "fileCheck", relation: "supports", label: "bad label!", detail: "x" }), FusionFailure);
  assert.throws(() => graph.addEvidence({ claim: "missing", source: "fileCheck", relation: "supports", label: "k1", detail: "x" }), FusionFailure);
  assert.throws(() => graph.addEvidence({ claim: id, source: "oracle" as never, relation: "supports", label: "k1", detail: "x" }), FusionFailure);
  assert.throws(() => graph.addClaim({ key: id, kind: "hypothesis", origin: "investigator", ref: "b1", subject: "s", statement: "t" }), FusionFailure);
});

test("v0.4 persistence: the graph round-trips exactly and a malformed record is refused, never read as a cleaner one", () => {
  const graph = new EvidenceGraph();
  const claim = finding(graph);
  graph.addEvidence({ claim, source: "reproduction", relation: "supports", label: "configuration", detail: "fails on the baseline", basis: "baseline:abc" });
  const alt = graph.addClaim({ kind: "hypothesis", origin: "investigator", ref: "b1-i2", subject: "alternative", statement: "the proxy is misconfigured", challenges: claim })!;
  graph.addEvidence({ claim: alt, source: "fileCheck", relation: "contradicts", label: "k1", detail: "no proxy file" });
  const record = JSON.parse(JSON.stringify(graph.record())) as EvidenceGraphRecord;
  assert.deepEqual(parseEvidenceGraph(record), graph.record());
  const copy = EvidenceGraph.from(record);
  assert.deepEqual(copy.assess(claim), graph.assess(claim));
  assert.equal(copy.addClaim({ kind: "diagnosis", origin: "lead", ref: "synthesis", subject: "d", statement: "s" }), "c3");
  const refused = (mutate: (r: Record<string, any>) => void) => {
    const bad = structuredClone(record) as Record<string, any>;
    mutate(bad);
    assert.throws(() => parseEvidenceGraph(bad), (e: unknown) => e instanceof FusionFailure && e.error.kind === "InvalidInput");
  };
  refused(r => { r.version = 2; });
  refused(r => { r.extra = true; });
  refused(r => { r.claims[0].statement = "   padded  "; });
  refused(r => { r.evidence[0].source = "oracle"; });
  refused(r => { r.evidence[0].claim = "c9"; });
  refused(r => { r.evidence[1].order = 1; });
  refused(r => { r.evidence[0].id = "e7"; });
  refused(r => { r.claims[1].challenges = "c9"; });
  refused(r => { r.claims[0].files = ["../x"]; });
  refused(r => { r.overflowed = "no"; });
});

// ---------------------------------------------------------------- proof obligations and the decision

test("v0.4 invariant 2: Fusion-observed execution satisfies the matching obligations — fail before, pass after", () => {
  const all: ObligationRequirement[] = [{ kind: "verificationPassed", tier: "safety" }, { kind: "scopeRespected", tier: "safety" },
    { kind: "protectedUnchanged", tier: "safety" }, { kind: "defectReproduced", tier: "correctness" }, { kind: "reproductionResolved", tier: "correctness" }];
  const results = evaluateObligations(all, facts());
  assert.deepEqual(results.map(r => r.status), ["PASS", "PASS", "PASS", "PASS", "PASS"]);
  assert.equal(results[4]!.reason, "check configuration failed before the change and passes after it");
  const verdict = decide(results);
  assert.deepEqual([verdict.decision, verdict.deliverable], ["VERIFIED", true]);
});

test("v0.4 invariant 3/4: a failed deterministic check BLOCKS; missing required evidence is UNVERIFIED; unknown never passes", () => {
  const all: ObligationRequirement[] = [{ kind: "verificationPassed", tier: "safety" }, { kind: "defectReproduced", tier: "correctness" },
    { kind: "reproductionResolved", tier: "correctness" }];
  const failed = evaluateObligations(all, facts({ verification: { passed: false, complete: true, commands: [fail("configuration")] } }));
  assert.deepEqual(failed.map(r => r.status), ["FAIL", "PASS", "FAIL"]);
  assert.deepEqual([decide(failed).decision, decide(failed).deliverable], ["BLOCKED", false]);
  // No reproduction: the checks pass on the baseline. Correctness is unknown: UNVERIFIED, deliverable only as such.
  const unreproduced = evaluateObligations(all, facts({ reproduction: { ran: true, commands: [pass("configuration")] } }));
  assert.deepEqual(unreproduced.map(r => r.status), ["PASS", "UNKNOWN", "UNKNOWN"]);
  assert.match(unreproduced[1]!.reason, /do not reproduce the defect/u);
  assert.deepEqual([decide(unreproduced).decision, decide(unreproduced).deliverable], ["UNVERIFIED", true]);
  // The same gap as a SAFETY obligation (strict: high risk or security-sensitive): never delivered.
  const strict = evaluateObligations(all.map(r => ({ ...r, tier: "safety" as const })), facts({ reproduction: { ran: true, commands: [pass("configuration")] } }));
  assert.deepEqual([decide(strict).decision, decide(strict).deliverable], ["UNVERIFIED", false]);
  // Nothing required establishes nothing.
  assert.deepEqual([decide([]).decision, decide([]).deliverable], ["UNVERIFIED", false]);
});

test("v0.4 invariant 11: a provider or verifier failure can only leave obligations UNKNOWN — never VERIFIED", () => {
  const all: ObligationRequirement[] = [{ kind: "verificationPassed", tier: "safety" }, { kind: "freshReviewClear", tier: "safety" },
    { kind: "defectReproduced", tier: "correctness" }, { kind: "behaviorPreserved", tier: "correctness" }];
  const results = evaluateObligations(all, facts({ verification: { passed: false, complete: false, commands: [], refusal: "backendUnavailable" },
    reproduction: { ran: false, reason: "backendUnavailable" }, freshReview: { ran: false, clean: false, outstanding: 0, objective: "falsify",
      reason: "the fresh falsification failed (provider failure)" } }));
  assert.deepEqual(results.map(r => r.status), ["UNKNOWN", "UNKNOWN", "UNKNOWN", "UNKNOWN"]);
  assert.match(results[0]!.reason, /could not start \(backendUnavailable\)/u);
  assert.equal(results[1]!.reason, "the fresh falsification failed (provider failure)");
  assert.deepEqual([decide(results).decision, decide(results).deliverable], ["UNVERIFIED", false]);
});

test("v0.4 obligations: scope, protected files, fresh review, alternatives and behavior preservation are mechanical", () => {
  const req = (kind: ObligationRequirement["kind"]): ObligationRequirement[] => [{ kind, tier: "safety" }];
  assert.equal(evaluateObligations(req("scopeRespected"), facts({ changedPaths: ["configuration.yaml", "secrets.yaml"] }))[0]!.status, "FAIL");
  assert.equal(evaluateObligations(req("scopeRespected"), facts({ changedPaths: ["Configuration.YAML"] }))[0]!.status, "PASS");
  assert.equal(evaluateObligations(req("scopeRespected"), facts({ scopeViolation: true }))[0]!.status, "FAIL");
  assert.equal(evaluateObligations(req("protectedUnchanged"), facts({ protectedChanged: [".env"] }))[0]!.status, "FAIL");
  assert.equal(evaluateObligations(req("protectedUnchanged"), facts({ changedPaths: [] }))[0]!.status, "UNKNOWN");
  assert.equal(evaluateObligations(req("freshReviewClear"), facts({ freshReview: { ran: true, clean: false, outstanding: 1, objective: "falsify" } }))[0]!.status, "FAIL");
  assert.equal(evaluateObligations(req("freshReviewClear"), facts({ freshReview: { ran: true, clean: true, outstanding: 0, objective: "falsify" } }))[0]!.status, "PASS");
  const graph = new EvidenceGraph();
  const a = graph.addClaim({ kind: "hypothesis", origin: "investigator", ref: "b1-i1", subject: "a", statement: "a" })!;
  const b = graph.addClaim({ kind: "hypothesis", origin: "investigator", ref: "b1-i2", subject: "b", statement: "b" })!;
  graph.addEvidence({ claim: a, source: "fileCheck", relation: "contradicts", label: "k1", detail: "no" });
  assert.equal(evaluateObligations(req("alternativesAddressed"), facts({ alternatives: [graph.assess(a), graph.assess(b)] }))[0]!.status, "UNKNOWN");
  graph.addEvidence({ claim: b, source: "fileCheck", relation: "supports", label: "k2", detail: "yes" });
  assert.equal(evaluateObligations(req("alternativesAddressed"), facts({ alternatives: [graph.assess(a), graph.assess(b)] }))[0]!.status, "FAIL");
  const refactor = (after: boolean[]) => evaluateObligations(req("behaviorPreserved"), facts({ reproduction: { ran: true, commands: [pass("unit"), pass("types")] },
    verification: { passed: after.every(Boolean), complete: true, commands: [{ id: "unit", passed: after[0]! }, { id: "types", passed: after[1]! }] } }))[0]!.status;
  assert.deepEqual([refactor([true, true]), refactor([true, false])], ["PASS", "FAIL"]);
  assert.equal(evaluateObligations(req("behaviorPreserved"), facts({ reproduction: { ran: true, commands: [fail("unit")] } }))[0]!.status, "UNKNOWN");
});

test("v0.4 presentation vocabulary: the words a human reads next to each obligation", () => {
  assert.equal(obligationLabel("defectReproduced", "bugFix"), "reproduced defect");
  assert.equal(obligationLabel("defectReproduced", "configFix"), "invalid state shown");
  assert.equal(obligationLabel("freshReviewClear", "bugFix", "falsify"), "fresh falsification");
  assert.deepEqual([obligationWord("protectedUnchanged", "PASS"), obligationWord("freshReviewClear", "PASS"), obligationWord("rootCauseSupported", "FAIL"),
    obligationWord("alternativesAddressed", "PASS"), obligationWord("defectReproduced", "UNKNOWN")],
    ["UNCHANGED", "NO BLOCKER", "CONTRADICTED", "CONTRADICTED", "NOT REPRODUCED"]);
});

// ---------------------------------------------------------------- the reliability policy

const profileOf = (text: string, paths: string[], operation: "implement" | "refactor" = "implement") => {
  const inspection = inspectTask({ operation, summary: text, paths, scopeKnown: true, expectedMutation: paths.length === 1 ? "singleFile" : "multiFile",
    requestedCapabilities: { write: true }, verification: { required: true, planProvided: true } });
  return { profile: classifyTask({ text, paths, operation, pathClasses: inspection.pathClasses, risk: inspection.risk }), risk: inspection.risk };
};

test("v0.4 policy: the host classifies a task from its own facts — fix, configuration fix, refactor, change, sensitivity", () => {
  assert.deepEqual(profileOf("Fix this finding from the analysis: configuration.yaml: `http` has no `trusted_proxies`", ["configuration.yaml"]).profile,
    { taskClass: "configFix", sensitive: false });
  assert.equal(profileOf("Fix the crash when the list is empty", ["src/list.ts"]).profile.taskClass, "bugFix");
  assert.equal(profileOf("Behebe den Fehler in der Liste", ["src/list.ts"]).profile.taskClass, "bugFix");
  assert.equal(profileOf("Rename parseItems to readItems", ["src/list.ts"]).profile.taskClass, "refactor");
  assert.equal(profileOf("Tidy the helpers", ["src/list.ts"], "refactor").profile.taskClass, "refactor");
  assert.equal(profileOf("Add a --verbose flag", ["src/cli.ts"]).profile.taskClass, "change");
  assert.equal(profileOf("Add failover support", ["src/cli.ts"]).profile.taskClass, "change", "no false fix for 'failover'");
  const sensitive = profileOf("Fix the session expiry", ["src/auth/session.ts"]);
  assert.deepEqual(sensitive.profile, { taskClass: "bugFix", sensitive: true });
});

test("v0.4 invariant 13/14: simple work stays cheap; higher risk and sensitivity need a stronger obligation set", () => {
  const cheap = reliabilityPlan({ taskClass: "change", sensitive: false }, low);
  assert.deepEqual([cheap.reproduce, cheap.freshReview, cheap.strict, cheap.obligations.map(o => o.kind)],
    [false, false, false, ["verificationPassed", "scopeRespected", "protectedUnchanged"]], "a low-risk change: no reproduction, no committee");
  const lowFix = reliabilityPlan({ taskClass: "bugFix", sensitive: false }, low);
  assert.deepEqual([lowFix.reproduce, lowFix.freshReview, lowFix.strict], [true, false, false], "a low-risk fix: a reproduction run, no model turn added");
  assert.deepEqual(lowFix.obligations.filter(o => o.tier === "correctness").map(o => o.kind), ["defectReproduced", "reproductionResolved", "rootCauseSupported"]);
  const config = reliabilityPlan({ taskClass: "configFix", sensitive: false }, low);
  assert.ok(!config.obligations.some(o => o.kind === "rootCauseSupported"), "a configuration fix proves invalid and corrected state");
  const mediumFix = reliabilityPlan({ taskClass: "bugFix", sensitive: false }, medium);
  assert.deepEqual([mediumFix.freshReview, mediumFix.objective, mediumFix.strict], [true, "falsify", false]);
  const highFix = reliabilityPlan({ taskClass: "bugFix", sensitive: false }, high, { alternatives: 2 });
  assert.equal(highFix.strict, true);
  assert.ok(highFix.obligations.every(o => o.tier === "safety"), "at high risk every obligation is a safety obligation");
  assert.ok(highFix.obligations.some(o => o.kind === "alternativesAddressed"));
  const sensitiveChange = reliabilityPlan({ taskClass: "change", sensitive: true }, low);
  assert.deepEqual([sensitiveChange.freshReview, sensitiveChange.objective, sensitiveChange.strict], [true, "falsify", true]);
  const highChange = reliabilityPlan({ taskClass: "change", sensitive: false }, high);
  assert.deepEqual([highChange.freshReview, highChange.objective], [true, "review"], "v0.3's fresh review at high risk is kept");
  // Risk never falls: a plan for an escalated assessment is never weaker than for the original.
  const escalated = escalateRisk(low, [{ code: "late", level: "high", source: "diff", evidence: "x" }]);
  assert.equal(reliabilityPlan({ taskClass: "bugFix", sensitive: false }, escalated).strict, true);
});

test("v0.4 guard: the evidence core names no provider or model and imports nothing outside the core", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama|sonnet|haiku/iu;
  const dir = join(process.cwd(), "src", "core", "evidence");
  for (const name of await readdir(dir)) {
    const source = await readFile(join(dir, name), "utf8");
    assert.doesNotMatch(source, forbidden, name);
    for (const [, from] of source.matchAll(/from "([^"]+)"/gu))
      assert.ok(from!.startsWith("./") || from!.startsWith("../") && !from!.startsWith("../../"), `${name} imports ${from}`);
  }
});
