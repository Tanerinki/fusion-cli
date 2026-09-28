import type { AdjudicatedFinding, Finding } from "../domain.js";
import { isOutstanding } from "../review/policy.js";
import type { ReproductionRecord, VerificationVerdict, WorkflowResult } from "../workflow/types.js";
import { EvidenceGraph, type ClaimAssessment, type EvidenceGraphRecord } from "./graph.js";
import { decide, evaluateObligations, type BuildFacts, type CommandOutcome, type EvidenceDecision } from "./obligations.js";
import type { ReliabilityPlan } from "./policy.js";

/**
 * v0.4 — THE EVIDENCE OF ONE WRITER RUN, assembled after the engine finished and BEFORE any delivery exists: Fusion's own
 * observations of the run become claims and evidence, the obligations are evaluated from host facts only, and the decision
 * says whether the change is VERIFIED and whether it may be prepared for delivery at all. Pure: the caller passes what the
 * host observed (the engine's result, the protected paths it checked) and records the result before preparing a delivery,
 * so an approval binds to exactly this evidence (the manifest carries the event log's digest).
 *
 * Claims of a run: the TASK (the change the human asked for); for a fix, the DEFECT (it exists before the change), the ROOT
 * CAUSE (it lies within the confirmed scope) and the FIX EFFECT (the change resolves it); for a refactor, the preserved
 * BEHAVIOR. Review or falsification findings are counterexamples challenging the task; their adjudication is a model
 * judgement, Fusion's own facts about them are evidence.
 */
export interface BuildEvidenceInput {
  readonly task: string;
  /** The confirmed write scope. */
  readonly scope: readonly string[];
  readonly plan: ReliabilityPlan;
  /** Commands of the confined plan (a verification is complete only when all of them ran). */
  readonly plannedCommands: number;
  readonly result: WorkflowResult;
  /** Changed paths the host classifies as protected or never deliverable. */
  readonly protectedChanged: readonly string[];
  /** The committed baseline the run started from (the basis of its observations). */
  readonly baseCommit?: string;
}
export interface BuildEvidence {
  readonly plan: ReliabilityPlan;
  readonly graph: EvidenceGraphRecord;
  readonly decision: EvidenceDecision;
}
/** Review findings recorded as counterexample claims (material first); the rest stay in the run's review record. */
const MAX_FINDING_CLAIMS = 16;
const key = (path: string): string => path.replace(/\\/gu, "/").toLowerCase();
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Per-command outcomes of a verdict as Fusion observed them (the commands that ran). */
export function commandOutcomes(verdict: VerificationVerdict | undefined): readonly CommandOutcome[] {
  return Object.freeze((verdict?.evidence?.commands ?? []).map(c => Object.freeze({ id: c.id, passed: c.status === "passed" })));
}
function reproductionFacts(record: ReproductionRecord | undefined): BuildFacts["reproduction"] {
  if (record === undefined) return undefined;
  if (!record.ran) return { ran: false, reason: record.reason };
  const commands = commandOutcomes(record.verdict);
  return commands.length === 0 ? { ran: false, reason: "noChecks" } : { ran: true, commands };
}

