import { fileURLToPath } from "node:url";
import { runRouteRehearsal } from "../../src/app/route-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { ROUTE_REHEARSAL_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * LIVE ENTRY of the full-route rehearsal (O5.5B12) — one run of the production Writer route with real providers on a
 * throw-away fixture, under a named ROUTE authorization. Not part of `npm test`.
 *
 *   node dist/test/live/route-rehearsal.js --authorization <id>
 *
 * The only route authorization, O5.5B12-LIVE, is PENDING: this entry refuses it (and every other request) before any
 * fixture, claim, evidence or provider process exists. A later milestone may set it `open` only after the human has
 * explicitly approved its exact role bindings and turn budget (docs/o5-5b12-full-route-live-rehearsal.md §26–27).
 * When open, it must be run from a new, normal PowerShell window (never from inside an agent session), and it writes one
 * bounded evidence file under %TEMP%\fusion-o5-5b12-route. Ctrl+C cancels the run; cleanup still runs.
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
    const lines = [
      `${String(e.milestone)} full-route rehearsal: ${report.outcome}`,
      `detail: ${report.detail}`,
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turns started: ${report.modelTurns}`,
      ...(use ? [`role turns used: ${Object.entries(use).map(([turn, n]) => `${turn}=${n}`).join(" ")}`] : []),
      ...(counts ? [`provider processes started: ${Object.entries(counts).map(([purpose, n]) => `${purpose}=${n}`).join(" ")}`] : []),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider process was started and the authorization was not consumed."
        : "Do NOT re-run: the route authorization is consumed; another run needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
