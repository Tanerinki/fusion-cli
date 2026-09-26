# O5.5C3 — Disposable apply rehearsal (Stage 1)

Labels: **STAGE 1: IMPLEMENTED + TESTED OFFLINE, NOT RUN LIVE.** One run is authorized: `O5.5C3-DISPOSABLE-APPLY`. The human runs it once from a normal interactive PowerShell window.

The rehearsal proves the **real delivery mechanics** once, end to end, with the human boundary in place. The target is a Git repository that **Fusion itself creates** under a fresh temporary namespace.

It is **not**:
- a provider test (no provider, model or network is involved or authorized);
- a delivery into the Fusion checkout;
- a delivery into any user project.

`REAL_PRIMARY_APPLY` stays unauthorized. The production gate stays closed.

## Architecture

- Orchestrator: `src/app/delivery-rehearsal.ts`.
- Live entry: `test/live/delivery-apply-rehearsal.ts`, compiled to `dist/test/live/delivery-apply-rehearsal.js`.

Everything that matters is the production code:

| Step | Reused code |
|---|---|
| Delivery preparation and store | `prepareStoredDelivery`: the real manifest, bundle and `FilesystemDeliveryStore` (store base inside the namespace, outside the repository) |
| Inspection | `runCli(["inspect-delivery", id])`: the same view as `fusion inspect-delivery`, including the full manifest digest and the verified diff |
| Human approval | `runCli(["approve-delivery", id])`: the same summary and question; the human **types** the full digest; a durable approval only on an exact match |
| Apply | `runCli(["apply", id])`: store revalidation, approval re-derivation, the exclusive apply claim, the applier's precheck, staging, journaled apply, postcheck, rollback, and lifecycle events |

The only difference from a production `fusion apply` is that this entry registers **the one repository it created** as the disposable target (`ControlPlaneDeps.disposableDeliveryTargets`). That registration is refused unless the target lies strictly inside the system temporary directory.

The production entry point (`src/cli/main.ts`) never sets that seam, and no variable or configuration can. The CLI runs with an **empty provider registry**: every access is counted, and the count must be 0. There is no parallel apply engine: the orchestrator never constructs an applier, an approval or a delivery record itself (asserted statically).

### The fixture (Fusion-authored, pinned)

- **Baseline:**
  - `.gitignore` (ignores `.env`);
  - `CANARY.md` (the untouched canary);
  - `README.md`;
  - `docs/obsolete.md`;
  - `src/greeting.ts`.
- **Ignored sensitive canary:** `.env` (`REHEARSAL_TOKEN=…`, not a real secret), written after the commit.
- **Change:**
  - update `src/greeting.ts`;
  - create `src/farewell.ts`;
  - delete `docs/obsolete.md` (the delete path is production-supported and tested in O5.5C1 and O5.5C2).

The authorization pins the fixture (`27fc9197…8174`) and the change (`fb9377ab…882a`). Any other bytes are refused before anything is created.

The repository is built by host code with an isolated Git client: no global or system configuration, hooks off, fsmonitor off, no filter drivers, `core.autocrlf=false`.

No verification backend runs in a rehearsal. The manifest says so openly: backend `fusion-fixture`, confinement `notApplicable`, one `fixture-pin` check. The delivered bytes are the pinned fixture, never generated.

## Flow and exact one-shot behaviour

1. **Authorization.** It must be known, `open`, and pinned to this fixture and change. Otherwise the run is refused and nothing is created.
2. **Interactive terminal.** stdin and stdout must both be TTYs. Otherwise the run is refused and **nothing is created**; the namespace does not even appear.
3. **Namespace:** `%TEMP%\fusion-o5-5c3-delivery`. It must be:
   - a real directory strictly inside the temporary directory (no link or reparse point);
   - not overlapping the Fusion checkout;
   - holding only this authorization's marker, claim, evidence and work directories.

   A claim already present means the run is refused (`alreadyAttempted`).
4. The disposable repository and the prepared delivery are created in `work-<random>/` inside the namespace.
5. `fusion inspect-delivery` is shown, then `fusion approve-delivery`, which waits for the human to type the digest.
   - **Wrong, empty or cancelled answer:** `DECLINED`. Nothing is approved and nothing is applied. **The authorization is not consumed** (no claim is written). The work directory is removed, and a small `rehearsal.attempt-<time>.json` records the attempt. A later run may try again.
