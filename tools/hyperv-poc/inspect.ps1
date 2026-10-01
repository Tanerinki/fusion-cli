# Fusion v0.6 Hyper-V PoC — inspect (READ-ONLY; deletes nothing). Lists any FusionV06Poc-<RunId>* / fusion-hv-poc-img
# :<RunId> resources so the maintainer can see what exists before provisioning or after a failed run.
[CmdletBinding()] param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = "FusionV06Poc-$RunId"
Write-Output "== Stale Fusion PoC resources (prefix '$prefix', read-only) =="
Write-Output "Containers:"; & docker ps -a --format '{{.Names}} {{.Status}}' | Where-Object { $_ -like "$prefix*" } | ForEach-Object { "  $_" }
Write-Output "Networks:";   & docker network ls --format '{{.Name}} {{.Driver}}' | Where-Object { $_ -like "$prefix*" } | ForEach-Object { "  $_" }
Write-Output "Images:";     & docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -like "fusion-hv-poc-img:$RunId" } | ForEach-Object { "  $_" }
Write-Output "Listener jobs:"; Get-Job | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { "  $($_.Name)  $($_.State)" }
Write-Output "Temp dirs:"; Get-ChildItem $env:TEMP -Directory | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { "  $($_.FullName)" }
Write-Output "(Nothing above is deleted. Use cleanup.ps1 to remove ONLY this run's resources.)"
