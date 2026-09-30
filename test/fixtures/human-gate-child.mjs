// Test-only child (§49): a SEPARATE process runs to a HUMAN GATE and exits, so the parent proves the pending, hash-bound
// gate reconstructs from the durable journal across a real process boundary.
// Usage: node human-gate-child.mjs <repositoryRoot> <task>
import { RunRecorder } from "../../dist/src/app/runs.js";
import { DiagnosticRedactor } from "../../dist/src/core/policy/redaction.js";

const [, , root, task] = process.argv;
const recorder = await RunRecorder.start(root, "build", new DiagnosticRedactor(), { task });
await recorder.finish({ state: "HUMAN_GATE_REQUIRED", exitCode: 14, code: "humanGateRequired", pendingStage: "humanGate",
  message: "Not finished: this task is critical, so a human must approve before any autonomous work." });
process.stdout.write(`RUNID:${recorder.runId}`);
process.exit(0);
