import { fileURLToPath } from "node:url";
import { runCorrectionProbe } from "../../src/app/correction-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { CORRECTION_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * LIVE ENTRY of the review-correction probe (O5.5B30) — the review-driven correction branch entered at the post-adjudication
 * boundary: at most one real corrective Change Author turn and one real fresh re-review, with Fusion's host application
 * and confined verification between them, on a throw-away fixture, under a named correction-only authorization. Not part
 * of `npm test`.
 *
 *   node dist/test/live/correction-probe.js --authorization <id>
 *
 * A `pending` authorization is refused before anything exists; an `open` one runs ONCE, by the human, from a new, normal
 * PowerShell window (never from inside an agent session, and never through any detached or remote launcher). Each
 * authorization writes bounded evidence under its own %TEMP% namespace; its claim makes a second run refuse. Ctrl+C cancels
 * the run; cleanup still runs. Nothing here records a live result: that is a later milestone's independent review.
 */
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const authorization = option("--authorization");
const listed = Object.entries(CORRECTION_PROBE_PROFILES.authorizations).map(([id, entry]) => `${id} (${entry.state})`);

async function fusionContainers(): Promise<number> {
  const docker = await resolveDockerCli();
  if (docker === null) return -1;
  const outcome = await new CliDockerRunner(docker).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  return outcome.exitCode === 0 ? outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "").length : -1;
}

if (authorization === undefined || args.length !== 2) {
  process.stderr.write(`Usage: node dist/test/live/correction-probe.js --authorization <id>\nCorrection-only authorizations: ${listed.join("; ") || "none"}\n`);
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const report = await runCorrectionProbe({ env: process.env, registry: defaultRegistry(), profiles: CORRECTION_PROBE_PROFILES, authorization,
    compiledRoot: fileURLToPath(new URL("../../", import.meta.url)), fusionContainers, signal: controller.signal });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\nNo fixture, claim, evidence or provider process was created.\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence as Record<string, unknown>;
    type Turn = { turn: Record<string, unknown> | null; structuredOutput: Record<string, unknown> | "invalid" | null;
      terminal: Record<string, unknown> | "invalid" | null };
    const author = e.correctionAuthor as (Turn & { proposal: { outcome: string; operations?: number; paths?: string[] } | null }) | undefined;
    const rereview = e.rereview as (Turn & { contract: string; findings: { count: number } | null; decision: { kind: string } | null }) | undefined;
    const counts = e.launchCounts as Record<string, Record<string, number>> | undefined;
    const verification = (key: string) => e[key] as { passed: boolean; commandsRun: number; acceptance: string | null } | null | undefined;
    const boundary = e.boundary as { decision: { kind: string; findings?: string[] }; priorFindings: string[] } | null | undefined;
    const labels = (o: Record<string, unknown> | "invalid" | null | undefined, keys: readonly string[]) => o === null || o === undefined ? "none"
      : o === "invalid" ? "invalid" : keys.map(key => `${key}=${String(o[key])}`).join(" ");
    const TERMINAL = ["classification", "resultSubtype", "terminalReason", "isError", "internalTurnCount", "resultTextByteLength",
      "structuredParsingReached", "schemaValidationReached", "processExitCode"];
    const ENVELOPE = ["classification", "accepted", "policy", "bodyMatchesExpectedSchema"];
    const lines = [
      `${String(e.milestone)} review-correction probe: ${report.outcome}`,
      `detail: ${report.detail}`,
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turns started: ${report.modelTurns}`,
      ...(counts ? Object.entries(counts).map(([role, byPurpose]) => `${role} processes: ${Object.entries(byPurpose).map(([p, n]) => `${p}=${n}`).join(" ")}`) : []),
      ...(boundary ? [`boundary: decision ${boundary.decision.kind}${boundary.decision.findings ? ` (${boundary.decision.findings.join(", ")})` : ""}; prior findings ${boundary.priorFindings.join(", ") || "none"}`] : []),
      ...(verification("startingVerification") ? [`starting candidate verification: passed=${verification("startingVerification")!.passed} acceptance=${String(verification("startingVerification")!.acceptance)}`] : []),
      ...(author ? [`correction author: observedModel=${String(author.turn?.observedModel ?? "none")}; ChangeSet ${author.proposal?.outcome ?? "notReached"}${author.proposal?.paths ? ` (${author.proposal.paths.join(", ")})` : ""}`,
        `correction author terminal: ${labels(author.terminal, TERMINAL)}`, `correction author reply envelope: ${labels(author.structuredOutput, ENVELOPE)}`] : []),
      ...(verification("correctionVerification") ? [`corrected candidate verification: passed=${verification("correctionVerification")!.passed} commandsRun=${verification("correctionVerification")!.commandsRun} acceptance=${String(verification("correctionVerification")!.acceptance)}`] : []),
      ...(rereview && rereview.turn ? [`re-review: contract ${rereview.contract}; findings ${rereview.findings?.count ?? "none"}; decision ${rereview.decision?.kind ?? "none"}; observedModel=${String(rereview.turn.observedModel ?? "none")}`,
        `re-review terminal: ${labels(rereview.terminal, TERMINAL)}`, `re-review reply envelope: ${labels(rereview.structuredOutput, ENVELOPE)}`] : []),
      ...Object.entries((e.executableIdentityAfter as Record<string, { sha256Matches: unknown }> | undefined) ?? {})
        .map(([role, entry]) => `executable identity after the run: ${role} sha256Matches=${String(entry.sha256Matches)}`),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider model turn was started and nothing was consumed. Do NOT re-run: return this output for review first."
        : "Do NOT re-run: the authorization is consumed; another run needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
