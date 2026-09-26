import { fileURLToPath } from "node:url";
import { runAdjudicationProbe } from "../../src/app/adjudication-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { ADJUDICATION_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * LIVE ENTRY of the Lead-adjudication probe (O5.5B28) — exactly one real Lead adjudication turn of the route Lead binding
 * over a fixed, Fusion-authored finding set, on a throw-away fixture, under a named adjudication-only authorization. Not
 * part of `npm test`.
 *
 *   node dist/test/live/adjudication-probe.js --authorization <id>
 *
 * A `pending` authorization is refused before anything exists; an `open` one runs ONCE, by the human, from a new, normal
 * PowerShell window (never from inside an agent session, and never through any detached or remote launcher).
 * O5.5B29-ADJUDICATION (one Claude Lead adjudication) is CONSUMED: it ran once (PASS, 2026-09-25). Each authorization writes
 * bounded evidence under its own %TEMP% namespace; its claim makes a second run refuse. Ctrl+C cancels the run; cleanup
 * still runs. Nothing here records a live result: that is a later milestone's independent review.
 */
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const authorization = option("--authorization");
const listed = Object.entries(ADJUDICATION_PROBE_PROFILES.authorizations).map(([id, entry]) => `${id} (${entry.state})`);

async function fusionContainers(): Promise<number> {
  const docker = await resolveDockerCli();
  if (docker === null) return -1;
  const outcome = await new CliDockerRunner(docker).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  return outcome.exitCode === 0 ? outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "").length : -1;
}

if (authorization === undefined || args.length !== 2) {
  process.stderr.write(`Usage: node dist/test/live/adjudication-probe.js --authorization <id>\nAdjudication-only authorizations: ${listed.join("; ") || "none"}\n`);
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const report = await runAdjudicationProbe({ env: process.env, registry: defaultRegistry(), profiles: ADJUDICATION_PROBE_PROFILES, authorization,
    compiledRoot: fileURLToPath(new URL("../../", import.meta.url)), fusionContainers, signal: controller.signal });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\nNo fixture, claim, evidence or provider process was created.\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence as Record<string, unknown>;
    const counts = e.launchCounts as Record<string, number> | undefined;
    const adjudication = e.adjudication as { contract: string; decision: { kind: string; state?: string } | null;
      verdicts: Array<{ findingId: string; severity: string; verdict: string; requiredAction: string; verdictSource: string }> | null;
      structuredOutput: Record<string, unknown> | "invalid" | null; terminal: Record<string, unknown> | "invalid" | null;
      turn: Record<string, unknown> | null } | undefined;
    const verification = e.verification as { passed: boolean; commandsRun: number; acceptance: string | null } | null | undefined;
    const readback = e.readback as Record<string, unknown> | null | undefined;
    const labels = (o: Record<string, unknown> | "invalid" | null | undefined, keys: readonly string[]) => o === null || o === undefined ? "none"
      : o === "invalid" ? "invalid" : keys.map(key => `${key}=${String(o[key])}`).join(" ");
    const lines = [
      `${String(e.milestone)} Lead-adjudication probe: ${report.outcome}`,
      `detail: ${report.detail}`,
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turns started: ${report.modelTurns}`,
      ...(counts ? [`provider processes started: ${Object.entries(counts).map(([purpose, n]) => `${purpose}=${n}`).join(" ")}`] : []),
      ...(verification ? [`candidate verification: passed=${verification.passed} commandsRun=${verification.commandsRun} acceptance=${String(verification.acceptance)}`] : []),
      ...(readback ? [`runtime readback: ${labels(readback, ["source", "runtimeVersion", "requestedModel", "effectiveModel", "apiKeySource", "permissionMode"])}`] : []),
      ...(adjudication ? [
        `adjudication: contract ${adjudication.contract}; decision ${adjudication.decision === null ? "none" : `${adjudication.decision.kind}${adjudication.decision.state ? `:${adjudication.decision.state}` : ""}`}; observedModel=${String(adjudication.turn?.observedModel ?? "none")}`,
        ...(adjudication.verdicts ?? []).map(v => `verdict ${v.findingId} (${v.severity}): ${v.verdict} / ${v.requiredAction} (${v.verdictSource})`),
        `terminal: ${labels(adjudication.terminal, ["classification", "resultSubtype", "terminalReason", "isError", "internalTurnCount", "permissionDenialCount",
          "resultTextPresent", "resultTextByteLength", "structuredParsingReached", "schemaValidationReached", "processExitCode"])}`,
        `reply envelope: ${labels(adjudication.structuredOutput, ["classification", "accepted", "policy", "bodyMatchesExpectedSchema"])}`] : []),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider model turn was started and nothing was consumed. Do NOT re-run: return this output for review first."
        : "Do NOT re-run: the authorization is consumed; another run needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
