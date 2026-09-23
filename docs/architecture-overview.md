# Architecture Overview

Fusion CLI is split into five conceptual layers.

## 1. CLI / control plane

User intent enters through the CLI/control-plane layer.

This layer is responsible for:

- input/config validation;
- repository/runtime discovery;
- dependency construction;
- run lifecycle;
- cancellation;
- user-visible status mapping.

It must not encode provider-specific workflow semantics.

## 2. Core policy and workflow

The core is provider-neutral.

Primary concepts:

```text
Task Inspector
Risk Gate
Role Routing
Workflow State Machine
Fresh Review
Lead Adjudication
```

Roles:

```text
Lead
Worker
Explorer
Reviewer
Auditor
```

Role-to-provider/model binding is external policy/configuration.

## 3. Platform services

Platform services provide deterministic mechanisms:

- process supervision;
- workspace leases;
- filesystem safety;
- deterministic verification;
- event/artifact persistence;
- metrics;
- redaction.

Models do not replace these mechanisms.

## 4. Provider adapters

Provider-specific runtime behavior lives in adapters/transports.

Current adapter work includes Claude and Muse read-only paths.

Adapters expose capability state to routing. Unknown capability state does not become implicit permission.

## 5. Evidence and verification

Fusion treats deterministic observations as authoritative.

Relevant evidence includes:

- process exit state;
- verification results;
- workspace snapshots;
- observed diff/scope;
- structured findings;
- adjudication records;
- workflow transitions.

Raw hidden reasoning and full provider transcripts are not required for normal orchestration evidence.

## High-level flow

```text
USER
  ↓
CLI / CONTROL PLANE
  ↓
TASK INSPECTOR
  ↓
RISK GATE
  ↓
CAPABILITY ROUTING
  ↓
WORKFLOW
  ├─ Lead
  ├─ Explorer
  ├─ Worker
  ├─ Reviewer
  └─ Auditor
  ↓
WORKSPACE LEASE
  ↓
DETERMINISTIC VERIFICATION
  ↓
FRESH REVIEW
  ↓
LEAD ADJUDICATION
  ↓
RESULT / HUMAN GATE
```

## Failure philosophy

Fusion prefers explicit failure classes over generic failure.

Examples:

- invalid input;
- capability unavailable;
- billing/auth blocked;
- timeout;
- cancellation;
- spawn failure;
- process failure;
- mutation violation;
- malformed structured output;
- review required;
- decision required;
- human gate required.

## Writer-mode boundary

A Git worktree provides workspace separation but not a complete security sandbox.

Real autonomous Writer mode remains blocked until the isolation prerequisites in `docs/security-model.md` and `ROADMAP.md` are satisfied.
