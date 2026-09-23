# O3 policy routing and the provider-neutral workflow engine

O3 adds the orchestration state machine that connects O2 task inspection and risk, capability-driven role routing, O1 workspace leases and Fusion verification. It makes no provider call and has no CLI. It is exercised only through fake in-memory adapters (`test/o3-workflow.test.ts`) and fake adapters over the real lease, verification and EventStore stack (`test/o3-integration.test.ts`).

## Modules

| Module | Owns |
|---|---|
| `src/core/policy/routing.ts` | Role posture (`Worker` is the only writer), posture capability requirements, `resolveRole`, `PolicyRoutingFailure` |
| `src/core/workflow/types.ts` | States, transition reasons, ports (`WorkspacePort`, `VerifierPort`, `EventSink`), request/result types |
| `src/core/workflow/packets.ts` | Strict `ResultPacket`/`TurnResult` validation; structured delegate and review packets |
| `src/core/workflow/engine.ts` | `WorkflowEngine`, the bounded state machine |
| `src/platform/workflow/ports.ts` | `LeaseWorkspacePort` (O1 leases), `EngineVerifierPort` (O1 `VerificationEngine`), `EventStoreWorkflowSink` |
| `src/platform/events/*` | New closed event types `WorkflowTransition` and `RiskAssessed` |

Core modules never import platform or provider code. Provider and model identities are opaque configuration strings. A test scans `src/core/workflow` and `src/core/policy` for provider or model names, and a second test proves that swapping every identity leaves transitions and events identical.

## Routing

The configuration is an ordered list of `RoleCandidate = { binding, adapter }`. Adapters have a fixed posture per instance, so one provider can appear in several candidates. For each role the flow needs, the first candidate with that role is chosen if it passes all of the following checks:
1. its capability probe succeeds;
2. the snapshot's `provider`/`transport` equal the binding's (an equality check only, never interpreted);
3. the snapshot meets the binding's own `requires`;
4. the snapshot meets the role posture: structured output and filesystem read for every role, plus `filesystem.write` exactly `true` for the Worker and exactly `false` for read-only roles.

`unknown` never satisfies a requirement. If no candidate qualifies, `PolicyRoutingFailure` is thrown (`CapabilityUnavailable`, with per-candidate rejection reasons by index). Every role is resolved before any turn runs or any lease exists. Routing never reads or changes risk.

## Flows

The initial O2 risk level selects the flow (the "tier"). A read-only task uses a read-only Explorer, attached to the primary workspace, as its delegate. A writing task uses the Worker inside its own lease.

| Tier | Flow |
|---|---|
| low | delegate → Fusion verifier → `completed` |
| medium | Lead plan → delegate → Fusion verifier → Lead review (read-only, on the lease) → `completed` |
| high | Lead plan → optional read-only Explorer (`explore: true`) → delegate → Fusion verifier → `reviewRequired` (`pendingStage: freshReviewAndAdjudication`) |
| critical | Lead plan → `humanGateRequired` (`pendingStage: humanGate`) before any autonomous writer runs |

For high risk the engine stops at `reviewRequired` and does not simulate O4. No Reviewer or Auditor session is created, and no adjudication is claimed. Critical tasks (irreversible actions, releases, external side effects, credential material, Git internals) stop before the writer, because a leased worktree still shares remotes and refs with the repository.

Terminal states are `completed`, `failed`, `cancelled`, `decisionRequired`, `reviewRequired` and `humanGateRequired`. Every transition is checked against a fixed table, and terminal states have no successors.

## Invariants

- **Success is gated.** `conclude` is the only path to `completed`. It requires all of the following:
  - the final risk is at most the tier and at most medium;
  - a medium flow has Lead approval (status `completed`, no failures, no decisions);
  - when verification is required (every writer task, or when declared), the Fusion verifier passed for the final attempt, having run every planned command.
