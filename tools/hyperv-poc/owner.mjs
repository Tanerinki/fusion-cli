// Fusion v0.6 Hyper-V PoC — per-run OWNERSHIP STATE (pure + small CLI). Written DURABLY by provision.ps1 as each resource
// is acquired (before any subsequent mutation), so cleanup can reclaim exactly what was created even if provision throws
// before the final provision-<RunId>.json exists. Also defines the FINAL verdict rule: a live PASS requires BOTH the run
// proof AND the cleanup proof to be PASS — a cleanup failure can never be reported as a successful live result.

/** A fresh ownership record for a run. `processes` entries carry enough identity to resist PID reuse (pid + startTime). */
export function newOwnerState(runId) {
  return { schema: "fusion.hyperv.owner/1", runId, prefix: `FusionV06Poc-${runId}`, createdAt: new Date().toISOString(), network: null, image: null, processes: [] };
}

/** Records an owned native process (listener/broker). `startTime` is the process start time (ISO) for the reuse guard. */
export function addProcess(state, role, pid, startTime) {
  const s = state ?? {};
  const processes = Array.isArray(s.processes) ? s.processes.slice() : [];
  processes.push({ role: String(role), pid: Number(pid), startTime: startTime ?? null });
  return { ...s, processes };
}

/** The persisted owned PIDs (what cleanup may stop — subject to the per-process identity check). */
export function ownedPids(state) {
  return (state?.processes ?? []).map(p => Number(p.pid)).filter(n => Number.isInteger(n) && n > 0);
}

/**
 * The FINAL live verdict. PASS only when the run proof is PASS AND the cleanup proof is PASS. If the run did not PASS,
 * the run verdict dominates. If the run PASSed but cleanup did not, the cleanup verdict is surfaced (never PASS) — a
 * failed owned-resource cleanup must not be reported as a successful live result.
 */
export function pocFinalVerdict(runVerdict, cleanupVerdict) {
  const run = String(runVerdict || "EXECUTION_ERROR");
  const clean = String(cleanupVerdict || "INCOMPLETE");
  if (run !== "PASS") return run;
  return clean === "PASS" ? "PASS" : clean;
}

// CLI: `node owner.mjs pids <ownerFile>` | `node owner.mjs final <runVerdict> <cleanupVerdict>`
if (process.argv[2] === "pids" || process.argv[2] === "final") {
  if (process.argv[2] === "final") { process.stdout.write(pocFinalVerdict(process.argv[3], process.argv[4])); }
  else {
    const { readFileSync } = await import("node:fs");
    try { const st = JSON.parse(readFileSync(process.argv[3], "utf8")); process.stdout.write(ownedPids(st).join("\n")); }
    catch { /* no owner file / unreadable → no pids */ }
  }
}
