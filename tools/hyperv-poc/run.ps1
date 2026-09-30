# Fusion v0.6 Hyper-V PoC — run. UNTESTED maintainer-run. Executes the network/FS/process matrix inside the worker (twice,
# for ephemerality) and writes result-<RunId>.json. -BreakRule intentionally weakens ONE boundary (negative self-test):
# the verdict MUST then be FAIL, proving the harness catches an escape; the clean state is restored afterwards.
[CmdletBinding()] param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [ValidateSet('','wrongPortDeny','loopbackDeny','viewWriteDeny')][string]$BreakRule = '')
$ErrorActionPreference = 'Stop'; $prefix = "FusionV06Poc-$RunId"; $out = Join-Path $PSScriptRoot "result-$RunId.json"
# ADAPT: derive the provisioned broker IP/ports + the view/scratch/denied paths; build the fake-provider spec (targets =
# broker/wrongport/host-loopback/LAN/Internet/direct-provider; reads/writes = view/scratch/primary/sibling/journal/profile).
# Then EXEC ./fake-provider/fake-provider.ps1 INSIDE the worker, collect its JSON, run the process-tree + ephemerality +
# cleanup checks from the HOST, and assemble result-$RunId.json against result-schema.json.
Write-Output "TODO(ADAPT): exec fake-provider inside '$prefix'; collect network/fs/process outcomes into $out"
if ($BreakRule) { Write-Output "NEGATIVE SELF-TEST: temporarily removing boundary '$BreakRule' — verdict MUST become FAIL, then restore." }
Write-Output "After this: ./verify.ps1 -RunId $RunId"
