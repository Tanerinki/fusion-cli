import { fileURLToPath } from "node:url";
import { PROBE_MILESTONE, runProposalProbe } from "../../src/app/proposal-probe.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { PROPOSAL_PROBE_PROFILES } from "../../src/providers/probe-profiles.js";
import { defaultRegistry } from "../../src/providers/registry.js";

/**
 * O5.5B9 LIVE ENTRY — exactly one authorized real-provider change-proposal turn per invocation. Run it ONLY from a new,
 * normal PowerShell window (never from inside Claude Code), from the repository root, after `npm run build`:
 *
 *   node dist/test/live/proposal-probe.js --provider claude --authorization O5.5B9
 *   node dist/test/live/proposal-probe.js --provider muse --authorization O5.5B9
 *
 * It is not part of `npm test`. It uses the production registry and composition only (no test seam), refuses inside a
 * Claude Code session, refuses a provider already attempted, and writes one bounded evidence file under
 * %TEMP%\fusion-o5-5b9-probe. It never touches this repository or any user project.
 *
 * O5.5B10: both O5.5B9 claims are CONSUMED, so this entry now refuses both providers (`alreadyAttempted`). The evidence
 * it writes carries the structure-only `structuredOutput` section. A new Claude proposal turn needs a NEW, separately
 * authorized milestone (its own authorization token and evidence directory); see docs/o5-5b10-claude-structured-output.md.
 */
const args = process.argv.slice(2);
const option = (flag: string): string | undefined => { const at = args.indexOf(flag); return at >= 0 ? args[at + 1] : undefined; };
const provider = option("--provider");
const providers = Object.keys(PROPOSAL_PROBE_PROFILES.profiles);

async function fusionContainers(): Promise<number> {
  const docker = await resolveDockerCli();
  if (docker === null) return -1;
  const outcome = await new CliDockerRunner(docker).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  return outcome.exitCode === 0 ? outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "").length : -1;
}

if (option("--authorization") !== PROBE_MILESTONE || provider === undefined || !providers.includes(provider)) {
  process.stderr.write(`Usage: node dist/test/live/proposal-probe.js --provider ${providers.join("|")} --authorization ${PROBE_MILESTONE}\n`);
  process.exitCode = 2;
} else {
  const report = await runProposalProbe(provider, { env: process.env, registry: defaultRegistry(), profiles: PROPOSAL_PROBE_PROFILES,
    compiledRoot: fileURLToPath(new URL("../../", import.meta.url)), fusionContainers });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence as Record<string, unknown>;
    const counts = e.launchCounts as Record<string, number> | undefined;
    const shape = e.structuredOutput as Readonly<{ classification?: string; accepted?: boolean }> | "invalid" | null | undefined;
    const lines = [
      `O5.5B9 ${provider} probe: ${report.outcome}`,
      `detail: ${report.detail}`,
      ...(shape !== null && typeof shape === "object" ? [`reply shape: ${String(shape.classification)} (envelope accepted: ${String(shape.accepted)})`]
        : shape === "invalid" ? ["reply shape: invalid diagnostic (not recorded)"] : []),
      `stage: ${String(e.stage)}; evidence kind: ${String(e.evidenceKind)}; model turn launched: ${report.modelTurnLaunched}`,
      ...(counts ? [`provider processes: ${Object.entries(counts).map(([purpose, n]) => `${purpose}=${n}`).join(" ")}`] : []),
      `evidence: ${report.evidencePath}`,
      e.stage === "preflight" ? "Preflight block: no provider process was started and the authorization was not consumed."
        : "Do NOT re-run this provider: a second model turn needs a new human authorization.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
