import { fileURLToPath } from "node:url";
import { runReviewerProbe } from "../../src/app/reviewer-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { REVIEWER_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * LIVE ENTRY of the Reviewer-only validation probe (O5.5B23) — exactly one real fresh-review turn of the Reviewer binding
 * on the release under validation, on a throw-away fixture, under a named Reviewer-only authorization. Not part of
 * `npm test`.
 *
 *   node dist/test/live/reviewer-probe.js --authorization <id>
 *
 * A `pending` authorization is refused before anything exists; an `open` one runs ONCE, by the human, from a new, normal
 * PowerShell window (never from inside an agent session, and never through any detached or remote launcher). Each
 * authorization writes bounded evidence under its own %TEMP% namespace; its claim makes a second run refuse. Ctrl+C
 * cancels the run; cleanup still runs. Nothing here validates a release: that is a later milestone's independent review.
 */
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const authorization = option("--authorization");
const listed = Object.entries(REVIEWER_PROBE_PROFILES.authorizations).map(([id, entry]) => `${id} (${entry.state})`);

async function fusionContainers(): Promise<number> {
  const docker = await resolveDockerCli();
  if (docker === null) return -1;
  const outcome = await new CliDockerRunner(docker).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  return outcome.exitCode === 0 ? outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "").length : -1;
}

if (authorization === undefined || args.length !== 2) {
  process.stderr.write(`Usage: node dist/test/live/reviewer-probe.js --authorization <id>\nReviewer-only authorizations: ${listed.join("; ") || "none"}\n`);
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const report = await runReviewerProbe({ env: process.env, registry: defaultRegistry(), profiles: REVIEWER_PROBE_PROFILES, authorization,
    compiledRoot: fileURLToPath(new URL("../../", import.meta.url)), fusionContainers, signal: controller.signal });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\nNo fixture, claim, evidence or provider process was created.\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence as Record<string, unknown>;
    const counts = e.launchCounts as Record<string, number> | undefined;
    const review = e.review as { contract: string; findings: { count: number } | null; structuredOutput: Record<string, unknown> | "invalid" | null;
      terminal: Record<string, unknown> | "invalid" | null; turn: Record<string, unknown> | null } | undefined;
    const readback = e.readback as { auth: { state: string; lane: string }; reportedRuntimeVersion: string; matchesInstalled: boolean } | null | undefined;
    const verification = e.verification as { passed: boolean; commandsRun: number; acceptance: string | null;
      dependencies: { kind: string; prepared: boolean; cacheHit: boolean } | null } | null | undefined;
    const labels = (o: Record<string, unknown> | "invalid" | null | undefined, keys: readonly string[]) => o === null || o === undefined ? "none"
      : o === "invalid" ? "invalid" : keys.map(key => `${key}=${String(o[key])}`).join(" ");
    const lines = [
      `${String(e.milestone)} Reviewer-only probe: ${report.outcome}`,
      `detail: ${report.detail}`,
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turns started: ${report.modelTurns}`,
      `release under validation: ${String((e.runtimeUnderValidation as { version?: string } | undefined)?.version)}`,
      ...(counts ? [`provider processes started: ${Object.entries(counts).map(([purpose, n]) => `${purpose}=${n}`).join(" ")}`] : []),
      ...(verification ? [`candidate verification: passed=${verification.passed} commandsRun=${verification.commandsRun} acceptance=${String(verification.acceptance)}` +
        ` dependencyStage=${verification.dependencies === null ? "none" : `${verification.dependencies.kind} prepared=${verification.dependencies.prepared} cacheHit=${verification.dependencies.cacheHit}`}`] : []),
      ...(readback ? [`runtime readback: auth=${readback.auth.state}/${readback.auth.lane} reportedRuntimeVersion=${readback.reportedRuntimeVersion} matchesInstalled=${readback.matchesInstalled}`] : []),
      ...(review ? [`review: contract ${review.contract}; findings ${review.findings?.count ?? "none"}; observedModel=${String(review.turn?.observedModel ?? "none")}`,
        `terminal: ${labels(review.terminal, ["classification", "resultSubtype", "terminalReason", "isError", "resultTextPresent", "resultTextByteLength",
          "structuredParsingReached", "schemaValidationReached", "processExitCode"])}`,
        `reply envelope: ${labels(review.structuredOutput, ["classification", "accepted", "policy", "bodyMatchesExpectedSchema"])}`] : []),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider model turn was started and nothing was consumed. Do NOT re-run: return this output for review first."
        : "Do NOT re-run: the authorization is consumed; another run needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
