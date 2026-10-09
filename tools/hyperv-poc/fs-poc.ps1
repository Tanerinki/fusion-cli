# Fusion v0.6 Hyper-V PoC - FILESYSTEM / workspace-isolation orchestrator (maintainer-run; NO admin, NO host network
# mutation). Proves that the untrusted Hyper-V writer (separate VM, --network none, NO host bind mount) cannot reach or
# mutate host/Primary filesystem state, that it CAN use its disposable approved workspace, and that a writer result is
# returned by a HOST-CONTROLLED export (docker cp from the ephemeral container) which Fusion validates - never by
# mounting the Primary writable. Independent before/after Primary fingerprints prove immutability. Always self-cleans.
# Reserved exit codes: 0=PASS 1=FAIL 2=INCOMPLETE 3=EXECUTION_ERROR (a harness error is NEVER a verified FAIL).
[CmdletBinding()] param(
  [ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId = ("fs" + [DateTime]::UtcNow.ToString('yyMMddHHmmss')),
  [ValidateSet('none', 'workerStart', 'canary', 'export', 'beforeKill')][string]$CrashAfter = 'none',
  [switch]$CleanupOnly,
  [switch]$KeepResources)
$ErrorActionPreference = 'Stop'
$here = [System.IO.Path]::GetDirectoryName($PSCommandPath)
if ([string]::IsNullOrWhiteSpace($here) -or -not (Test-Path -LiteralPath $here)) { throw "cannot resolve script directory (PSCommandPath='$PSCommandPath')" }
$here = [System.IO.Path]::GetFullPath($here)
$OutDir = $here
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $here '..\..'))   # tools\hyperv-poc -> repo root = the Primary Workspace under test
$primaryLeaf = Split-Path -Leaf $repoRoot
Write-Output "SCRIPT_DIR=$here"; Write-Output "REPO_ROOT(primary)=$repoRoot"
. (Join-Path $here 'native-launch.ps1')
function CrashIf($stage) { if ($CrashAfter -eq $stage) { throw "CRASH_INJECTED_AFTER_$stage" } }
$noBom = New-Object System.Text.UTF8Encoding($false)
$prefix = "FusionV06Poc-$RunId"
$image = "fusion-hv-poc-img:$RunId"
$worker = "$prefix-fs"
# The Hyper-V worker needs the EXACT real-writer shape to start on this host: --network none + ONE mapped Fusion npipe
# (a bare no-mount --network none Hyper-V container hangs in Created). A minimal pipe server makes the mount source
# exist; the FS canary never uses the pipe. This proves the FS boundary for the real writer's actual configuration.
$pipeLeaf = "$prefix-fs"
$pipePath = "\\.\pipe\$pipeLeaf"
$cred = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
$brokerProc = $null
$approvedRoot = 'C:\fusion\workspace'
$stagingDir = Join-Path $OutDir "$prefix-staging"   # Fusion-side isolated staging for the exported result (NEVER the primary)

function Write-Json($path, $obj) { [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 12), $noBom) }
function Hash-String([string]$s) { $sha = [System.Security.Cryptography.SHA256]::Create(); try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($s)))).Replace('-', '').ToLower() } finally { $sha.Dispose() } }
function Hash-FileIfExists([string]$p) { if (Test-Path -LiteralPath $p) { (Get-FileHash -LiteralPath $p -Algorithm SHA256).Hash.ToLower() } else { 'absent' } }

# Bounded, secret-free Primary-Workspace fingerprint: git working-tree state + HEAD/tree + key Git admin-file hashes.
# before==after proves the untrusted worker mutated nothing (independent of the worker's own self-report).
function Get-PrimaryFingerprint {
  $porcelain = (& git -C $repoRoot status --porcelain=v1 2>$null) -join "`n"
  $head = (& git -C $repoRoot rev-parse HEAD 2>$null)
  $tree = (& git -C $repoRoot rev-parse 'HEAD^{tree}' 2>$null)
  $gitDir = (& git -C $repoRoot rev-parse --git-dir 2>$null); if ($gitDir -and -not [System.IO.Path]::IsPathRooted($gitDir)) { $gitDir = Join-Path $repoRoot $gitDir }
  $hooks = ''
  if ($gitDir -and (Test-Path (Join-Path $gitDir 'hooks'))) { $hooks = ((Get-ChildItem (Join-Path $gitDir 'hooks') -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike '*.sample' } | ForEach-Object { $_.Name + ':' + (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash }) -join ';') }
  [ordered]@{
    porcelainHash  = Hash-String $porcelain
    headHash       = "$head"
    treeHash       = "$tree"
    gitConfigHash  = if ($gitDir) { Hash-FileIfExists (Join-Path $gitDir 'config') } else { 'nogitdir' }
    gitHeadFileHash = if ($gitDir) { Hash-FileIfExists (Join-Path $gitDir 'HEAD') } else { 'nogitdir' }
    gitHooksHash   = Hash-String $hooks
  }
}

