import { build, planBuild, verificationPreflight, type BuildOptions } from "../app/commands.js";
import { proposeBuildScope, protectedScopeMessage } from "../app/build-scope.js";
import { loadConfig } from "../app/config.js";
import { ControlPlane } from "../app/control-plane.js";
import { checkCreateTarget, createTask, planCreate, scaffoldProject } from "../app/create.js";
import { applyStoredDelivery, approvalCandidate, deliveryRepository, recordSummaryApproval, type DeliveryApplyReport,
  type DeliveryInspection } from "../app/delivery-service.js";
import { issueConfirmedPlanAuthorization, issueWriterRunAuthorization } from "../app/writer-gate.js";
import { EXIT_CODES } from "./failure-presentation.js";
import { BUILD_QUESTION, createQuestion, renderBuild, renderBuildPlan, renderCreatePlan, renderTie, tieQuestion } from "./render.js";
import type { CandidateId } from "../core/tournament/contracts.js";
import type { TieChoice } from "../app/tournament/run.js";
import { renderApplyPlan, renderApplyReport } from "./render-delivery.js";

/**
 * The interactive transitions from talking to changing, shared by the expert commands (`fusion build`, `fusion create`) and
 * the v0.2 shell. Every transition shows what will happen first and starts only on the human's explicit answer at an
 * interactive terminal; nothing here is reachable from a model reply.
 */
export interface InteractiveIO {
  /** True only when a human is at an interactive terminal. */
  readonly interactive?: boolean;
  prompt?(question: string): Promise<string | null>;
}
/** `typed`: the human types the confirmation word (expert commands). `yesNo`: an explicit yes under the shown plan (the shell). */
export type ConfirmationStyle = "typed" | "yesNo";
export const PLAN_QUESTION = "Start this verified build? [y/N] ";
/**
 * v0.5: a HUMAN's choice among tied candidates, at an interactive terminal only: the tie and Fusion's host-observed differences
 * are shown, and only an exact candidate id among the tied ones chooses (anything else chooses none — never a default).
 * Absent without an interactive terminal: the tie is then the outcome.
 */
export function tieChooser(io: InteractiveIO, out: (text: string) => void): ((tie: TieChoice) => Promise<CandidateId | undefined>) | undefined {
  if (io.interactive !== true || io.prompt === undefined) return undefined;
  const prompt = io.prompt.bind(io);
  return async tie => {
    out(renderTie(tie));
    const answer = (await prompt(tieQuestion(tie.candidates)))?.trim().toLowerCase();
    return tie.candidates.find(candidate => candidate === answer);
  };
}

/** A confirmation: the confirmed options, nothing (not asked or declined: the build stops at its gate), or an early refusal. */
export interface Confirmation { readonly options?: BuildOptions; readonly refused?: string }
/**
 * v0.1: shows a Writer build's plan and asks the human to confirm it; the run-scoped authorization it returns covers exactly
 * this task in this repository, once. Read-only builds, critical tasks (a human gate of their own) and non-interactive use
 * are never asked: the build then stops at its gate, before any provider starts.
 */