6. **Production-gate probe.** A plain `fusion apply` of the approved delivery (no seam) must be `blocked` (exit 11). It uses nothing: the approval stays unused.
7. **The one-shot claim.** `rehearsal.claim.json` is written with `wx`. From here the authorization is **consumed**, whatever happens next.
8. `fusion apply` runs with the disposable target registered: precheck, then apply, then postcheck.
9. **Independent verification**, which does not trust the applier's report:
   - final SHA-256 of every declared path (and absence for the delete);
   - both canaries byte-identical;
   - no undeclared path changed;
   - `git status --ignored` exactly the declared changes plus the ignored canary;
   - `git diff --numstat` counts;
   - the event log in exact order.
10. **Evidence and cleanup.** `rehearsal.evidence.json` is written (bounded, validated) and the work directory (repository, staging, store) is removed. The evidence stays.

The Fusion checkout's state (HEAD, status, full diff against HEAD, as one digest) is recorded before and after, and must be unchanged.

## Fail closed (before any mutation of declared files)

| Condition | Where it is enforced | Authorization |
|---|---|---|
| Namespace outside TEMP, overlapping the checkout, a link, foreign content | orchestrator | untouched |
| Missing, pending, consumed or retired authorization; other fixture | orchestrator | untouched |
| Non-interactive; wrong or absent digest | orchestrator / real CLI approval | not consumed |
| Target not the registered disposable repository | the real disposable-target check | — |
| Repository identity differs, HEAD drifted, dirty tree, links, ignored paths, filter drivers | the real precheck | consumed (claimed) |
| Missing or mismatched approval; corrupt manifest or bundle | the real apply (store revalidation, approval re-derivation) | consumed (claimed) |
| An environment variable or configuration trying to enable disposable mode | never read (C2 gate tests; the gate probe in step 6) | — |

## PASS criteria

Every check in the evidence must be true:
- `exactDigestTyped`
- `approvalBindsExactly` (id, manifest, bundle, repository, base)
- `authorizationClaimedOnce`
- `productionGateClosed`
- `targetIsFusionDisposable`
- `precheckPassed`
- `applyCompleted`
- `postcheckPassed`
- `finalHashesMatch`
- `canariesUnchanged`
- `noUndeclaredChange`
- `eventOrderValid`
- `noProviderReached`
- `storeOutsideTarget`
- `fusionCheckoutUnchanged`

The disposable repository must also be removed.

## Evidence (`fusion.deliveryRehearsalEvidence` v1)

The evidence records:
- authorization id and claim state;
- compiled-tree fingerprint and live-entry SHA-256;
- delivery id, manifest and bundle digests;
- store path class (`rehearsalNamespace`, outside the target);
- target classification (disposable, created by Fusion, under the fresh namespace, one registered target), repository identity, base commit and tree, fixture and change pins;
- approval bindings;
- production-gate probe;
- expected and observed HEAD;
- precheck, apply, postcheck and rollback results;
- per-file expected and final SHA-256;
- canary before and after digests;
- undeclared changes;
- Git status codes and paths, numstat counts;
- the event sequence;
- provider factories reached and model turns (0);
- Fusion checkout before and after digests;
- CLI exit codes;
- cleanup result;
- all checks.

`validateDeliveryRehearsalEvidence` enforces:
- the exact shape and at most 64 KiB;
- digests and object ids where they belong;
- repository-relative paths only;
- **no file content, fixture text or canary value**.

The tests validate evidence without the live run.

## Stage-1 tests (`test/o5-5c3-disposable-apply.test.ts`, offline)

The tests use a temporary namespace per run, a stand-in repository as "the Fusion checkout", and an injected terminal that types the digest it read from the rehearsal's own output.

1. One-shot authorization: a second run is refused.
2. No provider or turn budget.
3. Real CLI and service reuse (runtime output plus static checks).
4. The CLI's own question and the exact digest.
5. Wrong or empty digest: DECLINED, no mutation, unconsumed, then a PASS in the same namespace.
6. Non-interactive: nothing is created.
7. The target is under the fresh namespace.
8. A foreign namespace is refused.
9. The production gate stays closed (probe exit 11), and the entry point sets no seam.
10. Approval binding.
11. HEAD drift after the claim: the precheck fails, nothing is written, and the observed HEAD is recorded.
12. Final hashes and canaries; a changed ignored canary is caught by the independent check.
13. The evidence is validated, bounded and content-free, and tampered evidence is refused.
14. The Fusion checkout is never a target: a namespace inside it, or overlapping a stand-in, is refused.
15. No network (socket and fetch patched) and no provider.
16. No replay (claim present).

## Readiness

A new row, `disposablePrimaryApplyLive`, is `notEvaluated`/`none` until the human's run is recorded in Stage 2. Every listed flag is unchanged:
- `DISPOSABLE_PRIMARY_APPLY_LIVE: NOT_RUN`;
- `REAL_PRIMARY_APPLY_LIVE: NOT_RUN`;
- Writer mode, O5.5B, O6 and the live gate: all NO.
