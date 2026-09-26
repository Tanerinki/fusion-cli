# O3 policy routing and the provider-neutral workflow engine

O3 adds the orchestration state machine that connects O2 task inspection and risk, capability-driven role routing, O1 workspace leases and Fusion verification. It makes no provider call and has no CLI. It is exercised only through fake in-memory adapters (`test/o3-workflow.test.ts`) and fake adapters over the real lease, verification and EventStore stack (`test/o3-integration.test.ts`).

## Modules

| Module | Owns |
|---|---|
| `src/core/policy/routing.ts` | Role posture (`Worker` is the only writer), posture capability requirements, task capability surface, `resolveRole`, `PolicyRoutingFailure` |
| `src/core/policy/risk-text.ts` | The one bounded scan for text that can steer a role (O3.1) |
| `src/core/workflow/types.ts` | States, transition reasons, ports (`WorkspacePort`, `VerifierPort`, `EventSink`), request/result types |
| `src/core/workflow/packets.ts` | Strict `ResultPacket`/`TurnResult` validation; structured delegate and review packets |
| `src/core/workflow/engine.ts` | `WorkflowEngine`, the bounded state machine |
| `src/platform/workflow/ports.ts` | `ReadOnlyWorkspacePort`, `EngineVerifierPort` (O1 `VerificationEngine`, primary-workspace verification only), `EventStoreWorkflowSink` |
| `src/platform/workflow/candidates.ts` | O5.5B7: `PrivateCandidateWorkspacePort` — private candidates, host application, confined verification (replaced the O3 `LeaseWorkspacePort`) |

> **O5.5B7 update.** The Writer described below as "the Worker inside its own lease" is no longer a writable provider session. The engine now routes the Worker only as a read-only Change Author, validates its ChangeSet, has Fusion apply it into a fresh private candidate per attempt, and verifies that candidate only through the confined backend. See [o5-5b7-e2e-writer-rehearsal.md](o5-5b7-e2e-writer-rehearsal.md). The state machine, risk, routing and review semantics below are unchanged.

