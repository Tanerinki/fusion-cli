import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DELIVERY_REHEARSAL_AUTHORIZATIONS, runDeliveryRehearsal } from "../../src/app/delivery-rehearsal.js";
import { interactiveTerminal, promptLine } from "../../src/cli/terminal-prompt.js";

/**
 * LIVE ENTRY of the O5.5C3 disposable apply rehearsal: ONE human-approved run of the real delivery mechanics (preparation,
 * store, `fusion inspect-delivery`, `fusion approve-delivery`, `fusion apply` with precheck, apply and postcheck) against
 * a Git repository Fusion creates under %TEMP%\fusion-o5-5c3-delivery. No provider, model or network. Not part of
 * `npm test`.
 *
 *   node dist/test/live/delivery-apply-rehearsal.js --authorization O5.5C3-DISPOSABLE-APPLY
 *
 * Run it ONCE, by the human, from a normal interactive PowerShell window: it prints the inspection and the approval summary
 * and waits for the human to TYPE the full manifest digest (nothing is fed; a non-interactive run is refused before
 * anything is created). A wrong or empty answer approves nothing, applies nothing and leaves the authorization unconsumed.
 * After an exact answer the authorization is claimed (consumed) and the delivery is applied to the disposable repository
 * only; the Fusion checkout is never a target. The bounded evidence stays in the namespace; the disposable repository is
 * removed.
 * O5.5C3-DISPOSABLE-APPLY is CONSUMED: the human ran it once (PASS, 2026-09-26; recorded in O5.5C3 Stage 2). Another run
 * needs a new human authorization.
 */
const args = process.argv.slice(2);
const at = args.indexOf("--authorization");
const authorization = at >= 0 ? args[at + 1] : undefined;
const listed = Object.entries(DELIVERY_REHEARSAL_AUTHORIZATIONS).map(([id, entry]) => `${id} (${entry.state})`);

if (authorization === undefined || args.length !== 2) {
  process.stderr.write(`Usage: node dist/test/live/delivery-apply-rehearsal.js --authorization <id>\nRehearsal authorizations: ${listed.join("; ") || "none"}\n`);
  process.exitCode = 2;
} else {
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  const compiledRoot = fileURLToPath(new URL("../../", import.meta.url));
  const report = await runDeliveryRehearsal({ authorization, env: process.env, compiledRoot, fusionCheckout: resolve(compiledRoot, ".."),
    io: { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); }, interactive: interactiveTerminal(), prompt: promptLine },
    signal: controller.signal });
  if ("refused" in report) {
    process.stderr.write(`REFUSED (${report.reason}): ${report.message}\n`);
    process.exitCode = 3;
  } else {
    const e = report.evidence;
    const lines = [
      "",
      `${e.milestone} disposable apply rehearsal: ${report.outcome}`,
      `detail: ${report.detail}`,
      `authorization: ${e.authorization.id} ${e.authorization.claim}`,
      ...(e.delivery ? [`delivery: ${e.delivery.id}; manifest sha256:${e.delivery.manifestSha256}; bundle sha256:${e.delivery.bundleSha256}`] : []),
      ...(e.target ? [`target: disposable repository created by Fusion (identity ${e.target.repositoryIdentity.slice(0, 16)}…, base ${e.target.baseCommit.slice(0, 12)})`] : []),
      `phases: precheck ${e.phases.precheck}; apply ${e.phases.apply}; postcheck ${e.phases.postcheck}`,
      `production gate: plain \`fusion apply\` exit ${String(e.productionGate.plainApplyExitCode)} (${String(e.productionGate.plainApplyResult)})`,
      `checks: ${Object.entries(e.checks).map(([name, ok]) => `${name}=${ok ? "yes" : "NO"}`).join(" ")}`,
      `provider factories reached: ${e.processes.providerFactoriesReached}; model turns: ${e.processes.modelTurns}`,
      `Fusion checkout unchanged: ${e.fusionCheckout.unchanged ? "yes" : "NO"}; disposable repository removed: ${e.cleanup.workRemoved ? "yes" : "NO"}`,
      `evidence: ${report.evidencePath}`,
      e.authorization.claim === "claimed" ? "Do NOT re-run: the authorization is consumed; return this output for review."
        : "The authorization was NOT consumed (no exact digest was typed). Return this output for review before any further run.",
    ];
    process.stdout.write(`${lines.join("\n")}\n`);
    process.exitCode = report.outcome === "PASS" ? 0 : 1;
  }
}