export async function confirmBuild(plane: ControlPlane, options: BuildOptions, io: InteractiveIO, out: (text: string) => void,
  style: ConfirmationStyle = "typed"): Promise<Confirmation> {
  if (io.interactive !== true || io.prompt === undefined) return {};
  let scoped = options, proposedBy: string | undefined;
  const first = await planBuild(plane, options);
  if (!first.writerRequired || first.risk.level === "critical") return {};
  // v0.2.1: a scope with protected material is refused before any model turn, with the reason and what to do instead.
  if (first.protected.length > 0) {
    const refused = protectedScopeMessage(first.protected);
    out(`${refused}\n`);
    return { refused };
  }
  // Without a confined verification plan the build is refused before any model turn, so no scope turn is spent on it.
  if (options.paths.length === 0 && first.verification.confinedCommands.length > 0) {
    // Nor when Fusion cannot verify here at all (no verifier, unsupported platform): refused before the scope turn.
    const refused = await verificationPreflight(plane, options);
    if (refused !== undefined) {
      out(`Build not started: ${refused} No provider was started and nothing was changed.\n`);
      return { refused };
    }
    // No --path: the Lead proposes the exact files in one read-only turn; the human confirms that list (or passes --path).
    out("No --path given: asking the lead which files this task needs (one read-only turn; nothing is changed)...\n");
    const proposal = await proposeBuildScope(plane, first.task, options);
    scoped = { ...options, paths: proposal.paths };
    proposedBy = `${proposal.partner.role.toLowerCase()} (${proposal.partner.provider})`;
  }
  const plan = await planBuild(plane, scoped);
  if (!plan.writerRequired || plan.risk.level === "critical") return {};
  out(renderBuildPlan(plan, proposedBy));
  if (plan.protected.length > 0) {
    const refused = protectedScopeMessage(plan.protected);
    out(`${refused}\n`);
    return { refused };
  }
  // v0.5: the confirmation covers the candidate count the plan showed (several candidates are several full builds).
  const request = { task: plan.task, paths: plan.paths, repositoryRoot: plan.repository, candidates: plan.tournament.candidates };
  const authorization = style === "yesNo" ? issueConfirmedPlanAuthorization({ ...request, answer: await io.prompt(PLAN_QUESTION) })
    : issueWriterRunAuthorization({ ...request, typed: await io.prompt(BUILD_QUESTION) });
  if (authorization === undefined) { out("Build not started: it was not confirmed. No provider was started for the build.\n"); return {}; }
  return { options: { ...scoped, authorization } };
}

/** v0.1 `fusion create`: plan (no writes) → the human types "create" → Fusion scaffolds the template → the normal confirmed build. */
export async function createFlow(plane: ControlPlane, input: Readonly<{ description: string; template?: string; name?: string; configPath?: string;
  signal?: AbortSignal; timeoutMs?: number }>, io: InteractiveIO & Readonly<{ stderr(text: string): void }>, out: (text: string) => void): Promise<number> {
  const request = { ...(input.configPath === undefined ? {} : { configPath: input.configPath }), ...(input.signal ? { signal: input.signal } : {}) };
  const plan = planCreate(plane.deps.cwd, { description: input.description, ...(input.template ? { template: input.template } : {}),
    ...(input.name ? { name: input.name } : {}) });
  await checkCreateTarget(plan, plane.deps.env);
  const bindings = (await loadConfig(undefined, request.configPath, plane.deps.cwd, plane.deps.registry.defaults)).config.bindings;
  out(renderCreatePlan(plan, bindings));
  if (io.interactive !== true || io.prompt === undefined) {
    io.stderr("fusion: create needs a human at an interactive terminal to confirm it; nothing was created.\n");
    return EXIT_CODES.humanGateRequired;
  }
  const typed = await io.prompt(createQuestion(plan.directory));
  if (typed === null || typed.trim().toLowerCase() !== "create") { out("Nothing was created: it was not confirmed.\n"); return EXIT_CODES.blocked; }
  const project = await scaffoldProject(plan, plane.deps.env, bindings);
  out(`Created ${project.root} (template ${plan.family}); Git baseline ${project.baseCommit.slice(0, 12)}.\n`);
  const target = new ControlPlane({ ...plane.deps, cwd: project.root });
  let confirmation: Confirmation;
  try {
    confirmation = await confirmBuild(target, { ...request, task: createTask(plan), paths: [], operation: "implement",
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }, io, out);
  } catch (error) {
    out(`The project is created at ${project.root}; its build did not start.\n`);
    throw error;
  }
  const confirmed = confirmation.options;
  if (confirmation.refused !== undefined) {
    out(`The project is created at ${project.root}; its build did not start. Run fusion build there once verification is available.\n`);
    return EXIT_CODES.blocked;
  }
  if (confirmed === undefined) {
    out(`The project is created; no build ran. Run fusion build in ${project.root} when you are ready.\n`);
    return EXIT_CODES.success;
  }
  const report = await build(target, confirmed);
  out(renderBuild(report));
  return report.outcome.exitCode;
}