export function assembleBuildEvidence(input: BuildEvidenceInput): BuildEvidence {
  const { plan, result } = input;
  const graph = new EvidenceGraph();
  const scope = [...input.scope];
  const allowed = new Set(scope.map(key));
  const changed = [...(result.changedPaths ?? [])];
  const basis = input.baseCommit === undefined ? undefined : `baseline:${input.baseCommit.slice(0, 40)}`;
  const withBasis = basis === undefined ? {} : { basis };
  const reproduction = reproductionFacts(result.reproduction);
  const verdict = result.verification;
  const after = verdict?.refusal === undefined ? commandOutcomes(verdict) : [];
  const afterPassed = new Map(after.map(c => [c.id, c.passed]));

  // The task: what the human asked for, and what Fusion observed of the change.
  const task = graph.addClaim({ key: "task", kind: "task", origin: "user", ref: "run", subject: "task", statement: input.task, files: scope })!;
  for (const command of after)
    graph.addEvidence({ claim: task, source: "verification", relation: command.passed ? "supports" : "contradicts", label: command.id,
      detail: command.passed ? "passed on the final change (confined)" : "did not pass on the final change (confined)" });
  if (verdict?.refusal !== undefined)
    graph.addEvidence({ claim: task, source: "verification", relation: "neutral", label: verdict.refusal, detail: "the confined verification could not start" });
  if (changed.length > 0) {
    const outside = changed.filter(path => !allowed.has(key(path)));
    graph.addEvidence({ claim: task, source: "diff", relation: outside.length > 0 ? "contradicts" : "supports", label: "scope",
      detail: outside.length > 0 ? `${plural(outside.length, "changed file")} outside the confirmed scope` : `${plural(changed.length, "changed file")}, all within the confirmed scope` });
    graph.addEvidence({ claim: task, source: "protection", relation: input.protectedChanged.length > 0 ? "contradicts" : "supports", label: "protected",
      detail: input.protectedChanged.length > 0 ? `${plural(input.protectedChanged.length, "protected file")} changed` : "no protected, credential or never-deliverable file changed" });
  }

  // A fix: the defect, its root cause (within the confirmed scope) and the change's effect on it.
  const fix = plan.profile.taskClass === "bugFix" || plan.profile.taskClass === "configFix";
  const baselineFailing = reproduction?.ran === true ? reproduction.commands.filter(c => !c.passed).map(c => c.id) : [];
  const confined = changed.length > 0 && changed.every(path => allowed.has(key(path)));
  if (fix) {
    const defect = graph.addClaim({ key: "defect", kind: "finding", origin: "user", ref: "run", subject: "the defect",
      statement: "The defect this task names exists before the change.", files: scope })!;
    if (reproduction?.ran === true) for (const command of reproduction.commands)
      graph.addEvidence({ claim: defect, source: "reproduction", relation: command.passed ? "neutral" : "supports", label: command.id,
        detail: command.passed ? "passes on the unchanged baseline" : "fails on the unchanged baseline", ...withBasis });
    else if (reproduction !== undefined)
      graph.addEvidence({ claim: defect, source: "reproduction", relation: "neutral", label: reproduction.reason, detail: "the checks could not run on the unchanged baseline" });
    const rootCause = graph.addClaim({ key: "root-cause", kind: "rootCause", origin: "user", ref: "scope", subject: "root cause",
      statement: `The defect lies within the confirmed scope: ${scope.join(", ") || "(none)"}.`, files: scope })!;
    const effect = graph.addClaim({ key: "fix-effect", kind: "fixEffect", origin: "fusion", ref: "run", subject: "fix effect",
      statement: "The change resolves the reproduced defect.", files: changed })!;
    for (const id of baselineFailing) {
      const passed = afterPassed.get(id);
      if (passed === undefined) continue;
      graph.addEvidence({ claim: effect, source: "verification", relation: passed ? "supports" : "contradicts", label: id,
        detail: passed ? "failed on the unchanged baseline and passes after the change" : "fails on the unchanged baseline and still fails after the change" });
      // Fail before, pass after, with the change confined to the claimed files: the defect lies there. Still failing: it does not.
      if (confined) graph.addEvidence({ claim: rootCause, source: "verification", relation: passed ? "supports" : "contradicts", label: id,
        detail: passed ? "a change confined to the claimed files resolves this failing check" : "a change confined to the claimed files leaves this check failing",
        ...withBasis });
    }
  }
  if (plan.profile.taskClass === "refactor" && reproduction?.ran === true) {
    const behavior = graph.addClaim({ key: "behavior", kind: "fixEffect", origin: "fusion", ref: "run", subject: "behavior",
      statement: "The change preserves the behavior Fusion's checks demonstrate.", files: changed })!;
    for (const command of reproduction.commands.filter(c => c.passed)) {
      const passed = afterPassed.get(command.id);
      if (passed !== undefined) graph.addEvidence({ claim: behavior, source: "verification", relation: passed ? "supports" : "contradicts",
        label: command.id, detail: passed ? "passed before the change and still passes" : "passed before the change and fails after it" });
    }
  }

  // Review and falsification findings: counterexamples to the task. The Lead's adjudication is a judgement; Fusion's facts are evidence.
  const role = plan.objective === "falsify" ? "falsifier" : "reviewer";
  type Entry = Readonly<{ cycle: number; finding: Finding; adjudication?: AdjudicatedFinding }>;
  const findings: Entry[] = result.reviews.flatMap((cycle): Entry[] => cycle.adjudications.length > 0
    ? cycle.adjudications.map(a => ({ cycle: cycle.cycle, finding: a.finding, adjudication: a }))
    : cycle.findings.map(finding => ({ cycle: cycle.cycle, finding })));
  const ranked = [...findings].sort((a, b) => Number(b.adjudication !== undefined && isOutstanding(b.adjudication)) -
    Number(a.adjudication !== undefined && isOutstanding(a.adjudication)));
  for (const entry of ranked.slice(0, MAX_FINDING_CLAIMS)) {
    const claim = graph.addClaim({ kind: "counterexample", origin: role, ref: `cycle-${entry.cycle}`, subject: `${entry.finding.severity} finding ${entry.finding.id}`,
      statement: entry.finding.title, files: entry.finding.file === undefined ? [] : [entry.finding.file], challenges: task });
    if (claim === undefined) break;
    const a = entry.adjudication;
    if (a !== undefined) {
      graph.addEvidence({ claim, source: "lead", relation: a.verdict === "REJECTED" ? "contradicts" : a.verdict === "UNVERIFIABLE" ? "neutral" : "supports",
        label: `cycle-${entry.cycle}`, detail: `adjudicated ${a.verdict}, action ${a.requiredAction}` });
      for (const fact of a.supportedFacts)
        graph.addEvidence({ claim, source: fact.kind === "outOfScopeChange" ? "diff" : "verification", relation: "supports", label: fact.kind,
          detail: fact.kind === "verificationCommand" ? `Fusion's check ${fact.commandId} does not pass` : fact.kind === "outOfScopeChange"
            ? "Fusion observed a change outside the scope" : "a check the change author reported was never run by Fusion" });
    }
  }
  if (findings.length > MAX_FINDING_CLAIMS)
    graph.addEvidence({ claim: task, source: role, relation: "neutral", label: "findings",
      detail: `${findings.length - MAX_FINDING_CLAIMS} more finding(s) are in the run's review record` });

  // The facts the obligations are evaluated from: host observations and graph statuses only.
  const last = result.reviews.at(-1);
  const stage = plan.objective === "falsify" ? "falsification" : "review";
  const freshReview: BuildFacts["freshReview"] = last === undefined
    ? { ran: false, clean: false, outstanding: 0, objective: plan.objective,
        ...(result.state === "reviewRequired" ? { reason: `no eligible fresh partner could run the ${stage}` } : {}) }
    : { ran: true, clean: last.outcome === "clean", outstanding: last.adjudications.filter(isOutstanding).length, objective: plan.objective };
  const facts: BuildFacts = {
    ...(verdict === undefined ? {} : { verification: { passed: verdict.passed, complete: verdict.commandsRun === input.plannedCommands && after.length === input.plannedCommands,
      commands: after, ...(verdict.refusal === undefined ? {} : { refusal: verdict.refusal }) } }),
    ...(reproduction === undefined ? {} : { reproduction }),
    changedPaths: changed, allowedScope: scope, scopeViolation: result.transitions.some(t => t.reason === "unexpectedScope"),
    protectedChanged: [...input.protectedChanged],
    ...(plan.freshReview ? { freshReview } : {}),
    ...(graph.claim("root-cause") === undefined ? {} : { rootCause: graph.assess("root-cause") }),
  };
  const obligations = evaluateObligations(plan.obligations, facts);
  return Object.freeze({ plan, graph: graph.record(), decision: decide(obligations, { overflowed: graph.overflowed }) });
}

/** The assessment of one claim of a recorded graph (for presentation). */
export function assessRecorded(record: EvidenceGraphRecord, id: string): ClaimAssessment | undefined {
  const graph = EvidenceGraph.from(record);
  return graph.claim(id) === undefined ? undefined : graph.assess(id);
}
