// Test-only child process (§49): a SEPARATE Fusion process that appends durable journal records and then dies
// abruptly, so the parent test proves reconstruction from persisted bytes — not an in-process method call.
// Usage: node journal-writer.mjs <journalPath> <runId> <count> [--abrupt]
import { RunJournal } from "../../dist/src/platform/durability/journal.js";

const [, , path, runId, countStr, mode] = process.argv;
const count = Number.parseInt(countStr, 10);
const journal = await RunJournal.open(path);
for (let i = 1; i <= count; i++) {
  await journal.append({ type: "step", runId, operationId: `op-${i}`, payload: { i, note: "durable" } });
}
// Emit the last durable seq so the parent knows how many were committed before the crash.
process.stdout.write(String(journal.lastSeq));
if (mode === "--abrupt") process.exit(137); // die hard, no flushing/cleanup — as a killed process would
process.exit(0);
