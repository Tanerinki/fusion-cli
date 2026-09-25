# O5.5B31 — Review-driven correction, live: correction and re-review PASS, branch PARTIAL

Labels: **LIVE-OBSERVED** (the one authorized run, validated independently).

Outcome in one line: `O5.5B31-CORRECTION` ran the O5.5B30 probe once. The probe entered the review-driven correction branch at the post-adjudication boundary (decision `correction` for r1-F1, the O5.5B29 live labels). Then:
- the **real corrective Claude Change Author** turn passed: `RESULT_OK`, one json fence accepted, ChangeSet validated;
- Fusion **host-applied** it into a fresh private candidate and the **confined verification passed**;
- a **real fresh Muse 1.4 re-review** ran only after that verification, and its contract accepted **1 finding** (MEDIUM).

The probe's outcome is `REREVIEW_FINDINGS`. The bounded policy's next step for that finding is a cycle-2 Lead adjudication, which the probe never runs; no further correction is available. Integrity and cleanup are complete, and nothing was delivered. `O5.5B31-CORRECTION` is consumed.

| Recorded result | Value |
| --- | --- |
| `REVIEW_DRIVEN_CORRECTION_LIVE` | **PASS** |
| `REREVIEW_AFTER_CORRECTION_LIVE` | **PASS** |
| `COMPLETE_CORRECTION_BRANCH_LIVE` | **PARTIAL**: the branch stops at the cycle-2 adjudication boundary |

## 1. The run

- **Stage 1** (`o5-5b31-review-correction-live`, on `b2e2ad6` O5.5B30):
  - fingerprint `compiledSourceSha256 056a3ae7…95f8` (111 files), `liveEntrySha256 6173205b…f084`;
  - patch `34fa36af…e517`, re-verified byte-identical before any Stage-2 edit.
- **The human** ran it once (2026-09-25T22:51:06.626Z, 141 s):
  - branch `o5-5b31-review-correction-live`;
  - only `CLAUDE_CODE_OAUTH_TOKEN` among the credential-prefixed variables;
  - Claude Code `2.1.280`; Muse selector `1.4.0-R4161.1`, binary hash `B33B4930…D950`; Docker `linux`.

## 2. Independent validation (Stage 2)

**49 checks, 0 failed** (evidence SHA-256 `73edc215966f2c086c32063dfb4fe62baf217dc3cc105d03e9b2d5a92cc547d9`). No provider was called and nothing was re-run.

| # | Required fact | Evidence |
| --- | --- | --- |
| 1 | Exactly one real correction Change Author turn | turn use `{0,1,1,0}`; exactly one Worker model process, in the `authorTurn` stage; no refusal |
| 2 | The exact Claude binding | Claude Code 2.1.280, `haiku` read back as `claude-haiku-4-5-20251001`, `low`, `--max-turns 6` (each flag exactly once), read-only controls, no widening or fallback flag; subscription-token lane; `apiKeySource none`, `dontAsk`, Glob/Grep/Read |
| 3 | Envelope and ChangeSet contract | `SINGLE_FENCED_VALID_JSON`, accepted under `rawOrSingleJsonFence`, nothing outside the fence; `RESULT_OK` (4 internal turns, exit 0); ChangeSet **validated**: 2 operations on exactly the two allowed paths |
| 4 | Host application only into a private candidate | a fresh candidate (attempt 2) after the starting candidate was released; baseline hashes of the committed files → new content; primary unchanged |
| 5 | Confined verification passed | docker-linux `osSandbox`, typecheck and unit exit 0, acceptance granted |
| 6 | Re-review only after verification | the launch order: every Change Author process first; every Reviewer process only in the `rereview` stage (the turn gate admits it only after the verification passed) |
| 7 | Exactly one fresh Muse 1.4 re-review turn | one Reviewer model process plus its account-attestation host; a new session in a new candidate view of the corrected candidate |
| 8 | The exact validated Muse binding | 1.4.0-R4161.1, validated for exactly this Reviewer binding (O5.5B24; not transport-wide); pinned location and SHA-256 matched before and after; `muse-spark-1.3`, `low`, 4 steps, 0 retries, subscription lane, attested host version 1.4.0 |
| 9 | Re-review envelope and contract | `RAW_VALID_JSON` accepted under `rawOnly`; `RESULT_OK`, exit 0; contract `accepted:1 finding(s)` |
| 10 | Primary unchanged | digest `847ac730…32c1` equal before and after, **recomputed read-only now**, same HEAD, canaries unchanged |
| 11 | View and candidate integrity | baseline view and candidate view checked, unchanged, released; the corrected candidate unchanged during the re-review |
| 12 | Cleanup | both candidates released, both sessions closed, both views released, no leftover temporaries (plugin settings, Muse exec prompt and provider view are gone), containers 0 → 0 |
| 13 | No raw reply or secret | no rationale, summary, prompt, reply, content or diff field; no fence, user name, user path or key-like string; paths redacted |
| 14 | No delivery, apply, push or merge to the primary | the fixture primary only; gates closed before and after; nothing in the harness delivers |

