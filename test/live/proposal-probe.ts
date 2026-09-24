import { fileURLToPath } from "node:url";
import { runProposalProbe } from "../../src/app/proposal-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { PROPOSAL_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * LIVE ENTRY of the authorized change-proposal probe — exactly one real-provider change-proposal turn per invocation,
 * under a named human authorization. Run it ONLY from a new, normal PowerShell window (never from inside Claude Code),
 * from the repository root, after `npm run build`:
 *
 *   node dist/test/live/proposal-probe.js --provider <provider> --authorization <id>
 *
 * It is not part of `npm test`. It uses the production registry and composition only (no test seam). The probe refuses,
 * before anything exists: an unknown or consumed authorization, a provider the authorization does not name, a Claude Code
 * session, an evidence directory that is not the authorization's own namespace, and a provider already attempted under
 * it. It writes one bounded evidence file under the authorization's namespace (%TEMP%\<evidenceDirectory>) and never
 * touches this repository or any user project.
 *
 * Both authorizations so far are CONSUMED: O5.5B9 (Claude + Muse, 2026-09-24T13:3xZ) and O5.5B11 (Claude only,
 * 2026-09-24T19:13Z, PASS). With no open authorization this entry refuses every request; a new model turn needs a new,
 * explicit human authorization added to the probe profiles by its own milestone.
 */
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const provider = option("--provider");
const authorization = option("--authorization");
const open = Object.entries(PROPOSAL_PROBE_PROFILES.authorizations).filter(([, entry]) => entry.state === "open")
  .map(([id, entry]) => `${id} (${Object.keys(entry.grants).join(", ")})`);

async function fusionContainers(): Promise<number> {
  const docker = await resolveDockerCli();
  if (docker === null) return -1;
  const outcome = await new CliDockerRunner(docker).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  return outcome.exitCode === 0 ? outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "").length : -1;
}

if (provider === undefined || authorization === undefined || args.length !== 4) {
  process.stderr.write(`Usage: node dist/test/live/proposal-probe.js --provider <provider> --authorization <id>\n` +
    `Open authorizations: ${open.join("; ") || "none"}\n`);
  process.exitCode = 2;
} else {
  const report = await runProposalProbe(provider, { env: process.env, registry: defaultRegistry(), profiles: PROPOSAL_PROBE_PROFILES,
    authorization, compiledRoot: fileURLToPath(new URL("../../", import.meta.url)), fusionContainers });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\nNo fixture, claim, evidence or provider process was created.\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence as Record<string, unknown>;
    const counts = e.launchCounts as Record<string, number> | undefined;
    const shape = e.structuredOutput as Readonly<{ classification?: string; accepted?: boolean }> | "invalid" | null | undefined;
    const guard = e.launchGuard as Readonly<{ refusals?: readonly unknown[] }> | undefined;
    const lines = [
      `${String(e.milestone)} ${provider} probe: ${report.outcome}`,
      `detail: ${report.detail}`,
      ...(shape !== null && typeof shape === "object" ? [`reply shape: ${String(shape.classification)} (envelope accepted: ${String(shape.accepted)})`]
        : shape === "invalid" ? ["reply shape: invalid diagnostic (not recorded)"] : []),
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turn launched: ${report.modelTurnLaunched}`,
      ...(counts ? [`provider processes started: ${Object.entries(counts).map(([purpose, n]) => `${purpose}=${n}`).join(" ")}`] : []),
      ...(guard?.refusals?.length ? [`provider processes refused before start: ${guard.refusals.length}`] : []),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider process was started and the authorization was not consumed."
        : "Do NOT re-run: the authorization is consumed; a second model turn needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