// ---------------------------------------------------------------- v0.2: simplified approval

export const APPLY_QUESTION = "Apply these exact verified changes? [y/N] ";
const KIND = { create: "new", update: "changed", delete: "deleted" } as const;

/**
 * The shell's summary of one prepared delivery: what changes, the verification and review results, Fusion's evidence decision
 * (v0.4, when the build that prepared it is known) and its exact identity.
 */
export function renderReadyToApply(i: DeliveryInspection, evidence?: Readonly<{ decision: string; open: number }>): string {
  const files = i.files.length;
  const v = i.verification, r = i.review;
  return ["", "Ready to apply verified changes",
    `  ${files} file${files === 1 ? "" : "s"} ${i.counts.delete > 0 && i.counts.create + i.counts.update === 0 ? "deleted" : "changed"}:`,
    ...i.files.slice(0, 20).map(f => `    ${f.path} (${KIND[f.kind]})`), ...(files > 20 ? [`    … and ${files - 20} more (fusion inspect-delivery ${i.deliveryId})`] : []),
    `  Verification: ${v.passed ? "PASS" : "FAIL"} (${v.commands.length} command${v.commands.length === 1 ? "" : "s"} in ${v.backendId}, ${v.confinement})`,
    `  Review: ${r.state === "clean" ? "PASS" : "not required"} (${r.cycles} review cycle${r.cycles === 1 ? "" : "s"}, no open findings)`,
    ...(evidence === undefined ? [] : [`  Evidence decision: ${evidence.decision}${evidence.open > 0
      ? ` — ${evidence.open} proof obligation(s) not established (listed above); approve only if you accept that` : ""}`]),
    `  Delivery: ${i.deliveryId}`, `  Manifest: sha256:${i.manifestSha256}`,
    "  Your working tree must still be at the same commit and clean; Fusion checks that again before writing anything.",
    "  Nothing is committed or pushed. See every line first with: fusion inspect-delivery " + i.deliveryId, ""].join("\n");
}

export interface DeliveryOffer {
  readonly outcome: "applied" | "declined" | "notApproved" | "notApplied";
  readonly report?: DeliveryApplyReport;
}
/**
 * v0.2 — offers one prepared delivery for approval and apply in a single step: the summary of exactly this delivery, one
 * explicit yes, then a durable approval bound to the SHOWN manifest digest (`recordSummaryApproval`: the delivery is
 * re-loaded and must still carry it) and the normal single-use apply with its full precheck. Anything but an explicit yes
 * approves nothing; the expert commands (`approve-delivery`, `apply`) keep working for a delivery left pending.
 */
export async function offerDelivery(plane: ControlPlane, deliveryId: string, io: InteractiveIO, out: (text: string) => void,
  evidence?: Readonly<{ decision: string; open: number }>): Promise<DeliveryOffer> {
  const repository = await deliveryRepository(plane);
  const candidate = await approvalCandidate(repository, deliveryId);
  out(renderReadyToApply(candidate, evidence));
  const pending = `Not applied. The delivery stays ready: fusion approve-delivery ${deliveryId}, then fusion apply ${deliveryId}.\n`;
  if (io.interactive !== true || io.prompt === undefined) { out(pending); return { outcome: "declined" }; }
  const answer = await io.prompt(APPLY_QUESTION);
  if (answer === null || answer.trim().length === 0 || !/^(?:y|yes|j|ja)$/iu.test(answer.trim())) { out(pending); return { outcome: "declined" }; }
  const approval = await recordSummaryApproval(repository, candidate.deliveryId, candidate.manifestSha256, answer);
  if (!approval.approved) { out(`Nothing was approved. ${pending}`); return { outcome: "notApproved" }; }
  const report = await applyStoredDelivery(plane, deliveryId, { onPlan: plan => { out(renderApplyPlan(plan)); } });
  out(renderApplyReport(report));
  if (report.result === "applied")
    out("Applied. The changes are in your working tree, uncommitted: review them with git diff, then commit when you are happy.\n");
  return { outcome: report.result === "applied" ? "applied" : "notApplied", report };
}
