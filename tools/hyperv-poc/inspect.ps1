# Fusion v0.6 Hyper-V PoC — inspect (READ-ONLY; deletes nothing). UNTESTED maintainer-run.
# Lists stale FusionV06Poc-* resources so the maintainer can see what exists before provisioning or after a failed run.
[CmdletBinding()] param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = "FusionV06Poc-$RunId"
Write-Output "== Stale Fusion PoC resources (prefix '$prefix-', read-only) =="
Write-Output "HNS networks:"; Get-HnsNetwork | Where-Object Name -like "$prefix*" | ForEach-Object { "  $($_.Name)  $($_.Id)" }
Write-Output "HNS endpoints:"; Get-HnsEndpoint | Where-Object Name -like "$prefix*" | ForEach-Object { "  $($_.Name)  $($_.Id)" }
Write-Output "Containers/workers:"; & ctr -n fusion-poc c ls 2>$null | Select-String $prefix
Write-Output "Temp dirs:"; Get-ChildItem $env:TEMP -Directory | Where-Object Name -like "$prefix*" | ForEach-Object { "  $($_.FullName)" }
Write-Output "(Nothing above is deleted. Use cleanup.ps1 to remove ONLY this run's resources.)"
