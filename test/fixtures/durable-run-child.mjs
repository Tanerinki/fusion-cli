// Test-only child (§12/§15): a SEPARATE process that begins a durable run, records critical milestones durably, then
// dies WITHOUT ending it — so the parent proves reconstruction of what completed from persisted bytes, and that a live
// owner is fenced while a dead one is recoverable.
// Usage: node durable-run-child.mjs <repositoryRoot> <runId> [--hold-ms N]
import { DurableRun } from "../../dist/src/app/durable-run.js";

const [, , root, runId, holdFlag, holdMs] = process.argv;
const run = await DurableRun.begin(root, runId, { workflowId: "build" });
await run.milestone("routeDecided", { route: "tournament", candidates: 2 });
await run.milestone("tournamentStarted", { candidates: 2 });
await run.milestone("candidateCompleted", { candidate: "c1", revision: "a".repeat(64) });
process.stdout.write(`STARTED:${run.runId}`);
if (holdFlag === "--hold-ms") { await new Promise(r => setTimeout(r, Number.parseInt(holdMs, 10))); process.exit(0); }
process.exit(137); // die abruptly, no end() — the run is durably INTERRUPTED
