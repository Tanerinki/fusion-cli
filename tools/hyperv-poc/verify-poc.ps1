# Fusion v0.6 Hyper-V PoC - VERIFICATION-ISOLATION orchestrator (maintainer-run; NO admin, NO host network mutation).
# Proves that verifying untrusted writer output is itself performed inside a fresh ISOLATED Hyper-V worker (separate VM,
# --isolation=hyperv, --network none, NO host bind mount) against an EXPLICITLY TRANSFERRED candidate snapshot (baked
# into the worker image at build time; NEVER a host mount), running ONLY the approved VerificationPlan command (a
# host-pinned absolute executable + argv + cwd, never model-generated shell), with full command identity + a pre/post
# candidate fingerprint captured, and with host/network/docker surface proven unreachable. Independent host-side
# before/after Primary fingerprints prove the trusted Primary Workspace is untouched. Always self-cleans.
#
# Three scenarios run in one worker to exercise the gate end to end:
#   clean   - the approved read-only verifier (exit 0, no candidate mutation)            => VERIFICATION_ISOLATION=PASS
#   timeout - a hung verifier under a short timeout                                       => ran.timedOut=true, no exit
#   mutate  - a rogue "read-only" verifier that writes to the candidate (exit 0)          => FAIL, sourceMutationDetected
# The AUDIT verdict is the clean scenario; timeout + mutate are recorded as live gate-behaviour proofs.
# Reserved exit codes: 0=PASS 1=FAIL 2=INCOMPLETE 3=EXECUTION_ERROR (a harness error is NEVER a verified FAIL).
[CmdletBinding()] param(
  [ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId = ("vi" + [DateTime]::UtcNow.ToString('yyMMddHHmmss')),
  [switch]$CleanupOnly,
  [switch]$KeepResources)
$ErrorActionPreference = 'Stop'
$here = [System.IO.Path]::GetDirectoryName($PSCommandPath)
if ([string]::IsNullOrWhiteSpace($here) -or -not (Test-Path -LiteralPath $here)) { throw "cannot resolve script directory (PSCommandPath='$PSCommandPath')" }
$here = [System.IO.Path]::GetFullPath($here)
$OutDir = $here
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $here '..\..'))   # the Primary Workspace under protection
$primaryLeaf = Split-Path -Leaf $repoRoot
Write-Output "SCRIPT_DIR=$here"; Write-Output "REPO_ROOT(primary)=$repoRoot"
. (Join-Path $here 'native-launch.ps1')
$noBom = New-Object System.Text.UTF8Encoding($false)
$prefix = "FusionV06Poc-$RunId"
$image = "fusion-hv-poc-img:$RunId"
$worker = "$prefix-vi"
# Same proven real-writer shape as the FS boundary proof: --network none + EXACTLY ONE mapped Fusion npipe (so the
# no-mount Hyper-V container has a start-able shape) + NO bind mount. The verifier never touches the pipe.
$pipeLeaf = "$prefix-vi"
$pipePath = "\\.\pipe\$pipeLeaf"
$cred = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
$brokerProc = $null
$candidateRoot = 'C:\fusion\candidate'
$nodeExe = 'C:\fusion\node.exe'

