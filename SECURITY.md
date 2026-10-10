# Security Policy

Fusion CLI drives AI model CLIs against local Git repositories, runs verification in containers and writes approved
changes into a user's checkout. Security reports are very welcome.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.6.x (the latest release and `main`) | Yes |
| 0.5.x | No — upgrade to 0.6.x |
| 0.4.x | No — upgrade to 0.6.x |
| 0.3.x | No — upgrade to 0.6.x |
| 0.2.x | No — upgrade to 0.6.x |
| 0.1.x | No — upgrade to 0.6.x |
| Earlier pre-release milestones | No |

## Reporting a vulnerability

**Do not open a public issue for a vulnerability.**

- If **GitHub Private Vulnerability Reporting** is enabled for this repository, use it: the repository's **Security** tab
  → **Report a vulnerability**. This is the preferred channel.
- If it is not enabled, contact the repository owner privately through their GitHub profile and ask for a private
  channel before sharing details.

There is no dedicated security e-mail address, bug bounty or guaranteed response time; reports are handled on a
best-effort basis by the maintainer.

Please include:

- the affected version or commit (`fusion --version`, `git rev-parse HEAD`);
- the command and a minimal reproduction, using a disposable repository;
- expected and actual behavior, and the impact;
- whether it needs a malicious repository, a malicious model reply, a local attacker, or a misconfiguration.

Never include live credentials, tokens, account identifiers or full provider transcripts. Redact paths and names you do not
want to share.

## What we consider a vulnerability

Examples of in-scope issues:

- a model or repository content causing a write outside Fusion's host-controlled path (to the checkout, the delivery store
  or elsewhere);
- a delivery applied without the human's typed approval, to another checkout, twice, or with bytes other than the approved
  ones;
- a bypass of the precheck, the single-use claim or the rollback;
- escaping the verification container, reaching the network from verification commands, or host files leaking into it;
- credentials, auth state, provider transcripts or hidden reasoning persisted to evidence or printed;
- a billing/authentication lane bypass (for example an API-key source accepted as a subscription lane);
- command injection through arguments, configuration or model output;
- an apply recovered twice, a second concurrent apply of the same run, or a recovery that overwrites a file someone else
  changed;
- process cleanup killing a process Fusion did not start;
- `fusion sandbox doctor` reporting a property HARD that its canary did not prove for that identity, or a sandboxed
  process escaping its explicit grants.

Out of scope:

- behavior that requires deliberately editing Fusion's source or tests to remove a control;
- vulnerabilities in the provider CLIs, Docker or the model vendors themselves (report those to their owners);
- unattended Writer mode, which Fusion does not offer;
- the documented limitations, for example that a loopback-exempt sandbox can reach other 127.0.0.1 services (broker-only
  loopback is NOT PROVEN and reported as such), or the kill-window race on the direct spawn path.

## Security design

The model is summarized in the [README](README.md#safety-model) and specified in
[docs/security-model.md](docs/security-model.md). In short: models are untrusted proposal engines running read-only in
Fusion-owned views; Fusion validates and applies changes only to private candidates, verifies them in a confined Docker
container and packages them as immutable deliveries; nothing reaches a checkout until the human approves the exact manifest
digest, and `fusion apply` prechecks the checkout and takes a single-use claim before writing. Unattended Writer mode is not
enabled.

High-value areas for review:

- `src/platform/delivery/` and `src/app/delivery-service.ts` — delivery store, approval, precheck, claim, apply, rollback
- `src/platform/workflow/` and `src/core/change/` — private candidates and change-set validation
- `src/platform/workspace/` — provider views, fingerprints, ignored-path monitoring
- `src/platform/verification/` — the Docker backend and its acceptance
- `src/providers/` and `src/core/policy/` — launch posture, billing/auth guards, risk
- `src/platform/events/` — evidence persistence and redaction
- `src/platform/durability/`, `src/core/durability/` and `src/app/durable-run.ts` — run journal, lease, apply recovery
- `src/platform/process/` — process supervision and owned process-tree cleanup
- `src/platform/isolation/`, `src/core/isolation/` and `native/fusion-sandbox/` — the AppContainer sandbox, its
  posture and network provisioning (not yet the provider execution path)
- `src/platform/verification/hyperv/` — the Windows Hyper-V verification backend
