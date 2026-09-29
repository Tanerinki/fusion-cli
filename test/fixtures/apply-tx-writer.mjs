// Test-only child (§49/§71): a SEPARATE process that runs a durable apply and dies abruptly after the first file is
// applied, so the parent proves recovery from persisted state — not an in-process throw.
// Usage: node apply-tx-writer.mjs <targetDir> <vaultRoot> <journalPath>
import { createHash } from "node:crypto";
import { RunJournal } from "../../dist/src/platform/durability/journal.js";
import { DurableApplyTransaction } from "../../dist/src/platform/durability/apply-transaction.js";

const [, , target, vaultRoot, journalPath] = process.argv;
const sha = s => createHash("sha256").update(Buffer.from(s)).digest("hex");
const ops = [
  { path: "a.txt", beforeSha256: sha("A"), afterSha256: sha("B"), afterBytes: 1 },
  { path: "b.txt", beforeSha256: sha("C"), afterSha256: sha("D"), afterBytes: 1 },
];
const journal = await RunJournal.open(journalPath);
const tx = await DurableApplyTransaction.open({
  txId: "tx-1", runId: "r-1", target, vaultRoot, ops, journal,
  faults: { afterFileApplied(i) { if (i === 0) { process.stdout.write("crash-after-file-0"); process.exit(137); } } },
});
await tx.prepare((i) => Buffer.from(i === 0 ? "B" : "D"));
await tx.claim();
await tx.apply();          // crashes inside, after the first file
process.exit(0);           // not reached