function Write-Json($path, $obj) { [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 20), $noBom) }
function Hash-String([string]$s) { $sha = [System.Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-', '').ToLower() } finally { $sha.Dispose() } }
function Hash-FileIfExists([string]$p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { 'absent' } }

# Bounded, secret-free Primary-Workspace fingerprint (identical to the FS proof): git working-tree + HEAD/tree + key
# Git admin-file hashes. before==after proves the untrusted verification worker mutated nothing in the Primary.
function Get-PrimaryFingerprint {
  $porcelain = (& git -C $repoRoot status --porcelain=v1 2>$null) -join "`n"
  $head = (& git -C $repoRoot rev-parse HEAD 2>$null)
  $tree = (& git -C $repoRoot rev-parse 'HEAD^{tree}' 2>$null)
  $gitDir = (& git -C $repoRoot rev-parse --git-dir 2>$null); if ($gitDir -and -not [System.IO.Path]::IsPathRooted($gitDir)) { $gitDir = Join-Path $repoRoot $gitDir }
  $hooks = ''
  if ($gitDir -and (Test-Path (Join-Path $gitDir 'hooks'))) { $hooks = ((Get-ChildItem (Join-Path $gitDir 'hooks') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.sample' } | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) -join ';') }
  [ordered]@{
    porcelainHash   = Hash-String $porcelain
    headHash        = "$head"
    treeHash        = "$tree"
    gitConfigHash   = if ($gitDir) { Hash-FileIfExists (Join-Path $gitDir 'config') } else { 'nogitdir' }
    gitHeadFileHash = if ($gitDir) { Hash-FileIfExists (Join-Path $gitDir 'HEAD') } else { 'nogitdir' }
    gitHooksHash    = Hash-String $hooks
  }
}

function Invoke-ViCleanup {
  $removed = @()
  if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker }) { & docker rm -f $worker 2>$null | Out-Null; for ($k = 0; $k -lt 20; $k++) { if (-not (& docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $worker })) { break }; Start-Sleep -Milliseconds 400 }; $removed += $worker }
  try { & docker network disconnect -f none $worker 2>&1 | Out-Null } catch {}
  if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }) { & docker rmi $image 2>$null | Out-Null; $removed += $image }
  if ($brokerProc -and (Get-Process -Id $brokerProc.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $brokerProc.Id -Force -ErrorAction SilentlyContinue; $removed += "broker" }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'pipe-broker\.ps1' -and $_.CommandLine -match [regex]::Escape($RunId) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $removed += "pid$($_.ProcessId)" }
  Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.out" -or $_.Name -like "$prefix-*.err" -or $_.Name -like "$prefix-*.ready" } | ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
  return $removed
}
if ($CleanupOnly) {
  $r = Invoke-ViCleanup
  $wg = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })); $ig = (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }))
  Write-Output ("CLEANUP_ONLY runId=$RunId removed=[" + ($r -join ',') + "] workerGone=$wg imageGone=$ig")
  if ($wg -and $ig) { exit 0 } else { exit 1 }
}

# Run the approved verifier canary with a given plan; return the parsed VERIFY_PROBE_JSON (or $null).
function Invoke-VerifyScenario([string]$label, [hashtable]$plan) {
  $specB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($plan | ConvertTo-Json -Compress)))
  $raw = ""
  try { $raw = (& docker exec -e "FUSION_VERIFY_SPEC=$specB64" $worker $nodeExe C:\fusion\verify-canary.mjs 2>$null) -join "`n" } catch { Write-Output "CANARY_EXEC_NOTE[$label]: $($_.Exception.Message)" }
  $line = ($raw -split "`n") | Where-Object { $_ -like 'VERIFY_PROBE_JSON *' } | Select-Object -First 1
  if ($line) { try { return ($line.Substring('VERIFY_PROBE_JSON '.Length) | ConvertFrom-Json) } catch { return $null } }
  return $null
}

