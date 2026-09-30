# Fusion v0.6 Hyper-V PoC — provision (ELEVATED). UNTESTED maintainer-run. Creates ONLY FusionV06Poc-<RunId>-* resources.
# ADAPT-TO-HOST: the exact HNS network mode + VFP ACL syntax + container runtime differ by host; this is a labelled scaffold
# encoding the INTENT (ALLOW worker->brokerIp:brokerPort ONLY; DENY all else), not a validated command sequence.
[CmdletBinding()] param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [string]$BrokerIp,                                  # dedicated worker-facing host/vSwitch IP (NOT 127.0.0.1); auto if omitted
  [string]$BaseImage = 'mcr.microsoft.com/windows/servercore:ltsc2022')  # servercore has PowerShell for the fake provider
$ErrorActionPreference = 'Stop'; $prefix = "FusionV06Poc-$RunId"
Write-Output "== Provision $prefix =="
Write-Output "Base image: $BaseImage  (reported BEFORE any pull; Docker Desktop is NOT required — native HCS/ctr preferred)"

# 1. Dedicated HNS network for the worker. Prefer L2Bridge/Overlay (VFP-policy capable); NAT cannot reconfigure port ACLs.
#    ADAPT: choose the smallest mode your host supports that carries an egress ACL; verify mechanically (see docs §1).
#    Example intent (New-HnsNetwork / HNS schema differs by build):
#      $net = New-HnsNetwork -Name "$prefix-net" -Type L2Bridge -AddressPrefix ... -Gateway ...
Write-Output "TODO(ADAPT): create HNS network '$prefix-net' (L2Bridge/Overlay) on '$BrokerIp'"

# 2. VFP/HNS egress ACL on the worker endpoint: ALLOW out -> $BrokerIp:$BrokerPort ONLY; DEFAULT-DENY everything else
#    (other host ports, host loopback, LAN, Internet, other endpoints). This is the network-LAYER boundary — NOT the
#    broker credential. ADAPT: express as HNS ACL policy on the endpoint ('$prefix-endpoint').
Write-Output "TODO(ADAPT): apply endpoint ACL: ALLOW out -> $BrokerIp:47610; default-deny all else"

# 3. Host-side broker + canary listeners (dedicated IP; wrong-port + unrelated for IP-vs-port distinction).
& (Join-Path $PSScriptRoot 'canaries/host-listeners.ps1') -RunId $RunId -BrokerIp $BrokerIp | Out-Null

# 4. Hyper-V ISOLATED worker (its own network namespace) bound to the PoC network, with:
#      - view mount (read-only), scratch mount (read/write); NO host profile; NO other host paths.
#    ADAPT: native HCS or 'ctr'/'hcsdiag'; Docker only as labelled temporary PoC plumbing.
#      Example intent: run $BaseImage, isolation=hyperv, --network "$prefix-net", mounts: view(ro), scratch(rw)
Write-Output "TODO(ADAPT): create Hyper-V ISOLATED worker '$prefix' on '$prefix-net' with view(ro)+scratch(rw) mounts only"
Write-Output "Provision scaffold complete. Next: ./run.ps1 -RunId $RunId  (then ./verify.ps1 -RunId $RunId)"
