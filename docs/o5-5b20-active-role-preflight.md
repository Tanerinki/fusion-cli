# O5.5B20 — Active-role preflight (offline)

Labels: **MECHANICALLY ENFORCED** (code plus deterministic tests), **FAKE-PROCESS PROVEN** (real adapters against fake binaries), **NOT PROVEN**.

Outcome in one line: a route rehearsal now validates **only the roles its authorization lets start**.
- **Zero-budget roles:** a role with no authorized turn is never inspected; it could not even open a session (O5.5B15's gate).
- **A planning-only Lead** is held to the read-only surface its plan turn uses.
- **No review budget:** the engine does not route the fresh Reviewer and adjudicating Lead before work starts.
- **Every role with a nonzero budget stays fail-closed exactly as before:** a route that authorizes the Reviewer still blocks on the unvalidated Muse `1.4.0-R4161.1`.

## 1. The defect (O5.5B19)

The Lead-only authorization `O5.5B19-LEAD` (`{ leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 }`) stopped in preflight:
- **What blocked it:** `Reviewer: installed 1.4.0-R4161.1 is not a validated muse-exec release`. Preflight inspected every route role, whatever its budget.
- **What wasn't at fault:** the Reviewer could never have started. Upgrading or downgrading Muse is not the fix for a Lead-only run; Muse 1.4 stays unvalidated.

## 2. The second, hidden blocker (found and fixed here)

Skipping the inactive Reviewer in preflight alone would have made things worse:
- **Up-front routing:** for this MEDIUM fixture task, which needs a fresh review, `WorkflowEngine.flow` routes the fresh Reviewer and the adjudicating Lead **before any work runs** (`reviewRoles()` at `routed:bindingsResolved`).
- **Muse 1.4's capabilities are unknown:** the adapter reports its read-only controls as `unknown` for an unvalidated release, so fresh-review routing refuses it.
- **The consequence:** the rehearsal would have passed preflight, **written its one-shot claim**, and then failed with a policy failure before the Lead turn, spending the authorization on zero model turns.
- **Proven in a test:** `resolveRole("Reviewer", …)` rejects the real Muse adapter on a fake 1.4 install.

## 3. The fix

- **`src/app/route-probe.ts`:**
  - `routeRoleBudget(authorization, role)` gives the sum of a role's turn classes; `RouteTurnGate.roleBudget` uses it.
  - **Preflight skips every role whose budget is 0.** No factory, no inspection, no version, lane, pin or eligibility check. It records `{ family, active: false, authorizedTurns: 0, checked: "notRequired" }`.
  - **Active roles are checked exactly as before**, against the surface their turns need:
    - Change Author: `changeProposal`;
    - Reviewer: `review`;
    - Lead: `review` when `leadAdjudication > 0`, otherwise `readOnly`, the surface of its plan turn, so adjudication-only requirements don't block a Lead that never adjudicates.

    The preflight evidence now also shows `active`, `authorizedTurns` and the eligibility `surface`.
  - With `freshReview: 0` the rehearsal passes `deferReviewRouting: true` to the engine, and records `route.reviewRoutingDeferred`.
- **`src/core/workflow/types.ts`, `engine.ts`:** `WorkflowRequest.deferReviewRouting` (optional, validated as a boolean).
  - **When set:** the engine skips the up-front routing of the review roles. If the flow ever reaches review, the existing lazy `reviewRoles()` routes them then, fail-closed as always.
  - **Absent (the default, and every production caller):** unchanged.
- **Composition is unchanged.** Every role's adapter is still built. Constructing the Muse adapter starts no process and checks no version, and a zero-budget role cannot open a session anyway.

## 4. Why Muse 1.4 no longer blocks a Lead-only run, but still blocks any route that authorizes the Reviewer

| Run | Reviewer budget | Preflight of the Reviewer | Up-front review routing | Result with Muse 1.4.0-R4161.1 installed |
| --- | --- | --- | --- | --- |
| Lead-only (`O5.5B21-LEAD` shape) | 0 | skipped (`notRequired`) | deferred | the Lead runs; the route stops at the Worker (`TURN_REFUSED`) |
| Full route (`O5.5B13` shape) | 2 | validated | as before | `VERSION_BLOCKED`: "Reviewer: installed 1.4.0-R4161.1 is not a validated muse-exec release" |
| Any budget with `freshReview ≥ 1` | ≥ 1 | validated | as before | `VERSION_BLOCKED` (same) |

**Muse 1.4.0-R4161.1 remains unvalidated.** A route that needs a Muse Reviewer needs either a separately validated 1.4 or the validated 1.3.0-R3401.1.

## 5. Tests

`test/o5-5b20-active-role-preflight.test.ts` (8 tests, real adapter code against fake binaries):
1. **Lead-only with a fake Muse 1.4.0-R4161.1 install:**
   - preflight passes, with the Reviewer and Worker `notRequired` and the Lead on the `readOnly` surface;
   - review routing is deferred, the Lead plan runs, and the route stops at the Worker (`TURN_REFUSED`, 1 model turn);
   - no Muse process of any kind starts, and the claim is written only after preflight.
2. **The engine change was necessary:** fresh-review routing rejects the Muse adapter on a 1.4 install.
3. **An active Lead is still fully validated:**

   | Case | Result |
   | --- | --- |
   | API key present | `AUTH_BLOCKED` |
   | Missing pin | `VERSION_BLOCKED` |
   | Model mismatch | `MODEL_BLOCKED` |
   | `--max-turns` mismatch | `MODEL_BLOCKED` |
   | Claude 2.1.281 | `VERSION_BLOCKED` |

4. **A Reviewer with turns still blocks on Muse 1.4:** full budget, and `freshReview: 1` alone. No claim, no process.
5. **`changeAuthor: 0`:** a Worker-only requirement (a missing Worker pin) does not block; with `changeAuthor: 1` it does (`VERSION_BLOCKED`).
6. **`leadAdjudication: 0`:** an adapter kind without structured turns does not block a planning Lead; with `leadAdjudication: 1` it does (`POSTURE_BLOCKED`, "review ineligible").
7. **Readiness:** all histories, rows and the live gate are unchanged, and nothing is open.
8. **The fresh-review path is unchanged when the Reviewer has a budget:** every role keeps its full surface, and review routing is not deferred.

The O5.5B19 reproduction test now pins the block for a route that authorizes the Reviewer.

## 6. Readiness

Unchanged:

| Gate | State |
| --- | --- |
| providerChangeProposal | satisfied (recordedLiveProbe) |
| fullRouteLive | blocked: 1 run, 0 passed |
| hostControlledWriterWorkflow | partial |
| liveGateAuthorization | blocked |

Implementation evidence only, and no authorization is open.
