# Fusion v0.6 Hyper-V PoC — cleanup. UNTESTED maintainer-run. Removes ONLY this run's FusionV06Poc-<RunId>-* resources.
# Safe after a partially failed run. NEVER deletes a resource whose name lacks the exact PoC prefix (the match logic is the
# same as evaluator.mjs isPocResource, unit-tested in test/v06-hyperv-poc-evaluator.test.ts).
[CmdletBinding()] param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = "FusionV06Poc-$RunId"
function Mine($name) { return ($name -eq $prefix) -or ($name -like "$prefix-*") }  # never matches unrelated names

Write-Output "== Cleanup (only '$prefix-*') =="
# 1. fake provider tree + worker (kill-on-close of the worker also tears the tree down).
& ctr -n fusion-poc t kill --signal SIGKILL $prefix 2>$null
& ctr -n fusion-poc c rm $prefix 2>$null
# 2. HNS endpoint(s) then network(s) — only ours.
Get-HnsEndpoint | Where-Object { Mine $_.Name } | ForEach-Object { Write-Output "  remove endpoint $($_.Name)"; Remove-HnsEndpoint $_ }
Get-HnsNetwork  | Where-Object { Mine $_.Name } | ForEach-Object { Write-Output "  remove network  $($_.Name)"; Remove-HnsNetwork  $_ }
# 3. host-side broker/canary listeners (started as prefixed background jobs) + VFP/firewall PoC rules if any were added.
Get-Job | Where-Object { Mine $_.Name } | ForEach-Object { Write-Output "  stop listener   $($_.Name)"; Stop-Job $_; Remove-Job $_ }
Get-NetFirewallRule -Group $prefix 2>$null | ForEach-Object { Write-Output "  remove fw rule  $($_.Name)"; Remove-NetFirewallRule -InputObject $_ }
# 4. temp dirs / mounts / logs.
Get-ChildItem $env:TEMP -Directory | Where-Object { Mine $_.Name } | ForEach-Object { Write-Output "  remove tempdir  $($_.FullName)"; Remove-Item -Recurse -Force $_.FullName }
Write-Output "Cleanup complete for $prefix. (Run ./inspect.ps1 -RunId $RunId to confirm nothing remains.)"