function Invoke-FsCleanup {
  $removed = @()
  if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker }) { & docker rm -f $worker 2>$null | Out-Null; for ($k = 0; $k -lt 20; $k++) { if (-not (& docker ps -a --format '{{.Names}}' 2>$null | Where-Object { $_ -eq $worker })) { break }; Start-Sleep -Milliseconds 400 }; $removed += $worker }
  # A container killed mid-creation can leave a dangling endpoint in the `none` network; remove it (best-effort) so a
  # re-run with the same name does not hit "endpoint already exists". Wrapped: when there is no such endpoint (the
  # normal case, after --rm removed the worker) docker writes a harmless "endpoint not found" to stderr that must not
  # surface as an error. Never touches any non-PoC endpoint.
  try { & docker network disconnect -f none $worker 2>&1 | Out-Null } catch {}
  if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }) { & docker rmi $image 2>$null | Out-Null; $removed += $image }
  # Stop the tracked pipe server, and (for orphan recovery) any pipe-broker.ps1 process carrying THIS run id.
  if ($brokerProc -and (Get-Process -Id $brokerProc.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $brokerProc.Id -Force -ErrorAction SilentlyContinue; $removed += "broker" }
  Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'pipe-broker\.ps1' -and $_.CommandLine -match [regex]::Escape($RunId) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; $removed += "pid$($_.ProcessId)" }
  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -Recurse -Force $stagingDir -ErrorAction SilentlyContinue }
  Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.out" -or $_.Name -like "$prefix-*.err" -or $_.Name -like "$prefix-*.ready" } | ForEach-Object { Remove-Item -Force -ErrorAction SilentlyContinue $_.FullName }
  return $removed
}
if ($CleanupOnly) {
  $r = Invoke-FsCleanup
  $wg = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })); $ig = (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }))
  Write-Output ("CLEANUP_ONLY runId=$RunId removed=[" + ($r -join ',') + "] workerGone=$wg imageGone=$ig stagingGone=" + (-not (Test-Path -LiteralPath $stagingDir)))
  if ($wg -and $ig) { exit 0 } else { exit 1 }
}

