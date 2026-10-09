# Fusion v0.6 Hyper-V PoC - build the synthetic worker image (maintainer-run; no admin required for the build itself).
# The worker is nanoserver + a copied node.exe ONLY (no PowerShell, no SDK, no network at build time beyond the base
# image pull). node runs the canary (fake-provider.mjs). The image is tagged fusion-hv-poc-img:<RunId> so cleanup can
# find it by prefix. Nothing from the host filesystem other than node.exe enters the image.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [string]$BaseImage = 'mcr.microsoft.com/windows/nanoserver:ltsc2025',
  [string]$NodeExe = $null)
$ErrorActionPreference = 'Stop'
# Resolve the script dir from $PSCommandPath (reliable under -File), not $PSScriptRoot, for the fake-provider.mjs copy.
$scriptDir = [System.IO.Path]::GetDirectoryName($PSCommandPath)
if ([string]::IsNullOrWhiteSpace($scriptDir) -or -not (Test-Path -LiteralPath $scriptDir)) { throw "cannot resolve script directory (PSCommandPath='$PSCommandPath')" }
Write-Output "SCRIPT_DIR=$scriptDir"
if (-not $NodeExe) { $NodeExe = (Get-Command node -ErrorAction Stop).Source }
if (-not (Test-Path $NodeExe)) { throw "node.exe not found at $NodeExe" }
$tag = "fusion-hv-poc-img:$RunId"
$ctx = Join-Path $env:TEMP "FusionV06Poc-$RunId-imgctx"
New-Item -ItemType Directory -Force -Path $ctx | Out-Null
try {
  Copy-Item -Path $NodeExe -Destination (Join-Path $ctx 'node.exe') -Force
  Copy-Item -Path (Join-Path $scriptDir 'fake-provider/fake-provider.mjs') -Destination (Join-Path $ctx 'fake-provider.mjs') -Force
  # Mapped-pipe PoC guest files (shim + canary + every module they import at runtime: the shared protocol + tuple contract).
  foreach ($g in 'guest-shim.mjs', 'pipe-canary.mjs', 'pipe-protocol.mjs', 'raw-tuple.mjs', 'fs-canary.mjs') { Copy-Item -Path (Join-Path $scriptDir $g) -Destination (Join-Path $ctx $g) -Force }
  $df = @(
    "FROM $BaseImage",
    "LABEL org.fusion.poc=fusion-hv-poc",
    "LABEL org.fusion.poc.runid=$RunId",
    "COPY node.exe C:/fusion/node.exe",
    "COPY fake-provider.mjs C:/fusion/fake-provider.mjs",
    "COPY guest-shim.mjs C:/fusion/guest-shim.mjs",
    "COPY pipe-canary.mjs C:/fusion/pipe-canary.mjs",
    "COPY pipe-protocol.mjs C:/fusion/pipe-protocol.mjs",
    "COPY raw-tuple.mjs C:/fusion/raw-tuple.mjs",
    "COPY fs-canary.mjs C:/fusion/fs-canary.mjs",
    "USER ContainerUser"
  ) -join "`n"
  [System.IO.File]::WriteAllText((Join-Path $ctx 'Dockerfile'), $df, (New-Object System.Text.UTF8Encoding($false)))
  Write-Output "Building $tag (isolation=hyperv) from $BaseImage ..."
  & docker build --isolation=hyperv -t $tag $ctx
  if ($LASTEXITCODE -ne 0) { throw "docker build failed ($LASTEXITCODE)" }
  Write-Output "IMAGE_BUILT=$tag"
} finally {
  Remove-Item -Recurse -Force $ctx -ErrorAction SilentlyContinue
}
