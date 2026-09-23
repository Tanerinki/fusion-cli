# Fusion CLI Roadmap

## Completed

### Foundation

- TypeScript/domain model
- Windows process supervision
- Billing/auth guards
- Claude read-only adapter
- Muse read-only adapter
- Event/artifact/metrics storage
- Runtime hardening

### O1 — Workspace + verification

- Workspace leases
- Deterministic verification
- Workspace fingerprints
- Mutation-policy enforcement

### O2 — Risk

- Task inspector
- Monotonic risk gate
- Security-sensitive path classification

### O3 — Workflow

- Capability-driven routing
- Provider-neutral workflow engine
- Bounded retries
- Lead/Worker/Explorer role flows

### O3.1 — Core hardening

- Verification-time primary protection
- Strict answered/completed semantics
- Broader risk classification
- Stronger capability routing

### O4 — Review + adjudication

- Fresh Reviewer sessions
- Structured Findings
- Lead adjudication
- Bounded corrective cycle
- Human/decision gates

### O5 — CLI + control plane

- `fusion doctor`
- `fusion review`
- `fusion audit`
- `fusion build "<task>"`
- `fusion show <run-id>`
- stable user-visible states and exit codes
- strict configuration parsing
- persisted run summaries
- explicit Writer readiness gate

## In progress

### O5.5A — Real review activation

- implement structured review/adjudication turns in the real adapters;
- prove read-only shell/web posture before routing;
- keep unknown capability state fail-closed;
- add real-provider live review gates.

### O5.5B — Real Writer isolation

The Writer gate remains closed until the isolation prerequisites below are complete.

## Before real Writer mode

The following are hard prerequisites:

- control ignored-path influence;
- protect shared Git/common-directory state;
- strengthen index/shared-state observation;
- run verification in an isolated or reconstructed environment;
- capability-prove real-provider Writer posture;
- preserve one-writer-per-workspace and primary-workspace protection.

## O6 — True end-to-end Fusion

Target flow:

```text
Task Inspector
→ Risk Gate
→ Lead
→ Worker
→ isolated workspace
→ deterministic verification
→ fresh Reviewer
→ Lead adjudication
→ bounded correction
→ final result
```

## Post-v0.1 ideas

- richer run inspection
- more provider adapters
- persistent provider sessions where safe
- repository policy profiles
- richer local metrics
- benchmark harnesses
- optional TUI/dashboard
- packaged Windows distribution
