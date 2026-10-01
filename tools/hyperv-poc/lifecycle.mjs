// Fusion v0.6 Hyper-V PoC — lifecycle verdict logic (pure, unit-tested). Keeps the "no false PASS" rule mechanical:
// process-tree containment is PASS only when the worker ACTUALLY spawned a child AND the container was gone after a
// forced kill — never merely because some other result exists.

/**
 * processTreeVerdict — PASS only with real evidence of a spawned tree that the worker lifecycle tore down.
 *   { attempted, spawned, childPid, containerGoneAfterKill }
 *   - attempted !== true                      → "NOT_RUN" (the spawn canary did not run)
 *   - spawned !== true or no positive childPid → "NOT_RUN" (no child was created → nothing proven)
 *   - containerGoneAfterKill !== true          → "FAIL" (a surviving container/VM = containment failed)
 *   - otherwise                                → "PASS"
 */
export function processTreeVerdict(ev) {
  const e = ev ?? {};
  if (e.attempted !== true) return "NOT_RUN";
  if (e.spawned !== true || !(Number.isInteger(e.childPid) && e.childPid > 0)) return "NOT_RUN";
  if (e.containerGoneAfterKill !== true) return "FAIL";
  return "PASS";
}

/** forcedKill / stale verdict: PASS only when the container is gone and no stale endpoint/process remains. */
export function cleanupLifecycleVerdict({ containerGone, endpointGone, listenersGone } = {}) {
  return (containerGone === true && endpointGone === true && listenersGone === true) ? "PASS" : "FAIL";
}

// CLI: node lifecycle.mjs process-tree <childPid> <containerGone:true|false>  → prints the verdict (for run.ps1).
if (process.argv[2] === "process-tree") {
  const childPid = Number(process.argv[3]);
  const containerGoneAfterKill = String(process.argv[4]).toLowerCase() === "true";
  process.stdout.write(processTreeVerdict({ attempted: true, spawned: Number.isInteger(childPid) && childPid > 0, childPid, containerGoneAfterKill }));
}