- **Only Fusion's verifier counts.** ResultPacket `verification` fields are claims. They are never read for decisions, and the Lead review packet labels the delegate summary "unverified claim". A verifier port that reports a pass without running every command is refused.
- **Bounded retries.** Low risk: a single attempt. With a Lead: one targeted retry, in a fresh session in the same lease, then `decisionRequired (retryExhausted)`. The retry packet carries only Fusion facts (the failing command ID, or the reported status) plus the delegate's own bounded `failures` list. Infrastructure failures (provider, timeout, malformed output, workspace, verifier-unavailable) are not retried. A delegate that is `blocked` or lists `needsLeadDecision` stops immediately with `decisionRequested`.
- **Monotonic risk.** Risk changes only through `escalateRisk`. A Fusion verification failure is high, and unexpected scope is high (critical if the path is sensitive), so a pass after a retry is `reviewRequired`, never auto-completed. A primary or read-only workspace change is critical.
- **Scope.** The packet's `allowedFiles` must lie within the inspected task paths, otherwise the request is `InvalidInput`. `forbiddenFiles` override allowed ones. After the writer's turn, Fusion-observed lease changes (tracked changes against the base commit, including commits made in the lease, plus untracked files) are checked. Out-of-scope paths escalate risk and end in `decisionRequired (unexpectedScope)`. A writer with no observed change ends in `decisionRequired (noChanges)`, whatever it claims.
- **Leases.** A writer runs only with a handle that meets all of the following:
  - the port returned it for this run's owner;
  - it lies strictly inside the port's `leaseRoot`;
  - it is neither the primary workspace nor an ancestor of it, and it is not the `primary` session ID;
  - no other running workflow in the process has claimed it, by ID or by path.
  The session must echo the role, posture, run and lease exactly. Refused handles are never reported as the run's lease. Leases are kept after the run for integration or inspection; the engine never discards writer work.
- **The primary workspace is proven unchanged** (O1 snapshot fingerprint) around every writer turn and every read-only turn on it. Read-only turns on a lease are proven unchanged too. The after-check runs even when a turn failed or was cancelled. Any change is a `SecurityViolation` and raises risk to critical. The lease is fingerprinted after the scope check and after verification. A read-only plan must leave it identical, and a mutating plan's output is scope-checked again. The lease must still match at conclusion and after the Lead review.
- **Untrusted adapter output.** Turn results and packets are structured-cloned (no getters, proxies or later mutation) and must match the exact, bounded shape. `effectiveProvider` must equal the bound provider. Anything else is `MalformedOutput`/`ProviderIdentityMismatch`, with no retry.
- **Cancellation and timeouts.** The caller's signal and the optional `timeoutMs` deadline (a referenced timer) are combined and passed to every port and adapter call. Calls are also raced, so a hung adapter cannot hold the workflow. On abort, the session is cancelled and closed within a bound. The result is `cancelled`/`Cancelled`, or `failed`/`Timeout` (retryable) for the deadline. A provider-reported `Timeout` propagates as `failed`/`timedOut`.

## Events

Each transition and each risk revision is appended, in order and before the state is committed, as `WorkflowTransition {from, to, reason, role?, attempt?}` or `RiskAssessed {level, decisive (≤ 32 signal codes), revision}` through the existing EventStore projection. These are closed vocabularies with no timestamps in the payload, no provider or model identities, no paths, no task text, no transcripts and no evidence strings. Verification evidence continues to use `ProcessObserved`/`VerificationObserved`. Identical inputs produce identical event sequences. A failed append stops the workflow as `failed`/`InternalError`, so the recorded state never runs ahead of the log.

## Limitations

- The primary-unchanged proof is a fail-closed detector, not a sandbox. A user editing the primary during an agent turn, or a primary with more than 20,000 changed entries, fails the workflow as a `SecurityViolation`. Paths hidden by ignore rules, and refs other than `HEAD`, are not observed (see O1). An in-scope `.gitignore` edit can therefore hide files from the scope check.
- The lease registry is per process. Cross-process exclusivity comes from O1's per-lease ownership records.
- Work abandoned after cancellation (an adapter that ignores its signal) keeps running under its own bounds. Its lease is kept and reported.
- The Explorer stage is explicit (`explore: true`). The Lead cannot request it dynamically.
- O4 fresh review, adjudication, the human-gate interaction, the CLI, and real provider writer isolation are not implemented. The current provider adapters remain read-only and refuse the writer posture.
