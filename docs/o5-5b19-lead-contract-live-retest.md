# O5.5B19 — Lead contract live retest: BLOCKED in preflight

Labels: **LIVE-OBSERVED** (the human's one attempt, validated), **MECHANICALLY ENFORCED**, **FAKE-PROCESS PROVEN**, **NOT RUN**.

Outcome in one line: the human's one attempt of the authorized Lead-only contract retest (`O5.5B19-LEAD`) stopped in **preflight**. It was `VERSION_BLOCKED` on the **inactive Reviewer**: the machine's Muse had moved to the unvalidated `1.4.0-R4161.1`, although the authorization gave the Reviewer no turn (`freshReview: 0`).
- **Nothing ran:** no claim was written, and **zero provider model turns** started.
- **No verdict:** this is neither a Lead PASS nor a Lead FAIL, and it changes no O5.5B17 or O5.5B18 conclusion.
- **Identity:** `O5.5B19-LEAD` is **retired**, and the retest continues as `O5.5B21-LEAD` after the O5.5B20 fix.

## 1. The authorization and Stage 1

- **Authorized:** one real Claude Lead-plan turn to retest the Lead contract after O5.5B16 (planning prompt) and O5.5B18 (single-fence Lead envelope).
- **`O5.5B19-LEAD`:** the O5.5B17 shape exactly: Claude Code 2.1.280, haiku/low, `--max-turns 6`, the pinned fixture, subscription lanes, and budget `{ leadPlan: 1, others 0 }`.
- **Stage 1:**
  - 7 offline tests; the live entry now also prints a `reply envelope …` line per turn;
  - full suite 701 tests, 700 passed, 1 skip (symlink creation is unavailable on this Windows account);
  - harness identity `compiledSourceSha256 ae009032…a64e`, `liveEntrySha256 5922a212…09de`.

## 2. The attempt

The human ran `node dist/test/live/route-rehearsal.js --authorization O5.5B19-LEAD` once:

```
O5.5B19 full-route rehearsal: VERSION_BLOCKED
detail: Reviewer: installed 1.4.0-R4161.1 is not a validated muse-exec release
stage: preflight; evidence kind: liveProvider; model turns started: 0
```

## 3. Evidence validation

`%TEMP%\fusion-o5-5b19-lead` holds exactly:
- `authorization.json` (the marker);
- `route.preflight-2026-09-25T12-38-18-712Z.json` (6 547 bytes, SHA-256 `65377221e5d8742208346b209be606449e72fe5a0ae0c8ed70b88d2c1c9968dc`);
- the fixture directory.

**Not there:** no claim and no turn ledger.

The preflight evidence shows:
- **Outcome:** `VERSION_BLOCKED` at stage `preflight`, 371 ms after start.
- **Budget:** `{ leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 }`, and the fixture digest equals the pin.
- **Harness identity:** equal to the Stage-1 snapshot.
- **No process at all:** no launch list, no turn records.
- **Lead and Worker preflight:** Claude 2.1.280 validated and authorized, billing clear, lane `subscriptionToken`, binding equal to the grant, eligible.
- **Reviewer preflight:** Muse `executable: available`, `installedVersion: 1.4.0-R4161.1` against validated/authorized `1.3.0-R3401.1`. Its eligibility was also `unknown` (web tools, approval escalation, personal context, extensions), because nothing is validated for 1.4.

## 4. Why it blocked

`runRouteRehearsal`'s preflight inspected and validated **every** route role (Lead, Worker, Reviewer), whatever the authorization's budget for it. The Reviewer could never have started in this run: `freshReview: 0`, and O5.5B15's gate refuses even a session for a role with no authorized turn. Its install still blocked the run.

That is a preflight defect, not a Lead result. Fixing it is O5.5B20. Validating Muse 1.4.0-R4161.1 is a separate matter: it stays unvalidated.

## 5. What was recorded (Stage 2, offline)

- **`src/providers/probe-profiles.ts`:** `O5.5B19-LEAD` → state **`retired`**, a new state for an authorization closed without any provider model turn. `src/app/route-probe.ts` refuses it as `authorizationRetired` ("retired without a model turn").
- **`src/runtime/provider-profiles.ts`:** `RoutePreflightBlockRecord` / `routePreflightBlocks()`, holding one static history record:
  - `VERSION_BLOCKED` on the Reviewer, provider Muse `muse-exec`, installed `1.4.0-R4161.1` against validated `1.3.0-R3401.1`;
  - blocked role budget `0`, `modelTurns 0`, `claimWritten false`;
  - the evidence SHA-256 and this document.

  It is neither a Lead record nor a route record: those histories are unchanged.
- **Tests:** `test/o5-5b19-preflight-block.test.ts` (3):
  - the record, with Lead and route histories and readiness unchanged;
  - the retired identity refused;
  - an offline reproduction: a fake Muse install at `1.4.0-R4161.1` blocks the Lead-only preflight with exactly the live detail, with no claim and no process. This is O5.5B20's baseline.

  The Stage-1 tests were updated for the retired state (their open-path checks run on an in-memory open copy), and the test fixture gained `installMuseVersion`.

## 6. Readiness

Unchanged:

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe) |
| fullRouteLive | blocked: 1 run, 0 passed |
| hostControlledWriterWorkflow | partial |
| liveGateAuthorization | blocked |

The live Lead contract is still unproven: O5.5B17's model turn PASS / contract FAIL stands.