Also verified:
- The **boundary** was recomputed offline: cycle-1 labels, the decision `correction [r1-F1]`, the retry context (attempt 2 of 2, fresh candidate) and prior findings `[r1-F1]`.
- **The correction packet digest `045d1410…4001`** equals the offline recomputation of `delegatePacket`, with 4 constraints. The packet forwards only r1-F1: no r1-F2, no r1-F3, no placeholder rationale.

## 3. The correction: what is and is not known

- **Known:**
  - the corrected `src/quote.ts` is byte-identical to Fusion's own fix (`591668f7…`);
  - the corrected `test/quote.test.ts` differs from the starting candidate's test file: 1039 vs 1018 bytes, and the diff the re-review saw is 1268 vs 1247 bytes;
  - both files passed Fusion's confined typecheck and unit run.
- **Not known:** what the test change is. No content is persisted by design. Whether the correction resolves r1-F1 is exactly what the re-review judged.

## 4. The re-review finding: bounded facts only

| Fact | Value |
| --- | --- |
| Count | 1 |
| Severity | MEDIUM |
| Confidence | HIGH |
| Finding id, category, title, file, text | **not persisted** (by design: labels and counts only) |
| Same issue as r1-F1, a new issue? | **Not determinable** from the bounded evidence |

**Routing under the production policy:**
- A cycle-2 review with findings moves to `adjudicating` (cycle 2): the Lead must adjudicate the finding. The probe records `adjudicationRequired` and stops there.
- **After cycle 2 no further correction is allowed.** The corrective attempt was attempt 2 of 2 (`delegateRetries` 1) and the review cycle limit is 2, so `reviewOutcome(…, correctionAvailable = false)`.
- A MEDIUM finding the Lead confirms (CONFIRMED or PARTIAL) is outstanding and ends at the **`decisionRequired` gate**: not a BLOCKER, so not the human gate. A rejected or unverifiable MEDIUM finding is not outstanding and the run completes.
- The real engine exercises this offline (`O5.5B12 E`: finding → adjudication → correction → re-review finding → cycle-2 adjudication → gate; `O5.5B7` I and bounded correction).

## 5. What is now live-proven

| Writer-route element | Live evidence |
| --- | --- |
| Lead plan | O5.5B21 (isolated), O5.5B25, O5.5B27 (route) |
| Initial Change Author, host application, confined verification | O5.5B27 (route) |
| Verification failure → mechanical retry with a fresh candidate | O5.5B27 (route) |
| Fresh review, cycle 1 | O5.5B27 (route, clean); O5.5B24 (isolated) |
| Lead adjudication of review findings | O5.5B29 (isolated, Fusion-authored findings) |
| Review-driven correction (corrective Change Author → application → verification) | **O5.5B31** (isolated, entered at the boundary) |
| Fresh re-review after the correction, cycle 2 | **O5.5B31** (isolated) |
| Cycle-2 Lead adjudication and its terminal gate | **never live**; exercised offline by the real engine |

**Is cycle-2 adjudication the only remaining unproven Writer transition?** Yes. It is the only transition of the route never observed live even as a piece: re-review findings → cycle-2 Lead adjudication → terminal decision (gate or clean).

Two more things were never observed as one continuous live run: real Reviewer findings → adjudication → correction → re-review. Each of those pieces ran live, but in separate probes joined at Fusion-authored boundaries.

## 6. Readiness reassessment

