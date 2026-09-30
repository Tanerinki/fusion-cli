// Test-only child (§49): a SEPARATE process persists a completed candidate result to the durable store, then exits —
// so the parent proves the reused result reconstructs from persisted bytes across a real process boundary.
// Usage: node candidate-store-child.mjs <repositoryRoot> <runId> <candidateId>
import { CandidateResultStore } from "../../dist/src/app/candidate-store.js";

const [, , root, runId, candidateId] = process.argv;
const scope = { allowedPaths: ["src/x.ts"], forbiddenPaths: [] };
const store = await CandidateResultStore.open(root, runId, scope);
const changeSet = { schemaVersion: 1, operations: [{ kind: "writeText", path: "src/x.ts", expectedSha256: null, content: "CHILD_CHANGE\n" }] };
const result = { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet,
  applied: [{ kind: "create", path: "src/x.ts", beforeSha256: null, afterSha256: "0".repeat(64), bytes: 13 }] };
const ok = await store.persist(candidateId, result);
process.stdout.write(`PERSISTED:${ok}`);
process.exit(0);