$runVerdict = 'EXECUTION_ERROR'
try {
  $osType = (& docker info --format '{{.OSType}}' 2>$null)
  if ("$osType".Trim() -ne 'windows') { throw "Docker is not in Windows-container mode (OSType=$osType). Switch: docker desktop engine use windows" }

  # 1. Build a dedicated verify image: node + the Fusion-owned verifier scripts (fixed, hashed paths) + the EXPLICITLY
  #    TRANSFERRED candidate snapshot at C:\fusion\candidate (baked in; there is NO host mount). The candidate is
  #    untrusted; the verifier scripts are Fusion-owned and cannot be replaced by the candidate.
  $nodeSrc = (Get-Command node -ErrorAction Stop).Source
  $ctx = Join-Path $env:TEMP "$prefix-imgctx"
  New-Item -ItemType Directory -Force -Path $ctx | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $ctx 'candidate') | Out-Null
  try {
    Copy-Item -Path $nodeSrc -Destination (Join-Path $ctx 'node.exe') -Force
    foreach ($g in 'verify-canary.mjs', 'approved-verify.mjs', 'mutating-verify.mjs', 'sleep-verify.mjs') { Copy-Item -Path (Join-Path $here $g) -Destination (Join-Path $ctx $g) -Force }
    Copy-Item -Path (Join-Path $here 'verify-candidate\*') -Destination (Join-Path $ctx 'candidate') -Recurse -Force
    $df = @(
      "FROM mcr.microsoft.com/windows/nanoserver:ltsc2025",
      "LABEL org.fusion.poc=fusion-hv-poc",
      "LABEL org.fusion.poc.runid=$RunId",
      "COPY node.exe C:/fusion/node.exe",
      "COPY verify-canary.mjs C:/fusion/verify-canary.mjs",
      "COPY approved-verify.mjs C:/fusion/approved-verify.mjs",
      "COPY mutating-verify.mjs C:/fusion/mutating-verify.mjs",
      "COPY sleep-verify.mjs C:/fusion/sleep-verify.mjs",
      "COPY candidate C:/fusion/candidate",
      "USER ContainerUser"
    ) -join "`n"
    [System.IO.File]::WriteAllText((Join-Path $ctx 'Dockerfile'), $df, $noBom)
    Write-Output "Building $image (isolation=hyperv) ..."
    & docker build --isolation=hyperv -t $image $ctx
    if ($LASTEXITCODE -ne 0) { throw "docker build failed ($LASTEXITCODE)" }
  } finally { Remove-Item -Recurse -Force $ctx -ErrorAction SilentlyContinue }

  # 2. Independent Primary fingerprint BEFORE the untrusted verification worker runs.
  $fpBefore = Get-PrimaryFingerprint
  Write-Output "PRIMARY_FP_BEFORE head=$($fpBefore.headHash) porcelain=$($fpBefore.porcelainHash.Substring(0,12))"

  # 2a. Minimal pipe server so the worker's npipe mount SOURCE exists (dummy; never used by the verifier).
  $readyFile = Join-Path $OutDir "$prefix-broker.ready"
  if (Test-Path $readyFile) { Remove-Item -Force $readyFile }
  $brokerArgList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'pipe-broker.ps1'),
    '-RunId', $RunId, '-PipeName', $pipeLeaf, '-Credential', $cred, '-AllowedHost', '127.0.0.1', '-AllowedPort', '59999', '-DaclMode', 'broad', '-ReadyFile', $readyFile)
  $brokerProc = Start-Process -FilePath 'powershell' -ArgumentList (Get-NativeArgString $brokerArgList) -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $OutDir "$prefix-broker.err") -RedirectStandardOutput (Join-Path $OutDir "$prefix-broker.out")
  for ($i = 0; $i -lt 40 -and -not (Test-Path $readyFile); $i++) { if ($brokerProc.HasExited) { throw "pipe server exited early (exit=$($brokerProc.ExitCode))" }; Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path $readyFile)) { throw "pipe server did not come up (no mount source for the worker)" }

  # 3. Start the worker: --isolation=hyperv, --network none, EXACTLY ONE npipe, NO bind mount.
  $argJson = & node (Join-Path $here 'pipe-run-args.mjs') $worker $image $pipePath $nodeExe '-e' 'setInterval(()=>{},1000000000)'
  if ($LASTEXITCODE -ne 0) { throw "verify worker argv refused: $argJson" }
  $runArgs = $argJson | ConvertFrom-Json
  & docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "worker failed to start ($LASTEXITCODE)" }

  # 3a. Capture the REAL mount shape (authoritative host measurement: NO host bind mount; only the npipe).
  $inspect = & docker inspect $worker --format '{{json .}}' | ConvertFrom-Json
  $mounts = @($inspect.Mounts | ForEach-Object { [ordered]@{ Type = "$($_.Type)"; Source = "$($_.Source)"; Destination = "$($_.Destination)" } })
  $bindMounts = @($mounts | Where-Object { $_.Type -eq 'bind' }).Count
  Write-Output ("DOCKER_STATE mounts=$($mounts.Count) bindMounts=$bindMounts")

  # 3b. Wait for the Hyper-V guest to be exec-ready (bounded) before any exec.
  for ($i = 0; $i -lt 30; $i++) { & docker exec $worker $nodeExe -e "0" 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Milliseconds 1000 }

  # 4. The approved VerificationPlan (host-owned): a PINNED absolute executable + argv + cwd. The clean scenario is the
  #    audit proof; timeout + mutate run afterwards (neither tampers the candidate before the next, except mutate which
  #    runs LAST). primaryHostPath lets the canary prove the host Primary is unreachable from inside the worker.
  $planClean = @{ executable = $nodeExe; argv = @('C:\fusion\approved-verify.mjs'); cwd = $candidateRoot; timeoutMs = 60000; candidateRoot = $candidateRoot; primaryHostPath = $repoRoot; mutationExpected = $false }
  $planTimeout = @{ executable = $nodeExe; argv = @('C:\fusion\sleep-verify.mjs'); cwd = $candidateRoot; timeoutMs = 4000; candidateRoot = $candidateRoot; primaryHostPath = $repoRoot; mutationExpected = $false }
  $planMutate = @{ executable = $nodeExe; argv = @('C:\fusion\mutating-verify.mjs'); cwd = $candidateRoot; timeoutMs = 60000; candidateRoot = $candidateRoot; primaryHostPath = $repoRoot; mutationExpected = $false }

  $probeClean = Invoke-VerifyScenario 'clean' $planClean
  Write-Output ("SCENARIO clean: exit=" + $probeClean.ran.exitCode + " mutated=" + $probeClean.sourceMutated + " loopbackOnly=" + $probeClean.network.loopbackOnly + " primaryReadable=" + $probeClean.forbidden.primaryReadable)
  $probeTimeout = Invoke-VerifyScenario 'timeout' $planTimeout
  Write-Output ("SCENARIO timeout: timedOut=" + $probeTimeout.ran.timedOut + " exit=" + $probeTimeout.ran.exitCode)
  $probeMutate = Invoke-VerifyScenario 'mutate' $planMutate
  Write-Output ("SCENARIO mutate: exit=" + $probeMutate.ran.exitCode + " mutated=" + $probeMutate.sourceMutated)

  # 5. Kill the worker (ephemeral --rm; the VM + its whole disposable FS, including the tampered candidate, are destroyed).
  & docker kill $worker 2>$null | Out-Null
  $gone = $false; for ($i = 0; $i -lt 20 -and -not $gone; $i++) { if (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })) { $gone = $true } else { Start-Sleep -Milliseconds 300 } }

  # 6. Independent Primary fingerprint AFTER.
  $fpAfter = Get-PrimaryFingerprint
  Write-Output "PRIMARY_FP_AFTER head=$($fpAfter.headHash) porcelain=$($fpAfter.porcelainHash.Substring(0,12))"

  # 7. Assemble the result document. The AUDIT probe is the clean scenario; the other two are recorded gate proofs.
  $doc = [ordered]@{
    runId = $RunId; isolationMode = 'hyperv'; networkMode = 'none'
    candidateTransfer = 'explicit snapshot baked into the worker image at build time (C:\fusion\candidate); NO host bind mount'
    verificationCommand = 'approved VerificationPlan: pinned absolute node.exe + fixed argv + candidate cwd (no model shell)'
    mounts = $mounts; bindMountCount = $bindMounts
    probe = $probeClean; primaryFingerprintBefore = $fpBefore; primaryFingerprintAfter = $fpAfter
    scenarios = [ordered]@{ clean = $probeClean; timeout = $probeTimeout; mutate = $probeMutate }
    containerGone = $gone
  }
  $resPath = Join-Path $OutDir "verify-result-$RunId.json"
  Write-Json $resPath $doc
  Write-Output "RESULT=$resPath"
  & node (Join-Path $here 'verify-verify.mjs') $resPath
  $vexit = $LASTEXITCODE
  if ($vexit -notin 0, 1, 2) { $runVerdict = 'EXECUTION_ERROR' } else { $runVerdict = @('PASS', 'FAIL', 'INCOMPLETE')[$vexit] }

  # 8. Live gate-behaviour assertions (recorded; do not change the audit verdict but are printed for the proof log).
  $timeoutOk = ($probeTimeout -and $probeTimeout.ran.timedOut -eq $true -and (-not $probeTimeout.ran.exitCode))
  $mutateOk = ($probeMutate -and $probeMutate.sourceMutated -eq $true)
  Write-Output ("GATE_TIMEOUT_DETECTED=" + $timeoutOk)
  Write-Output ("GATE_MUTATION_DETECTED=" + $mutateOk)
}
catch { Write-Output "VERIFY_POC_EXECUTION_ERROR: $($_.Exception.Message)"; $runVerdict = 'EXECUTION_ERROR' }
finally {
  if (-not $KeepResources) {
    Write-Output "== cleanup (only $prefix* / $image) =="
    $removed = Invoke-ViCleanup
    $workerGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker }))
    $imageGone = (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }))
    $cleanupOk = $workerGone -and $imageGone
    Write-Json (Join-Path $OutDir "verify-cleanup-$RunId.json") ([ordered]@{ runId = $RunId; cleanupOk = $(if ($cleanupOk) { 'PASS' } else { 'FAIL' }); workerGone = $workerGone; imageGone = $imageGone; removed = $removed })
    Write-Output ("CLEANUP_OK=" + $cleanupOk)
  }
  else { Write-Output "KeepResources set - not cleaning up." }
}
Write-Output "VERIFY_RUN_VERDICT=$runVerdict"
switch -regex ("$runVerdict") { '^PASS$' { exit 0 } '^FAIL$' { exit 1 } '^INCOMPLETE$' { exit 2 } default { exit 3 } }
