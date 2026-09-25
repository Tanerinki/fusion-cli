import { fileURLToPath } from "node:url";
import { runRouteRehearsal } from "../../src/app/route-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { ROUTE_REHEARSAL_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * LIVE ENTRY of the full-route rehearsal (O5.5B12, opened in O5.5B13) — one run of the production Writer route with real
 * providers on a throw-away fixture, under a named ROUTE authorization. Not part of `npm test`.
 *
 *   node dist/test/live/route-rehearsal.js --authorization <id>
 *
 * O5.5B12-LIVE (the plan) stays PENDING and is refused; O5.5B13-LIVE and O5.5B15-LEAD ran once and are consumed.
 * O5.5B17-LEAD is the human's explicit one-shot approval of exactly one Lead-plan turn under the O5.5B16 planning prompt
 * (every other turn class has budget 0; docs/o5-5b17-lead-live-retest.md): run it ONCE, by the human, from a new, normal
 * PowerShell window (never from inside an agent session, and never through any detached or remote launcher). Each
 * authorization writes one bounded evidence file under its own %TEMP% namespace; its claim makes a second run refuse.
 * Ctrl+C cancels the run; cleanup still runs.
 */
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const authorization = option("--authorization");
const listed = Object.entries(ROUTE_REHEARSAL_PROFILES.authorizations).map(([id, entry]) => `${id} (${entry.state})`);

async function fusionContainers(): Promise<number> {
  const docker = await resolveDockerCli();
  if (docker === null) return -1;
  const outcome = await new CliDockerRunner(docker).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  return outcome.exitCode === 0 ? outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "").length : -1;
}

if (authorization === undefined || args.length !== 2) {
  process.stderr.write(`Usage: node dist/test/live/route-rehearsal.js --authorization <id>\nRoute authorizations: ${listed.join("; ") || "none"}\n`);
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const report = await runRouteRehearsal({ env: process.env, registry: defaultRegistry(), profiles: ROUTE_REHEARSAL_PROFILES, authorization,
    compiledRoot: fileURLToPath(new URL("../../", import.meta.url)), fusionContainers, signal: controller.signal });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\nNo fixture, claim, evidence or provider process was created.\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence as Record<string, unknown>;
    const counts = e.launchCounts as Record<string, number> | undefined;
    const use = e.turnUse as Record<string, number> | undefined;
    // O5.5B15: why each model turn ended — the bounded terminal diagnostic's labels and counts only (never text).
    const turns = (e.turns as Array<{ claim: string; outcome: string; contract: string; terminal: Record<string, unknown> | "invalid" | null }> | undefined) ?? [];
    const terminal = (t: (typeof turns)[number]["terminal"]) => t === null ? "none" : t === "invalid" ? "invalid"
      : ["classification", "resultSubtype", "terminalReason", "isError", "internalTurnCount", "permissionDenialCount", "resultTextPresent",
        "resultTextByteLength", "structuredParsingReached", "schemaValidationReached", "processExitCode"].map(key => `${key}=${String(t[key])}`).join(" ");
    const lines = [
      `${String(e.milestone)} full-route rehearsal: ${report.outcome}`,
      `detail: ${report.detail}`,
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turns started: ${report.modelTurns}`,
      ...(use ? [`role turns used: ${Object.entries(use).map(([turn, n]) => `${turn}=${n}`).join(" ")}`] : []),
      ...(counts ? [`provider processes started: ${Object.entries(counts).map(([purpose, n]) => `${purpose}=${n}`).join(" ")}`] : []),
      ...turns.map(t => `turn ${t.claim}: ${t.outcome}; contract ${t.contract}; terminal ${terminal(t.terminal)}`),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider model turn was started. Do NOT re-run: return this output for review first."
        : "Do NOT re-run: the route authorization is consumed; another run needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
