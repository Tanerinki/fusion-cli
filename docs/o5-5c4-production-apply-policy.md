# O5.5C4 — Production apply policy (offline)

Labels: **IMPLEMENTED + TESTED OFFLINE** on ordinary temporary Git repositories through the normal CLI composition. **No ordinary or real checkout has received a delivery live** (`REAL_PRIMARY_APPLY_LIVE: NOT_RUN`).

`fusion apply <id>` is now the production path for a delivery that a human explicitly approved. It still fails closed on every mismatch. No provider or model participates.

## Authorization model

**The human approval is the delivery authorization.** A human reads the delivery (`fusion inspect-delivery`) and types its exact, full manifest digest at an interactive terminal (`fusion approve-delivery`). That durable approval authorizes one claimed `fusion apply` of exactly that delivery, in exactly that checkout. Nothing else authorizes a delivery, and nothing skips the approval:
- no `--force`;
- no `--yes`;
- no `--repo` (every unknown option is a usage error);
- no environment variable;
- no configuration key.

**This is not the autonomous-Writer live gate.** `REAL_WRITER_LIVE_GATE_AUTHORIZED` stays `NO`. It governs whether a provider may run as a Writer (autonomous or live Writer execution). A delivery is an already prepared, inspected and human-approved manifest of exact bytes. Applying it involves no provider, and no command prepares a delivery from a real Writer run (Writer mode is not ready).

**What O5.5C4 removed:**
- the C2 constant "no live delivery authorization", which made every real checkout `blocked`, exit 11;
- the C2/C3 disposable-target seam (`ControlPlaneDeps.disposableDeliveryTargets`).

**The C3 rehearsal is retired**, because one of its premises was "a plain `fusion apply` stays blocked". Its authorization is consumed, and its runner and live entry are gone. Its evidence format, validator, fixture and live record stay, and `test/o5-5c3-disposable-apply-live.test.ts` still revalidates the recorded run. What its offline flow tests exercised is now exercised on the normal path by `test/o5-5c4-production-apply-policy.test.ts`.

## Checkout binding

A delivery is prepared for one exact checkout:
- the store record binds the SHA-256 of the checkout's resolved root path (O5.5C2.1);
- the approval, now version 2, binds it too, next to the delivery id, the manifest and bundle digests, the repository identity and the base commit.

`fusion apply` resolves the target only from the working directory (or `--cwd`), with an isolated Git client and `realpath`. It must be the bound checkout:
- another repository has another namespace, so the id is unknown there (exit 2);
- a same-content clone at another path is refused (exit 2, "prepared in another checkout");
- an approval or record that binds another checkout is corrupt (exit 4).

No option can redirect a delivery; `--cwd` only selects where to look.

## The order

1. **Reload and revalidate** the immutable artifacts. The store checks canonical bytes and digests, record bindings, approval binding, claim binding, and event order. Corruption gives exit 4 and nothing runs.
2. **Require the exact durable approval.**
   - `prepared` gives `approvalRequired` (exit 14).
   - A spent approval is refused (exit 2).
   - The approval is re-derived (`approvalFromHumanRecord`: id, manifest, bundle, repository identity, base, checkout).
3. **Resolve the exact bound checkout** (above).
4. **Show the plan**, before anything runs: delivery id, full manifest SHA-256, target checkout and its digest, expected HEAD, operation counts, and the approval (confirmation and time, plus earlier refused prechecks). There is no second digest prompt. The digest was typed at `approve-delivery`, which exists exactly for that decision, and the claim and precheck protect the rest.
5. **Take the exclusive attempt lock**, `apply.lock`, created with `wx`. A concurrent attempt is refused (exit 8) and nothing changes.
6. **Run the fail-closed precheck** (the O5.5C1 applier, unchanged, read-only). It checks:
   - repository identity, HEAD and base tree;
   - a clean tree;
   - no filter drivers;
   - every touched path's preimage, with create targets absent and update/delete targets present;
   - every path beneath the root, with no links or reparse points on the way;
   - no ignored paths;
   - that the provider state paths are forbidden.

   Git runs with hooks, fsmonitor and global configuration off.