$runVerdict = 'EXECUTION_ERROR'
try {
  $osType = (& docker info --format '{{.OSType}}' 2>$null)
  if ("$osType".Trim() -ne 'windows') { throw "Docker is not in Windows-container mode (OSType=$osType). Switch: docker desktop engine use windows" }

  # 1. Build the worker image (now also carries fs-canary.mjs).
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-worker-image.ps1') -RunId $RunId
  if ($LASTEXITCODE -ne 0) { throw "image build failed" }

  # 2. Independent Primary fingerprint BEFORE the untrusted worker runs.
  $fpBefore = Get-PrimaryFingerprint
  Write-Output "PRIMARY_FP_BEFORE head=$($fpBefore.headHash) porcelain=$($fpBefore.porcelainHash.Substring(0,12))"

  # 2a. Minimal pipe server so the worker's npipe mount SOURCE exists (the real .NET broker; dummy dest, never used by
  #     the FS canary). Launched via the shared native-launch quoting (spaced repo path safe).
  $readyFile = Join-Path $OutDir "$prefix-broker.ready"
  if (Test-Path $readyFile) { Remove-Item -Force $readyFile }
  $brokerArgList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'pipe-broker.ps1'),
    '-RunId', $RunId, '-PipeName', $pipeLeaf, '-Credential', $cred, '-AllowedHost', '127.0.0.1', '-AllowedPort', '59999', '-DaclMode', 'broad', '-ReadyFile', $readyFile)
  $brokerProc = Start-Process -FilePath 'powershell' -ArgumentList (Get-NativeArgString $brokerArgList) -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $OutDir "$prefix-broker.err") -RedirectStandardOutput (Join-Path $OutDir "$prefix-broker.out")
  for ($i = 0; $i -lt 40 -and -not (Test-Path $readyFile); $i++) { if ($brokerProc.HasExited) { throw "pipe server exited early (exit=$($brokerProc.ExitCode))" }; Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path $readyFile)) { throw "pipe server did not come up (no mount source for the worker)" }

  # 3. Start the worker in the REAL writer shape: --isolation=hyperv, --network none, EXACTLY ONE npipe, NO bind mount.
  $argJson = & node (Join-Path $here 'pipe-run-args.mjs') $worker $image $pipePath 'C:\fusion\node.exe' '-e' 'setInterval(()=>{},1000000000)'
  if ($LASTEXITCODE -ne 0) { throw "fs worker argv refused: $argJson" }
  $runArgs = $argJson | ConvertFrom-Json
  & docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "worker failed to start ($LASTEXITCODE)" }
  CrashIf 'workerStart'

  # 3a. Capture the REAL mount shape (prove NO host bind mount; only the npipe).
  $inspect = & docker inspect $worker --format '{{json .}}' | ConvertFrom-Json
  $mounts = @($inspect.Mounts | ForEach-Object { [ordered]@{ Type = "$($_.Type)"; Source = "$($_.Source)"; Destination = "$($_.Destination)" } })
  $bindMounts = @($mounts | Where-Object { $_.Type -eq 'bind' }).Count
  Write-Output ("DOCKER_STATE mounts=$($mounts.Count) bindMounts=$bindMounts")

  # 3b-pre. The Hyper-V guest can need a few seconds after the container is Up before `docker exec` works; wait for the
  #         guest to be exec-ready (bounded) before any exec, so a cold-boot race is not misread as a failure.
  for ($i = 0; $i -lt 30; $i++) { & docker exec $worker C:\fusion\node.exe -e "0" 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { break }; Start-Sleep -Milliseconds 1000 }

  # 3b. Provision the approved workspace + (best-effort) SEED a hostile reparse (junction) pointing at the host Primary
  #     path. Done via node (NOT cmd) so the spaced host path needs no shell quoting, and passed via an env var; the
  #     host path is absent in the VM so the junction is dangling (defense proven). STRICTLY non-fatal: a failed seed
  #     must never abort the run (the canary records not_applicable when no seed is present).
  try {
    & docker exec $worker C:\fusion\node.exe -e "require('fs').mkdirSync('C:/fusion/workspace',{recursive:true})" 2>$null | Out-Null
    & docker exec -e "SEED_TGT=$repoRoot" $worker C:\fusion\node.exe -e "try{require('fs').symlinkSync(process.env.SEED_TGT,'C:/fusion/workspace/seeded-link','junction')}catch(e){}" 2>$null | Out-Null
  } catch { Write-Output "SEED_SKIPPED: $($_.Exception.Message)" }

  # 4. Run the adversarial FS canary inside the worker and CAPTURE its one FS_PROBE_JSON line from stdout. This is the
  #    HOST-CONTROLLED result pull: `docker cp` is unsupported against a running Hyper-V container, and nothing host is
  #    mounted, so the worker's only way out is the bounded JSON it writes to its own stdout, which `docker exec` hands
  #    to Fusion. The worker cannot push anywhere; Fusion reads and then independently validates it.
  $spec = @{ approvedRoot = $approvedRoot; primaryWorkspacePath = $repoRoot; primaryWorkspaceLeaf = $primaryLeaf }
  $specB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Compress)))
  $raw = ""
  try { $raw = (& docker exec -e "FUSION_FS_SPEC=$specB64" $worker C:\fusion\node.exe C:\fusion\fs-canary.mjs 2>$null) -join "`n" } catch { Write-Output "CANARY_EXEC_NOTE: $($_.Exception.Message)" }
  CrashIf 'canary'
  $probe = $null
  $line = ($raw -split "`n") | Where-Object { $_ -like 'FS_PROBE_JSON *' } | Select-Object -First 1
  if ($line) { try { $probe = ($line.Substring('FS_PROBE_JSON '.Length) | ConvertFrom-Json) } catch { $probe = $null } }
  # 5. The result manifest is the worker's self-reported relative workspace entries (validated host-side by fs-verify).
  $resultEntries = if ($probe -and $probe.resultEntries) { @($probe.resultEntries) } else { @() }
  Write-Output ("RESULT_MANIFEST entries=$($resultEntries.Count)")

  CrashIf 'beforeKill'
  # 6. Kill the worker (ephemeral --rm; auto-removes). The VM + its whole disposable FS are destroyed.
  & docker kill $worker 2>$null | Out-Null
  $gone = $false; for ($i = 0; $i -lt 20 -and -not $gone; $i++) { if (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })) { $gone = $true } else { Start-Sleep -Milliseconds 300 } }

  # 7. Independent Primary fingerprint AFTER.
  $fpAfter = Get-PrimaryFingerprint
  Write-Output "PRIMARY_FP_AFTER head=$($fpAfter.headHash) porcelain=$($fpAfter.porcelainHash.Substring(0,12))"

  # 8. Verification-isolation model (HONEST): verifying untrusted output is itself untrusted-code execution and must run
  #    in a fresh isolated worker. This PoC proves the FS boundary + result transfer; wiring an isolated verification
  #    run is a documented follow-up, so we record the DESIGNED model but do NOT assert it is implemented here.
  $verificationModel = [ordered]@{
    designed = $true; implementedInThisPoc = $false
    executesOnHost = $false; isolatedWorker = $false; commandIdentityHostOwned = $true; cwdHostControlled = $true
    envHostControlled = $true; executableResolutionPinned = $false; prePostStateMeasured = $false
    note = 'designed: run verification of untrusted writer output inside a fresh --network none Hyper-V worker with a host-pinned command/argv/cwd/env; NOT yet implemented in this PoC'
  }

  # 9. Assemble the result document + compute verdicts (never manual).
  $doc = [ordered]@{
    runId = $RunId; isolationMode = 'hyperv'; networkMode = 'none'; workspaceModel = 'disposable-in-VM (no host bind mount); host-controlled result pull via the worker stdout manifest (docker cp is unsupported for a running Hyper-V container)'
    approvedWriterRoot = $approvedRoot; mounts = $mounts; bindMountCount = $bindMounts
    probe = $probe; primaryFingerprintBefore = $fpBefore; primaryFingerprintAfter = $fpAfter
    resultEntries = $resultEntries; verificationModel = $verificationModel; containerGone = $gone
  }
  $resPath = Join-Path $OutDir "fs-result-$RunId.json"
  Write-Json $resPath $doc
  Write-Output "RESULT=$resPath"
  & node (Join-Path $here 'fs-verify.mjs') $resPath
  $vexit = $LASTEXITCODE
  if ($vexit -notin 0, 1, 2) { $runVerdict = 'EXECUTION_ERROR' } else { $runVerdict = @('PASS', 'FAIL', 'INCOMPLETE')[$vexit] }
}
catch { Write-Output "FS_POC_EXECUTION_ERROR: $($_.Exception.Message)"; $runVerdict = 'EXECUTION_ERROR' }
finally {
  if (-not $KeepResources) {
    Write-Output "== cleanup (only $prefix* / $image) =="
    $removed = Invoke-FsCleanup
    $workerGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker }))
    $imageGone = (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }))
    $stagingGone = (-not (Test-Path -LiteralPath $stagingDir))
    $cleanupOk = $workerGone -and $imageGone -and $stagingGone
    Write-Json (Join-Path $OutDir "fs-cleanup-$RunId.json") ([ordered]@{ runId = $RunId; cleanupOk = $(if ($cleanupOk) { 'PASS' } else { 'FAIL' }); workerGone = $workerGone; imageGone = $imageGone; stagingGone = $stagingGone; removed = $removed })
    Write-Output ("CLEANUP_OK=" + $cleanupOk)
  }
  else { Write-Output "KeepResources set - not cleaning up." }
}
Write-Output "FS_RUN_VERDICT=$runVerdict"
switch -regex ("$runVerdict") { '^PASS$' { exit 0 } '^FAIL$' { exit 1 } '^INCOMPLETE$' { exit 2 } default { exit 3 } }
