import { resolve } from "node:path";
import { audit, auditExitCode, collectDiagnostics, doctorExitCode } from "../app/diagnostics.js";
import { build, review, show } from "../app/commands.js";
import { ControlPlane, type ControlPlaneDeps } from "../app/control-plane.js";
import { applyStoredDelivery, approvalCandidate, deliveryRepository, inspectStoredDelivery, recordHumanApproval,
  type DeliveryApplyReport } from "../app/delivery-service.js";
import type { TaskOperation } from "../core/policy/task-inspector.js";
import { FUSION_VERSION } from "../platform/events/shared.js";
import { parseArgs, USAGE, UsageError } from "./args.js";
import { EXIT_CODES, presentFailure } from "./failure-presentation.js";
import { jsonDocument, renderAudit, renderBuild, renderDoctor, renderReview, renderRun, terminalSafe } from "./render.js";
import { APPROVAL_QUESTION, renderApplyPlan, renderApplyReport, renderApprovalSummary, renderDeliveryInspection } from "./render-delivery.js";

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  /** True only when a human is at an interactive terminal (stdin and stdout are TTYs). `approve-delivery` refuses otherwise. */
  readonly interactive?: boolean;
  /** Asks the human one question; `null` when declined or cancelled (EOF, Ctrl+C). There is never a default answer. */
  prompt?(question: string): Promise<string | null>;
}
export interface CliHost extends Omit<ControlPlaneDeps, "cwd"> {
  readonly cwd: string;
  /** Aborted on Ctrl+C; propagated into the workflow and every provider/verifier process. */
  readonly signal?: AbortSignal;
}

/**
 * `fusion apply`: applied 0; not approved 14; precheck refused (nothing written, approval kept) 8; failed after the claim or
 * rolled back 8; restore incomplete 1; an outcome whose evidence could not be recorded 10 (a failed restore keeps 1).
 */
const APPLY_EXIT_CODES: Readonly<Record<DeliveryApplyReport["result"], number>> = { applied: EXIT_CODES.success,
  approvalRequired: EXIT_CODES.humanGateRequired, precheckFailed: EXIT_CODES.workspaceConflict, failed: EXIT_CODES.workspaceConflict,
  rolledBack: EXIT_CODES.workspaceConflict, rollbackFailed: EXIT_CODES.internal };

/**
 * The whole CLI as a function: argv in, exit code out. Expected failures are typed and presented without stack traces;
 * every line is redacted and terminal-safe. A result is printed only after the command has persisted it.
 */