**Criterion for `HOST_CONTROLLED_WRITER_WORKFLOW_READINESS`** (private-candidate workflow only). All four must hold:
1. **Every provider turn kind** of the route has run live at least once under its production binding, prompt, envelope and contract, with the contract accepting the reply. That covers: Lead plan, initial Change Author, corrective Change Author, fresh review, re-review after a correction, and Lead adjudication. All six are met.
2. **Every host step** has run live: validation, application into private candidates, confined verification passing and failing, the mechanical retry, release, integrity checks. All met (O5.5B27, O5.5B29, O5.5B31).
3. **Every engine transition** is exercised by the real engine and adapter code offline, including those never seen live: a cycle-2 adjudication and its gate (O5.5B12 E), and a corrected candidate that fails verification never being reviewed (O5.5B12 D, O5.5B7 I, O5.5B30). Met.
4. **No live run** violated integrity, confinement, budget or privacy. Met.

**Decision: YES** for the private-candidate workflow. The row `hostControlledWriterWorkflow` moves `partial → satisfied` (`recordedLiveProbe`), computed from the records.

**Why a further live probe is not necessary for this criterion:**
- The cycle-2 adjudication uses the **same** adjudication turn kind that O5.5B29 proved live: the same prompt function and schema builder, the same `rawOrSingleJsonFence` envelope, the same `validateAdjudicationReport`.
- The only differences are the cycle number (not part of the prompt) and the finding data.
- The transition that follows is deterministic engine code, covered offline.
- A live cycle-2 probe would add one sample of known behaviour, not a new mechanism. Its finding could not even be replayed here, because the re-review's text is not persisted.

A stricter criterion, "one continuous live route through adjudication, correction and re-review", would still read NO. It would need a real Reviewer to raise findings on demand, and up to 7 model turns. Its value is sample count, which remains listed as a blocker.

**What YES does not mean**, and stays as it was:
- `REAL_WRITER_MODE_READINESS` **NO**: a real Writer run stays refused (`liveGateAuthorization` blocked; `REAL_WRITER_LIVE_GATE_AUTHORIZED` constant false).
- **No human-approved delivery** to a primary checkout exists (`app/delivery.ts` holds a manifest and a read-only preflight only). The workflow ends in a private candidate.
- **No OS-level provider filesystem isolation** (`primaryProtection`, `providerWorkspaceBoundary`, `sharedGitAndIgnoredPaths` partial).
- Bounded monitoring of ignored and sensitive paths; the restricted npm lane; no Windows-native verifier.
- **Single samples** on one throw-away fixture; the default production bindings (opus/high Lead, the no-config Reviewer) never ran live.
- `O5_5B_READINESS` **NO** and `O6_READINESS` **NO**: they need the Writer mode, i.e. delivery and the gate.

### Readiness, before → after

| Row / flag | Before | After |
| --- | --- | --- |
| hostControlledWriterWorkflow | partial (recordedLiveProbe) | **satisfied** (recordedLiveProbe), private candidate only; its blocker names what ran live only in pieces, the never-live cycle-2 adjudication, single samples, no delivery, the gate |
| fullRouteLive | partial | partial; the never-live-in-a-passing-route list names both isolated probes |
| hostControlledApplication (blocker text) | "exercised with fake providers only" | "its live evidence is recorded with the workflow" |
| writerPosture (prerequisite text) | through O5.5B27 | + the O5.5B29 and O5.5B31 probe results |
| every other row, Writer mode, O5.5B, O6, live gate | NO / blocked | unchanged |

## 7. Recorded

- `correctionLiveRecords()` (`runtime/provider-profiles.ts`): the O5.5B31 record. It holds the boundary; the author binding, envelope, terminal and ChangeSet labels; the application digests; verification; the Reviewer binding, envelope, contract and finding counts; `next: adjudicationRequired`. It also records `correction PASS`, `rereview PASS` and `completeBranch PARTIAL`.
- `O5.5B31-CORRECTION` is consumed.
- The writer gate computes the row from the records.
- Earlier readiness snapshots read the growing history.

## 8. Smallest next step

**No further live probe.** O5.5B31 closes the isolated live-probe series of the private Writer workflow.

The next engineering milestone is the first product building block outside it: **human-approved delivery (`fusion apply`) of a verified private candidate into the primary checkout**. It should start offline: a delivery manifest, a pre-delivery re-verification against the current primary, an explicit human approval step, an atomic application with rollback, and evidence. It must not open the live gate.