7. **Take the single-use mutation claim**, `apply.claim`, created with `wx` and never removed. It is taken only after a passed precheck, immediately before the first filesystem mutation, and binds the delivery, manifest, bundle and checkout (`claimAcquired`).
8. **Apply the exact approved bytes**: staging, the journaled apply, and the postcheck. On an apply or postcheck failure, a verified rollback follows.
9. **Record evidence** in the delivery's append-only event log. The attempt lock is then released.

## Approval and claim consumption

| Situation | Written? | Approval | Log | Exit |
|---|---|---|---|---|
| Not approved | no | — | unchanged | 14 |
| Approval, record or claim does not bind (tampered) | no | refused as corrupt | unchanged | 4 |
| Another checkout or repository | no | untouched | unchanged | 2 |
| Concurrent attempt (lock held) | no | untouched | unchanged | 8 |
| **Precheck refused** (HEAD drift, dirty tree, preimage drift, create collision, missing target, links, ignored path, filter driver) | **no** | **kept** | `precheckStarted → precheckFailed` (issues, observed HEAD) | 8 |
| Precheck passed, claim could not be taken | no | spent (fail closed) | `precheckPassed → failed` | 8 |
| Applied | yes | spent | `… claimAcquired → applyStarted → applied` | 0 |
| Apply or postcheck failure, rollback complete | restored | **spent** | `… → rolledBack` | 8 |
| Rollback incomplete | partly | spent | `… → rollbackFailed` (staging kept) | 1 |
| Result stands, but its event could not be appended | per result | per result | — | 10 |

- **Before mutation**, a refused precheck mutates nothing and keeps the approval. The human may fix benign drift (reset the moved HEAD, remove the stray file, restore the edited file) and run `fusion apply` again with the same approval, provided the artifacts are unchanged. Refused prechecks are counted in the plan. The log bounds retries at 64 events, after which it is full and fails closed.
- **After the claim**, the approval is spent, whatever follows. Success cannot be replayed, a successful rollback does not make it replayable, and a spent delivery cannot be approved again. A retry needs a new delivery and a new human approval.
- **Concurrency:** exactly one attempt holds the lock, and only a lock holder can take the claim. In the tests, three concurrent `fusion apply` runs produce exactly one claim, one apply and a valid log.
- **Interruption:** an attempt killed before its claim leaves `apply.lock` behind. The delivery then refuses further applies (fail closed; `inspect-delivery` shows it) and needs a new delivery. An attempt killed after its claim leaves the journal in staging, as in O5.5C1; nothing resumes it.

## Lifecycle (event format version 2)

```
prepared → approved → precheckStarted → precheckFailed → precheckStarted → …             (state stays approved)
                                      → precheckPassed → claimAcquired → applyStarted
                                                       → applied | failed | rolledBack | rollbackFailed
                    (precheckPassed | claimAcquired) → failed        (claim not taken / apply not started: spent)
```

Events carry only these fields: ids, digests, repository identity, expected and observed HEAD, touched-path count, phase label, issue labels with repository-relative paths, and rollback counts. They never carry content, secrets or provider text. `claimAcquired` is written only by the claim itself, and `prepared`/`approved` only by their store operations.

## Read-only check (`--check`): not added

A precheck-only mode would need a new applier mode or a second precheck path next to the trusted one. The policy already gives the same safety: a refused precheck writes nothing and keeps the approval. It was therefore not added.

## No provider involvement

The delivery commands never reach a provider factory (sealed-registry tests), open no socket or fetch (patched in the tests), and run no repository-controlled program. A repository with its own `core.hooksPath` hooks and a `core.fsmonitor` script applies without either running. A configured filter driver refuses the delivery before `git status`, and the filter never runs.

## Offline tests (`test/o5-5c4-production-apply-policy.test.ts`)