export async function runCli(argv: readonly string[], io: CliIO, host: CliHost): Promise<number> {
  const plane0 = new ControlPlane({ ...host, cwd: host.cwd });
  const out = (text: string): void => io.stdout(terminalSafe(text, plane0.redactor));
  let args;
  try { args = parseArgs(argv); }
  catch (error) {
    if (!(error instanceof UsageError)) throw error;
    io.stderr(`${terminalSafe(`fusion: ${error.safeMessage}`, plane0.redactor)}\nRun \`fusion --help\` for usage.\n`);
    return EXIT_CODES.invalidInput;
  }
  if (args.help) { io.stdout(USAGE); return EXIT_CODES.success; }
  if (args.version) { io.stdout(`fusion ${FUSION_VERSION}\n`); return EXIT_CODES.success; }
  const plane = new ControlPlane({ ...host, cwd: resolve(host.cwd, args.cwd ?? ".") });
  const json = (value: unknown): void => io.stdout(jsonDocument(value, plane.redactor));
  const request = { ...(args.config === undefined ? {} : { configPath: args.config }), ...(host.signal ? { signal: host.signal } : {}) };
  const timeoutMs = args.timeoutSeconds === undefined ? undefined : args.timeoutSeconds * 1000;
  try {
    switch (args.command) {
      case "doctor": {
        const report = await collectDiagnostics(plane, { ...request, probe: args.probe });
        const code = doctorExitCode(report);
        if (args.json) json({ command: "doctor", exitCode: code, ...report }); else out(renderDoctor(report));
        return code;
      }
      case "audit": {
        const report = await audit(plane, request);
        const code = auditExitCode(report);
        if (args.json) json({ command: "audit", exitCode: code, ...report }); else out(renderAudit(report));
        return code;
      }
      case "review": {
        const report = await review(plane, { ...request, verify: args.verify, ...(args.base ? { base: args.base } : {}),
          ...(timeoutMs ? { timeoutMs } : {}) });
        if (args.json) json({ command: "review", exitCode: report.outcome.exitCode, ...report }); else out(renderReview(report));
        return report.outcome.exitCode;
      }
      case "build": {
        const report = await build(plane, { ...request, task: args.positionals[0]!, paths: args.paths,
          operation: (args.operation ?? "implement") as TaskOperation, ...(timeoutMs ? { timeoutMs } : {}) });
        if (args.json) json({ command: "build", exitCode: report.outcome.exitCode, ...report }); else out(renderBuild(report));
        return report.outcome.exitCode;
      }
      case "show": {
        const summary = await show(plane, args.positionals[0]!);
        if (args.json) json({ command: "show", exitCode: 0, run: summary }); else out(renderRun(summary));
        return EXIT_CODES.success;
      }
      case "inspect-delivery": {
        const inspection = await inspectStoredDelivery(await deliveryRepository(plane), args.positionals[0]!);
        if (args.json) json({ command: "inspect-delivery", exitCode: 0, delivery: inspection }); else out(renderDeliveryInspection(inspection));
        return EXIT_CODES.success;
      }
      case "approve-delivery": {
        const repository = await deliveryRepository(plane);
        const candidate = await approvalCandidate(repository, args.positionals[0]!);
        out(renderApprovalSummary(candidate));
        if (io.interactive !== true || io.prompt === undefined) {
          io.stderr("fusion: approve-delivery needs a human at an interactive terminal; nothing was approved.\n");
          return EXIT_CODES.humanGateRequired;
        }
        const typed = await io.prompt(APPROVAL_QUESTION);
        const result = typed === null ? { approved: false }
          : await recordHumanApproval(repository, candidate.deliveryId, candidate.manifestSha256, typed);
        if (!result.approved) {
          io.stderr(`fusion: ${typed === null ? "approval declined" : "the typed text is not the exact manifest digest"}; nothing was approved.\n`);
          return EXIT_CODES.decisionRequired;
        }
        out(`Approved delivery ${candidate.deliveryId} for manifest sha256:${candidate.manifestSha256} only.\n`);
        return EXIT_CODES.success;
      }
      case "apply": {
        // The plan (id, full digest, checkout, expected HEAD, operations, approval) is shown before the precheck runs.
        const report = await applyStoredDelivery(plane, args.positionals[0]!, args.json ? {} : { onPlan: plan => { out(renderApplyPlan(plan)); } });
        const code = !report.evidenceRecorded && report.result !== "rollbackFailed" ? EXIT_CODES.storage : APPLY_EXIT_CODES[report.result];
        if (args.json) json({ command: "apply", exitCode: code, delivery: report }); else out(renderApplyReport(report));
        return code;
      }
      default:
        io.stderr("fusion: missing command.\n");
        return EXIT_CODES.invalidInput;
    }
  } catch (error) {
    const failure = presentFailure(error, { debug: args.debug, redactor: plane.redactor });
    if (args.json) json({ command: args.command, exitCode: failure.exitCode,
      error: { category: failure.category, retryable: failure.retryable, text: failure.text } });
    else io.stderr(`${terminalSafe(failure.text, plane.redactor)}\n`);
    return failure.exitCode;
  }
}

/**
 * First Ctrl+C: abort the run (the workflow cancels in-flight turns and processes, and the outcome is recorded).
 * Second Ctrl+C: force exit.
 */
export function createInterruptHandler(stderr: (text: string) => void, forceExit: () => void):
  Readonly<{ signal: AbortSignal; interrupt: () => void }> {
  const controller = new AbortController();
  let count = 0;
  return { signal: controller.signal, interrupt: () => {
    count++;
    if (count > 1) { forceExit(); return; }
    stderr("fusion: cancelling; press Ctrl+C again to force exit.\n");
    controller.abort();
  } };
}
