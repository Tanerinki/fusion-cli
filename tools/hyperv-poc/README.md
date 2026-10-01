# Fusion v0.6 — Hyper-V isolated-worker PoC harness (UNTESTED, maintainer-run)

> **UNTESTED UNTIL MAINTAINER REAL-OS EXECUTION.** This harness is *evidence-generation infrastructure only*. Its existence
> is **NOT** evidence that Hyper-V / HNS / VFP satisfies the v0.6 HARD boundary. Only a real run on a Windows host with
> administrator rights produces evidence, and only the computed verdict (`verify.ps1` → `evaluator.mjs`) counts. The PowerShell
> scripts here were authored without a Hyper-V host to run them on; **expect to adapt them to your host.** The provider is a
> **fake**; no real model call, credentials, or quota are involved.

This harness implements the bounded Option-C PoC from `docs/v0.6-hyperv-poc-plan.md` (and the spike
`docs/v0.6-network-isolation-spike.md`). It is completely separate from the production HARD backend; no production routing
depends on it.

## What it tests (mechanically, on your host)

Whether a Hyper-V-isolated Windows worker can satisfy **every** existing v0.6 HARD invariant:
- **Network:** the worker reaches ONLY the dedicated Fusion broker endpoint (a host/vSwitch IP:port, **not** 127.0.0.1);
  wrong port, host loopback, LAN, Internet, and a direct provider-endpoint bypass are all DENIED — proven with **real
  sockets** (timeouts are never counted as a deny; positive controls distinguish blocked vs. unreachable).
- **Filesystem:** view read-only, scratch read/write, and primary/sibling/journal/delivery/host-profile/unrelated all denied
  — proven with real opens/writes against disposable secret canaries, not mount metadata.
- **Process tree:** fake provider → child → grandchild all die on completion/cancel/timeout/forced-termination; worker
  disposed; no orphan process/VM.
- **Ephemerality:** a second run inherits no filesystem/network/mount/process state from the first.
- **Cleanup/idempotency/safety:** only `FusionV06Poc-<runId>-*` resources are ever created or removed.

## Safety (read before running)

- `preflight.ps1` changes **nothing**; it only detects Windows edition/version, admin context, Hyper-V + Containers feature
  state, virtualization support, existing HNS networks, name collisions, and base-image availability, and prints the exact
  resources the run intends to create.
- Every created resource carries the unique prefix `FusionV06Poc-<runId>` (HNS networks, endpoints, workers, VFP/firewall
  objects, temp dirs, mounts, broker listeners, logs). `cleanup.ps1`/`inspect.ps1` touch **only** names carrying that exact
  prefix — never an unrelated HNS network, Hyper-V switch, container, or firewall rule. (The match logic is unit-tested in
  `test/v06-hyperv-poc-evaluator.test.ts` via `evaluator.mjs` `isPocResource`/`selectForCleanup`.)
- The harness **never** enables Windows features, reboots, or changes boot configuration automatically. If a required feature
  is off, `preflight.ps1` STOPS and prints the exact one-time elevated command for you to run yourself.
- It **never** uses `127.0.0.1` as the intended allowed destination (that is the loopback problem I14 documented).
- Prefer native HCS/HNS mechanisms. Docker Desktop must not become an architectural trust dependency; if a runtime is used
  only as temporary PoC plumbing, that is labelled explicitly.

## Verdict is computed, never manual

`verify.ps1` invokes `evaluator.mjs` (`evaluate`), which returns **PASS** only if every positive control succeeded AND every
required negative boundary was mechanically demonstrated DENIED AND every lifecycle check PASSed. Any UNKNOWN/missing field →
**INCOMPLETE** (UNKNOWN is never promoted to PASS). Any broken boundary → **FAIL**. A human does not decide the verdict.

## Selected stack (architecture decision)

**Docker Windows engine + `--isolation=hyperv`, worker on a dedicated `internal`-driver network, broker-only egress
enforced by an endpoint-scoped VFP/HNS ACL.** The named-pipe / no-adapter alternative is explicitly **not** adopted (it
needed an Everyone ACL, the Node path did not work, and it diverges from Fusion's broker architecture). The full ACL
mechanism, the exact JSON, endpoint-scoping rationale, rollback/Ctrl+C behaviour and the A–J canary matrix are in
[`docs/v0.6-hyperv-vfp-acl-plan.md`](../../docs/v0.6-hyperv-vfp-acl-plan.md).

The worker image is `mcr.microsoft.com/windows/nanoserver` + a copied `node.exe` + the canary `fake-provider.mjs` — no
PowerShell/SDK in the worker. The broker I/J canaries reuse the **production** broker (`src/platform/network/
provider-broker.ts`); no security logic is duplicated.

## Maintainer procedure

**One command** (ELEVATED PowerShell, Docker Desktop in Windows-engine mode) does everything and always cleans up:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools\hyperv-poc\elevated-run.ps1
```

It preflights (admin + Windows engine + isolation), builds `fusion-hv-poc-img:<RunId>`, provisions the
`FusionV06Poc-<RunId>-net` network + host listeners, starts the isolated worker, discovers its HNS endpoint, applies the
broker-only ACL (`apply-acl.ps1` → HCN `HcnModifyEndpointSettings`), runs the canary before+after the ACL with **host
positive controls**, exercises broker I/J, checks process/forced-kill/stale cleanup, writes `result-<RunId>.json`, and
runs `verify.mjs` for the computed verdict. A `finally` block removes every Fusion-owned resource on success, failure, or
Ctrl+C.

The pieces it orchestrates can also be run individually: `build-worker-image.ps1`, `provision.ps1`, `run.ps1` (elevated),
`cleanup.ps1`, `inspect.ps1` (read-only). `-SkipAcl` on `run.ps1` is the pre-ACL baseline / negative self-test (the
boundary is NOT applied, so forbidden targets become reachable and the verdict MUST NOT be PASS).

Expected duration/resources: the base-image pull dominates the first run (nanoserver is ~0.5 GB).

## Interpreting the result

- **PASS** → the Hyper-V worker mechanically satisfied every boundary. Proceed ONLY through a focused production-backend
  architecture proposal (no integration before this).
- **FAIL** → a boundary was breached. **STOP. Do not weaken HARD.**
- **INCOMPLETE** → something was not proven. Not a PASS. Resolve and re-run.

No production Hyper-V backend integration happens before a clear mechanical PASS. No real provider call; no v0.6 release; no
v0.7.