> **O5.5B8 update.** A Writer workflow now requires a `ProviderViewPort`: every session is bound to a Fusion-owned view (the committed baseline for the Lead plan, Explorer and Change Author; a verified candidate copy for Lead review, fresh Reviewer and adjudicating Lead; the primary's working tree for read-only flows), routing requires the `workspaceBinding` capability, each view is held to its creation fingerprint around every turn, and the primary is held to the run's first fingerprint. See [o5-5b8-provider-boundary.md](o5-5b8-provider-boundary.md).

> **O5.5B9 update.** The Change Author now receives Fusion's observed baseline SHA-256 of every file in scope (`WorkspacePort.baselineHashes`); the applier still checks each precondition itself. One authorized live change-proposal probe per provider family ran through the production composition on a single-file task (low-risk, Worker-only flow): one family passed (validated, host-applied, verified in the accepted confined backend), the other's output was refused as malformed. Production Writer mode stays closed. See [o5-5b9-real-provider-probe.md](o5-5b9-real-provider-probe.md).
| `src/platform/events/*` | New closed event types `WorkflowTransition` and `RiskAssessed` |

Core modules never import platform or provider code. Provider and model identities are opaque configuration strings. A test scans `src/core/workflow` and `src/core/policy` for provider or model names, and a second test proves that swapping every identity leaves transitions and events identical.

## Routing

The configuration is an ordered list of `RoleCandidate = { binding, adapter }`. Adapters have a fixed posture per instance, so one provider can appear in several candidates. For each role the flow needs, the first candidate with that role is chosen if it passes all of the following checks:
1. its capability probe succeeds;
2. the snapshot's `provider`/`transport` equal the binding's (an equality check only, never interpreted);
3. the snapshot meets the binding's own `requires`;
4. the snapshot meets the role posture: structured output and filesystem read for every role, plus `filesystem.write` exactly `true` for the Worker and exactly `false` for read-only roles;
5. the snapshot stays within the task's assessed capability surface (O3.1):
   - a shell, or one that cannot be proven absent, is refused unless the task requested shell; a read-only role additionally needs the adapter to report its shell sandboxed;
   - model-facing web tools must be mechanically disabled (`webToolsDisabled: true`) unless the task requested network access.

`unknown` never satisfies a requirement. If no candidate qualifies, `PolicyRoutingFailure` is thrown (`CapabilityUnavailable`, with per-candidate rejection reasons by index, including `postureUnmet` and `capabilityExceedsTask`). Every role is resolved before any turn runs or any lease exists. Routing never lowers risk. External side effects have no capability field; tasks that request them are critical and stop at the human gate before any writer.

## Flows

The risk level after inspection selects the flow (the "tier"). Before choosing it, the engine also scans every steering field of the delegation packet and checks whether the writer's task paths are files the verification plan itself runs or reads (O3.1). A read-only task uses a read-only Explorer, attached to the primary workspace, as its delegate. A writing task uses the Worker inside its own lease.

| Tier | Flow |
|---|---|
| low | delegate → Fusion verifier → `completed`; a read-only task with no verification plan ends `answered` instead |
| medium | Lead plan → delegate → Fusion verifier → Lead review (read-only, on the lease) → `completed`; read-only without a plan ends `answered` |
| high | Lead plan → optional read-only Explorer (`explore: true`) → delegate → Fusion verifier → fresh Reviewer → Lead adjudication → `completed` (or `answered`), one bounded fix cycle, or a decision/human gate (O4, `docs/o4-review.md`) |
| critical | Lead plan → `humanGateRequired` (`pendingStage: humanGate`) before any autonomous writer runs |

Since O4, high risk no longer ends at `reviewRequired`: verified work goes through a fresh structured review and Lead adjudication (see `docs/o4-review.md`). `reviewRequired` now means only that a required fresh review could not run (no eligible Reviewer or adjudicating Lead) after the flow had escalated; a flow known to need review routes those roles before any work and fails closed if they are missing. Critical tasks (irreversible actions, releases, external side effects, credential material, Git internals) stop before the writer, because a leased worktree still shares remotes and refs with the repository.

Terminal states are `completed`, `answered`, `failed`, `cancelled`, `decisionRequired`, `reviewRequired` and `humanGateRequired`. `completed` always means the required authoritative Fusion verification ran and passed for the final attempt. `answered` (reason `answeredWithoutVerification`) is a read-only task that finished with nothing to verify; it is never reported as `completed`, even after a clean fresh review. Every transition is checked against a fixed table, and terminal states have no successors.

## Invariants

- **Success is gated.** `conclude` is the only path to `completed` and `answered`. Both require:
  - the final risk is at most the tier and at most medium;
  - a medium flow has Lead approval (status `completed`, no failures, no decisions).

  `completed` additionally requires that the Fusion verifier passed for the final attempt, having run every planned command. `answered` is only possible for a read-only task that declared no verification requirement and supplied no plan. Anything else is an internal failure, never a success.
- **Steering text is risk-inspected (O3.1).** One bounded scan (`scanRiskText`) covers the task summary and every packet field a role receives: goal, constraints, acceptance criteria, architecture decisions, invariants, required tests and open questions. It runs on the caller's packet before the tier is chosen, and again on each packet Fusion builds, exactly as it will be sent: the Explorer packet, the first delegate packet (with the forwarded Lead plan and exploration summaries) and every retry packet (with forwarded failures). A packet that now implies critical risk stops at `humanGateRequired` before the turn, and before any lease for the first attempt. Oversized text is `InvalidInput`, never scanned as a prefix. The Lead's review packet is not scanned, because the reviewing Lead is read-only.
- **Only Fusion's verifier counts.** ResultPacket `verification` fields are claims. They are never read for decisions, and the Lead review packet labels the delegate summary "unverified claim". A verifier port that reports a pass without running every command is refused.
- **Bounded retries.** Low risk: a single attempt. With a Lead: one targeted retry, in a fresh session in the same lease, then `decisionRequired (retryExhausted)`. The retry packet carries only Fusion facts (the failing command ID, or the reported status) plus the delegate's own bounded `failures` list. Infrastructure failures (provider, timeout, malformed output, workspace, verifier-unavailable) are not retried. A delegate that is `blocked` or lists `needsLeadDecision` stops immediately with `decisionRequested`.
- **Monotonic risk.** Risk changes only through `escalateRisk`. A Fusion verification failure is high, and unexpected scope is high (critical if the path is sensitive), so a pass after a retry needs a fresh review and adjudication before it can complete. A primary or read-only workspace change is critical.
- **Scope.** The packet's `allowedFiles` must lie within the inspected task paths, otherwise the request is `InvalidInput`. `forbiddenFiles` override allowed ones. After the writer's turn, Fusion-observed lease changes (tracked changes against the base commit, including commits made in the lease, plus untracked files) are checked. Out-of-scope paths escalate risk and end in `decisionRequired (unexpectedScope)`. A writer with no observed change ends in `decisionRequired (noChanges)`, whatever it claims.
- **Leases.** A writer runs only with a handle that meets all of the following:
  - the port returned it for this run's owner;
  - it lies strictly inside the port's `leaseRoot`;
  - it is neither the primary workspace nor an ancestor of it, and it is not the `primary` session ID;
  - no other running workflow in the process has claimed it, by ID or by path.
  The session must echo the role, posture, run and lease exactly. Refused handles are never reported as the run's lease. Leases are kept after the run for integration or inspection; the engine never discards writer work.
- **The primary workspace is proven unchanged** (O1 snapshot fingerprint) around every writer turn, every read-only turn on it and every verification run (O3.1). Verification executes workspace content with the user's privileges, so a verifier that changes the primary fails closed. Read-only turns on a lease are proven unchanged too. The after-check runs even when the work failed or was cancelled. Any change is a `SecurityViolation` and raises risk to critical. The lease is fingerprinted after the scope check and after verification. A read-only plan must leave it identical, and a mutating plan's output is scope-checked again. The lease must still match at conclusion and after the Lead review.
- **Untrusted adapter output.** Turn results and packets are structured-cloned (no getters, proxies or later mutation) and must match the exact, bounded shape. `effectiveProvider` must equal the bound provider. Anything else is `MalformedOutput`/`ProviderIdentityMismatch`, with no retry.
- **Cancellation and timeouts.** The caller's signal and the optional `timeoutMs` deadline (a referenced timer) are combined and passed to every port and adapter call. Calls are also raced, so a hung adapter cannot hold the workflow. On abort, the session is cancelled and closed within a bound. The result is `cancelled`/`Cancelled`, or `failed`/`Timeout` (retryable) for the deadline. A provider-reported `Timeout` propagates as `failed`/`timedOut`.

## Events

Each transition and each risk revision is appended, in order and before the state is committed, as `WorkflowTransition {from, to, reason, role?, attempt?}` or `RiskAssessed {level, decisive (≤ 32 signal codes), revision}` through the existing EventStore projection. These are closed vocabularies with no timestamps in the payload, no provider or model identities, no paths, no task text, no transcripts and no evidence strings. Verification evidence continues to use `ProcessObserved`/`VerificationObserved`; review cycles, findings and adjudications use the O4 events. Identical inputs produce identical event sequences. A failed append stops the workflow as `failed`/`InternalError`, so the recorded state never runs ahead of the log.

## Real Writer mode gate

**A linked Git worktree is workspace isolation, not a security sandbox.** A lease separates working-tree files from the primary workspace. It shares the repository's object store, refs, remotes, configuration, hooks, `info/` and attributes with the primary, and nothing stops a process in it from reaching the primary's directory. The lease protects against accidental interference between workspaces, not against a hostile writer. None of the O1–O3 checks below turn it into a sandbox.

Two gaps identified in the O1–O3 review motivated the later O5.5B substrate. They remain open for a production Writer until the runtime is confined and wired to that substrate:

- **F-02: shared Git state is not confined for a real Writer.** O5.5B adds private clones and hashes index flags, config, hooks, `info/` and refs, but the production Writer route is not wired to them and no real provider is restricted to the private filesystem boundary.
- **F-03: ignored paths can influence production verification.** O5.5B can reconstruct a verification tree from a pinned baseline and explicit candidate paths and detect writes to ignored files. Production Writer verification does not yet use that path or prevent a verifier from accessing ambient absolute paths.

```text
REAL_WRITER_MODE_BLOCKED_UNTIL:
- ignored-path influence is controlled
- shared Git/common-directory state is protected
- index flags, configuration and shared refs are fingerprinted with complete proof
- verification executes in an appropriately isolated/reconstructed environment
- real adapter writer posture is capability-proven
```

Until every line holds, production Writer mode remains closed. For the v0.1 host-controlled design, the last line means proving the read-only Change Author posture and Fusion-owned application instead of granting a provider filesystem write access. Both real adapters continue to report `filesystem.write: false` and `shell.available: false`. The CLI refuses autonomous writing; since O5.5B7 the host-controlled path is the workflow engine's only Writer route, exercised end to end with deterministic fake providers only (offline rehearsal). See [host-controlled-changes.md](host-controlled-changes.md) and [o5-5b7-e2e-writer-rehearsal.md](o5-5b7-e2e-writer-rehearsal.md).

O5.5B's implemented substrate and remaining proof obligations are recorded in [o5-5b-writer-isolation.md](o5-5b-writer-isolation.md).

## Limitations

- The primary-unchanged proof is a fail-closed detector, not a sandbox. A user editing the primary during an agent turn or verification, or a primary with more than 20,000 changed entries, fails the workflow as a `SecurityViolation`. What it cannot observe is listed under F-02 and F-03 above. Since O3.1, editing `.gitignore` and other repository-control files is high risk.
- Destructive-intent detection is deterministic pattern and token matching over English text. It can over-escalate ordinary prose, and it never lowers risk.
- The lease registry is per process. Cross-process exclusivity comes from O1's per-lease ownership records.
- Work abandoned after cancellation (an adapter that ignores its signal) keeps running under its own bounds. Its lease is kept and reported.
- The Explorer stage is explicit (`explore: true`). The Lead cannot request it dynamically.
- The human-gate interaction, the CLI, and real provider writer isolation are not implemented. The current provider adapters remain read-only and refuse the writer posture; since O5.5A they can serve as fresh Reviewer and adjudicating Lead (`docs/o5-cli.md`).
