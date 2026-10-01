# Fusion v0.6 Hyper-V PoC — provision (maintainer-run). Creates ONLY FusionV06Poc-<RunId>-* resources: one dedicated
# Docker/HNS worker network (the `internal` driver → an Internal vSwitch with NO external route, so LAN/Internet are
# denied structurally and the ACL's job is to additionally deny the same-subnet host ports + gateway DNS), and the
# host-side canary listeners on the dedicated worker-facing IP. Records pre-state first. Creating a Docker network does
# not require elevation; applying the endpoint ACL (run.ps1) does.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [string]$Subnet = '10.250.37.0/24',
  [string]$BrokerIp = '10.250.37.1',
  [Parameter(Mandatory = $true)][string]$Token,
  [string]$OutDir = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$prefix = "FusionV06Poc-$RunId"
$net = "$prefix-net"
$here = $PSScriptRoot

# 1. Pre-state snapshot (read-only) so cleanup can be proven to return the host to exactly this.
$pre = [ordered]@{
  generatedAt    = (Get-Date).ToUniversalTime().ToString('o')
  dockerNetworks = @(& docker network ls --format '{{.Name}}')
  hostAdapters   = @(Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $_.Name })
  pocCollisions  = @(& docker network ls --format '{{.Name}}' | Where-Object { $_ -like "$prefix*" })
}
$prePath = Join-Path $OutDir "prestate-$RunId.json"
[System.IO.File]::WriteAllText($prePath, ($pre | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "PRESTATE=$prePath"
if ($pre.pocCollisions.Count -gt 0) { throw "a FusionV06Poc-$RunId network already exists; run cleanup.ps1 -RunId $RunId first" }

# 2. Dedicated worker network (internal: no external route). Fusion-labelled so ownership is unambiguous.
Write-Output "Creating network $net ($Subnet, gateway $BrokerIp) ..."
& docker network create -d internal --subnet $Subnet --gateway $BrokerIp --label org.fusion.poc=fusion-hv-poc --label "org.fusion.poc.runid=$RunId" $net | Out-Null
if ($LASTEXITCODE -ne 0) { throw "docker network create failed ($LASTEXITCODE)" }
$netJson = & docker network inspect $net --format '{{json .}}' | ConvertFrom-Json
$hnsId = $netJson.Options.'com.docker.network.windowsshim.hnsid'
Write-Output "NETWORK_HNS_ID=$hnsId"

# 3. Host-side canary listeners + provider stand-in (token-echo) on the dedicated IP.
& (Join-Path $here 'canaries/host-listeners.ps1') -RunId $RunId -BrokerIp $BrokerIp -Token $Token | Out-Null

$provOut = [ordered]@{ net = $net; hnsNetworkId = $hnsId; brokerIp = $BrokerIp; subnet = $Subnet; brokerPort = 47610; wrongPort = 47611; hostOtherPort = 47620; providerPort = 47630 }
$provPath = Join-Path $OutDir "provision-$RunId.json"
[System.IO.File]::WriteAllText($provPath, ($provOut | ConvertTo-Json -Depth 5), (New-Object System.Text.UTF8Encoding($false)))
Write-Output "PROVISION=$provPath"
Write-Output "Provision complete. Next: ./run.ps1 -RunId $RunId (ELEVATED)"
