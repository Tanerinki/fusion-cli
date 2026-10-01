# Fusion v0.6 Hyper-V PoC — cleanup (maintainer-run). Removes ONLY this run's FusionV06Poc-<RunId>-* / fusion-hv-poc-*
# :<RunId> resources. Safe after a partially failed run and safe to call from a finally block. NEVER removes a resource
# whose name lacks the exact PoC prefix (the match logic mirrors evaluator.mjs isPocResource, unit-tested). The worker's
# HNS endpoint is owned by Docker and is torn down when the container is removed, so this script does NOT touch HNS
# endpoints directly (it must never Remove-HnsEndpoint an endpoint it did not create). Durable evidence JSON is KEPT.
[CmdletBinding()] param([Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId)
$ErrorActionPreference = 'SilentlyContinue'
$prefix = "FusionV06Poc-$RunId"
$img = "fusion-hv-poc-img:$RunId"
Write-Output "== Cleanup (only '$prefix*' / '$img') =="

# 1. Worker container (removing it tears down its endpoint + VFP ACL — nothing global to roll back).
$c = & docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $prefix }
if ($c) { Write-Output "  remove container $prefix"; & docker rm -f $prefix | Out-Null }

# 2. Dedicated PoC network (only ours, matched by the exact prefix).
$n = & docker network ls --format '{{.Name}}' | Where-Object { $_ -eq "$prefix-net" }
if ($n) { Write-Output "  remove network $prefix-net"; & docker network rm "$prefix-net" | Out-Null }

# 3. Worker image (tagged with this run id).
$i = & docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $img }
if ($i) { Write-Output "  remove image $img"; & docker rmi $img | Out-Null }

# 4. Host-side listener jobs (started as $prefix-* background jobs).
Get-Job | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Write-Output "  stop listener $($_.Name)"; Stop-Job $_; Remove-Job $_ }

# 5. Temp build/scratch dirs (only ours).
Get-ChildItem $env:TEMP -Directory | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Write-Output "  remove tempdir $($_.FullName)"; Remove-Item -Recurse -Force $_.FullName }

Write-Output "Cleanup complete for $prefix (durable evidence JSON kept). Run ./inspect.ps1 -RunId $RunId to confirm."