The tests run the normal `runCli` with only the environment (LOCALAPPDATA and XDG_STATE_HOME redirected into the temporary directory, which is how production resolves the store), the working directory and an empty provider registry. They use no store or Git injection and no rehearsal. The rollback cases (20–22) use the existing fault-injection seam.

- **1–3, 16–19, 25, 27, 29.** Update, create, delete and multi-file deliveries apply in their ordinary checkouts:
  - the plan is printed before the result;
  - final hashes are exact, both canaries are unchanged, and nothing else changes;
  - the event order and metadata are as specified;
  - the claim binds delivery, manifest and checkout, and the lock is released;
  - no `.fusion` appears in the target, no network, no provider.
- **4–8.**
  - Unapproved gives 14.
  - An approval not binding the manifest, bundle or checkout gives 4.
  - Another repository gives 2.
  - A same-content clone gives 2, also via `--cwd`.
  - `--repo`, `--target`, `--force` and `--yes` are usage errors.
  - Nothing is written, and the bound checkout then applies.
- **9–13, 24.** HEAD drift, a dirty tree, touched-file drift, a create collision, and a missing update or delete target are each refused twice with nothing written. No claim is taken, the state stays approved, and the drift is resolved before the same approval applies.
- **14, 26.**
  - A junctioned parent is refused, and nothing is written through the link.
  - A traversal id is refused.
  - Repository hooks and fsmonitor never run.
  - A filter driver refuses the delivery, and the filter never runs.
- **15, 23.** Three concurrent applies produce exactly one claim. Replay after success is refused, and so is a second approval.
- **20–23.**
  - An apply failure rolls back (restored 2, failed 0) and is not replayable.
  - A postcheck failure rolls back.
  - A failed restore is `rollbackFailed` (exit 1).
- **28.** From the Fusion checkout the id is unknown. The Fusion checkout's HEAD and status are unchanged, and the delivery is untouched.
- **30.** C1, C2, C2.1 and C3 regressions remain green. C2's apply, drift, rollback, once and gate tests follow the new policy; C3's live evidence still revalidates.
- **31.** Readiness is checked (below).

## Readiness

| Flag | Before | After |
|---|---|---|
| `PRODUCTION_APPLY_POLICY_IMPLEMENTATION` | — | **READY** (new row `productionApplyPolicyImplementation`, satisfied/mechanical) |
| `humanApprovedDelivery` | partial | partial (blocker: no ordinary or real checkout received a delivery through the normal `fusion apply` live) |
| `REAL_PRIMARY_APPLY_LIVE` | NOT_RUN | NOT_RUN |
| `REAL_WRITER_MODE_READINESS` | NO | NO |
| `REAL_WRITER_LIVE_GATE_AUTHORIZED` | NO | NO |
| `O5_5B_READINESS` | NO | **NO** |
| `O6_READINESS` | NO | NO |

**Why `O5_5B_READINESS` stays NO.** `docs/o5-5b-writer-isolation.md` defines it by the five original production blockers:
- ignored-path influence;
- shared Git state;
- state fingerprints;
- verification isolation;
- real Writer posture.

These are `REAL_WRITER_MODE_PREREQUISITES`. The rows that carry them are still open: primary protection is detection, not prevention; provider CLIs run without an OS filesystem boundary; Windows-required verification has no confined backend. Delivery does not touch those blockers.

## Next milestone (smallest)

**One explicitly human-authorized live apply rehearsal against a designated throwaway ordinary repository, using the normal production commands:**
1. `fusion inspect-delivery`;
2. `fusion approve-delivery`, where the human types the digest;
3. `fusion apply`.

It must not use the retired C3 seam, and it must not target the fusion-cli checkout.

A delivery for that repository has to be prepared first. No command prepares one from a real Writer run, so that milestone needs a bounded preparation step for Fusion-authored fixture bytes in the designated repository. It is recorded as `REAL_PRIMARY_APPLY_LIVE` evidence: the event log, final hashes, canaries, and the untouched Fusion checkout.
