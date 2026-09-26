# O5.5C3 — Disposable apply rehearsal: live result (Stage 2)

Labels: **LIVE PASS (one run, disposable repository) · RECORDED · AUTHORIZATION CONSUMED.**

The human ran `O5.5C3-DISPOSABLE-APPLY` once, on 2026-09-26 (started 02:25:27Z, 30.9 s), from a normal interactive PowerShell window, using the Stage-1 build. The harness and fixture are described in `docs/o5-5c3-disposable-apply-rehearsal.md`.

```
O5.5C3 disposable apply rehearsal: PASS
detail: every pass criterion held
phases: precheck passed; apply applied; postcheck passed
production gate: plain `fusion apply` exit 11 (blocked)
provider factories reached: 0; model turns: 0
Fusion checkout unchanged: yes; disposable repository removed: yes
```

## The run

| | |
|---|---|
| Delivery | `d-0fdbffa15ca3cf3c4a15d8a6` |
| Manifest SHA-256 | `36960644dad16664103174b06e37be2118bb0331ed33ba231cf1ba9dc84546e2`, typed in full by the human |
| Bundle SHA-256 | `15fbbb775326d16a6b3f24ac1cdb7014c43bda5f86dd8cd488b7aad035e70bf0` |
| Target | A disposable repository Fusion created under `%TEMP%\fusion-o5-5c3-delivery`. Identity `58cffd073caab537…`, base `8cdef41a1c47ac0a68d6e62872399e2fe000201a`. |
| Operations | `M src/greeting.ts`, `A src/farewell.ts`, `D docs/obsolete.md`. numstat: greeting +1/−1, obsolete −3. |
| Events | prepared → approved → applyStarted → precheckStarted → precheckPassed → applied |
| Evidence | `%TEMP%\fusion-o5-5c3-delivery\rehearsal.evidence.json`, 5336 bytes, SHA-256 `551bd9a7972035a9f032aea0d7ac136482d5a8fd696d82bc57b0b64c397d1bdc`. A byte-exact copy is kept in `test/fixtures/o5-5c3-rehearsal.evidence.json`. |
| Namespace afterwards | `namespace.json`, `rehearsal.claim.json`, `rehearsal.evidence.json` only |

## Independent validation (offline, read-only)

The recorded evidence was validated twice: once from `%TEMP%` (identical digest, production validator) and once in the suite from the committed copy (`test/o5-5c3-disposable-apply-live.test.ts`). The suite applies the production `validateDeliveryRehearsalEvidence` and then 21 criteria. Each criterion is recomputed from the evidence and the pinned fixture, not taken from the evidence's own checks alone:

1. The evidence schema is valid.
2. The compiled-source fingerprint equals Stage 1 (`96138979…b2b5`, 126 files).
3. The live-entry fingerprint equals Stage 1 (`f061e846…8825`).
4. The authorization was consumed exactly once (one claim, binding the same delivery and manifest).
5. The human typed the exact manifest digest (`typedManifestSha256`, approve exit 0).
6. The durable approval binds the delivery id, manifest, bundle, repository identity and base.
7. The target is classified as disposable: created by Fusion, under the fresh namespace, the only registered target, and pinned to this fixture and change.
8. The production gate stayed closed: a plain `fusion apply` gave exit 11 (`blocked`).
9. The precheck came before mutation: `precheckPassed` precedes `applied`, and expected HEAD equals observed HEAD equals the base.
10. The declared operations are exactly M/A/D.
11. The apply succeeded (apply exit 0, no rollback).
12. The postcheck passed.
13. The final hashes match; they were recomputed from the pinned change bytes.
14. The untouched canary `CANARY.md` is unchanged; recomputed from the fixture.
15. The sensitive, ignored `.env` canary is unchanged; recomputed from the fixture.
16. No undeclared change occurred. `git status --ignored` shows exactly the declared changes plus `.env`, and numstat covers only declared paths.
17. The event sequence is complete and contiguous.
18. There was no provider or model activity: no factory reached, 0 model turns.
19. The Fusion checkout is unchanged (the before and after digests are equal).
20. Cleanup completed: the disposable repository was removed.
21. The evidence contains no file contents, canary values or provider text.

A second test tampers with the evidence in nine ways and shows that each tampering fails its named criterion or the validator. The criteria are therefore not vacuous.

## What it proves, and what it does not

**Proven once, live:** the real delivery mechanics work end to end, with the human typing the digest as the boundary, on a disposable repository:
- preparation;
- write-once store outside the target;
- inspection with a verified diff;
- durable approval bound five ways;
- the one-shot claim;
- the applier's precheck, staged and journaled apply, and postcheck;
- the lifecycle events;
- independent verification.

The production gate was demonstrably closed during the run.

**Not proven:**
- a delivery into an ordinary or real checkout through the normal `fusion apply` (`REAL_PRIMARY_APPLY_LIVE: NOT_RUN`);
- rollback live (it is covered offline by O5.5C1 and O5.5C2);
- the Windows single-file atomicity limits (unchanged from O5.5C1).

It is a single sample.

## Readiness

- `disposablePrimaryApplyLive` changes from `notEvaluated`/`none` to **`satisfied`/`recordedLiveProbe`**. It is computed from `disposableApplyLiveRecords()` in `src/app/delivery-live-records.ts`.
- `humanApprovedDelivery` stays `partial`; it now cites the live rehearsal.
- The authorization table marks `O5.5C3-DISPOSABLE-APPLY` as **consumed**.
- The following are unchanged:
  - `REAL_PRIMARY_APPLY_LIVE: NOT_RUN`;
  - `REAL_WRITER_MODE_READINESS: NO`;
  - `O5_5B_READINESS: NO`;
  - `O6_READINESS: NO`;
  - `REAL_WRITER_LIVE_GATE_AUTHORIZED: NO`.

```
DISPOSABLE_PRIMARY_APPLY_LIVE: PASS
```
