# Security Model

## Trust hierarchy

Fusion uses the following trust hierarchy:

```text
Deterministic Fusion observation
        >
Structured model claim
        >
Unstructured model prose
```

A model saying that a command passed is not proof that it passed.

## Process execution

Process execution is designed around:

- native executables;
- argument arrays;
- no arbitrary shell-string construction;
- bounded stdout/stderr handling;
- explicit cancellation and timeout;
- failure-class preservation.

## Provider capability model

Routing is capability-driven.

Unknown capability state is not treated as safe.

Read-only roles must satisfy the required read-only posture. O3.1 deliberately tightened shell/web/network checks rather than silently accepting over-capable bindings.

## Workspace protection

The user's primary workspace must not become an autonomous Writer workspace.

Writer work is designed around dedicated workspace leases.

The current lease mechanism provides workspace separation, not a complete hostile-code sandbox.

## Verification

Verification is authoritative only when Fusion itself observes the configured checks.

A successful verification step requires:

- valid explicit process configuration;
- process completion;
- exit code 0;
- mutation policy satisfied;
- required evidence recorded.

## Review

Fresh Reviewers do not receive Worker transcripts or hidden reasoning.

They receive bounded review evidence.

Reviewer output is strictly structured and bounded.

Lead adjudication is also structured and bounded.

## Real Writer gate

Real Writer mode is blocked until all of the following are addressed:

1. ignored-path influence is controlled;
2. shared Git/common-directory state is protected;
3. index/shared-state observation is sufficient;
4. verification runs in an appropriately isolated or reconstructed environment;
5. real Writer adapters prove their execution posture through capabilities.

Until then, a user-facing build command must fail closed when autonomous writing would be required.

## Secrets and evidence

Normal run evidence should not persist:

- auth tokens;
- account identifiers;
- raw environment dumps;
- arbitrary provider transcripts;
- hidden reasoning.

Redaction is a defense-in-depth measure, not permission to persist unnecessary sensitive material.

## Billing/auth boundary

Provider override variables can change the billing/authentication lane.

Fusion guards known overrides and checks provider/auth state before use.

Subscription-safe operation must not silently fall back to API-key billing.

Credential lanes are checked in two stages. Before a process starts, Fusion classifies the environment by variable names only; it never inspects credential values:

- Claude has two recognized subscription lanes:
  - the interactive login (`subscription`);
  - the `CLAUDE_CODE_OAUTH_TOKEN` produced by `claude setup-token` (`subscriptionToken`).
- Any API key, gateway token, base URL, Bedrock/Vertex/Foundry route, unrecognized provider variable, or settings API-key helper or env override refuses the whole environment. A token never coexists with such a source; Fusion refuses rather than choosing.

After spawn and before any turn is trusted, the adapter reads the lane back:

- the token lane must report an OAuth-token first-party login;
- the session must report no API-key credential source.

Anything else fails closed, so the variable name alone never completes a turn. The token value is forwarded only to the provider child and never appears in diagnostics, errors, events or artifacts.

## Git safety

Autonomous execution must not implicitly perform destructive repository operations such as:

- push / force-push;
- reset --hard;
- clean;
- automatic stash;
- merge/rebase;
- unrelated worktree pruning.

These remain explicit human-controlled operations unless a future design introduces a separately reviewed safety model.
