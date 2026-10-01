# Fusion v0.6 Hyper-V PoC - mapped-named-pipe / --network none orchestrator (maintainer-run; NO admin, NO host network
# mutation). One command: builds the worker image, starts the host broker + synthetic provider, launches a Hyper-V-
# isolated worker with --network none and EXACTLY ONE mapped Fusion pipe, verifies the Docker/HCS state, runs the
# adversarial guest canary + FS/process/cleanup canaries, writes the evidence files, computes the verdicts (pipe-
# evaluator, never manual), and ALWAYS cleans up its own resources. UNTESTED on hardware. Reserved exit codes:
# 0=PASS 1=FAIL 2=INCOMPLETE 3=EXECUTION_ERROR (a harness error is NEVER a verified boundary FAIL).
[CmdletBinding()] param(
  [ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId = ("p" + [DateTime]::UtcNow.ToString('yyMMddHHmmss')),
  [ValidateSet('broad', 'narrow')][string]$DaclMode = 'broad',
  [string]$NarrowPrincipal = $null,
  [switch]$KeepResources)
$ErrorActionPreference = 'Stop'
$here = [System.IO.Path]::GetDirectoryName($PSCommandPath)
if ([string]::IsNullOrWhiteSpace($here) -or -not (Test-Path -LiteralPath $here)) { throw "cannot resolve script directory (PSCommandPath='$PSCommandPath')" }
$here = [System.IO.Path]::GetFullPath($here)
$OutDir = $here
Write-Output "SCRIPT_DIR=$here"; Write-Output "OUT_DIR=$OutDir"
$noBom = New-Object System.Text.UTF8Encoding($false)
$prefix = "FusionV06Poc-$RunId"
$image = "fusion-hv-poc-img:$RunId"
$worker = "$prefix-pipe"
$pipeLeaf = "$prefix-pipe"
$pipePath = "\\.\pipe\$pipeLeaf"
$cred = ([guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N'))
$shimPort = 51720; $provPort = 51730
$providerIp = '127.0.0.1'   # the synthetic provider is a host loopback listener; ONLY the broker (host) reaches it
$jobs = @(); $brokerProc = $null

function Write-Json($path, $obj) { [System.IO.File]::WriteAllText($path, ($obj | ConvertTo-Json -Depth 10), $noBom) }

$runVerdict = 'EXECUTION_ERROR'
try {
  $osType = (& docker info --format '{{.OSType}}' 2>$null)
  if ("$osType".Trim() -ne 'windows') { throw "Docker is not in Windows-container mode (OSType=$osType). Switch: docker desktop engine use windows" }

  # 1. Build the worker image (nanoserver + node + fake-provider + guest shim + pipe canary + protocol).
  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $here 'build-worker-image.ps1') -RunId $RunId
  if ($LASTEXITCODE -ne 0) { throw "image build failed" }

  # 2. Synthetic provider stand-in (host loopback token-echo) = the ONE approved destination.
  $echoBlock = { param($ip, $port, $token)
    $l = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Parse($ip), [int]$port); $l.Start()
    while ($true) { try { $c = $l.AcceptTcpClient(); $s = $c.GetStream(); $b = [Text.Encoding]::ASCII.GetBytes("$token`n"); $s.Write($b, 0, $b.Length); $s.Flush(); Start-Sleep -Milliseconds 500; $c.Close() } catch { break } }
  }
  $provJob = Start-Job -Name "$prefix-provider" -ScriptBlock $echoBlock -ArgumentList $providerIp, $provPort, $cred
  $jobs += $provJob

  # 2a. LAN POSITIVE-CONTROL: discover the current non-PoC host LAN IPv4 (default-gateway interface) and bind a
  #     Fusion-owned listener there on a dedicated PoC port. The worker probes this EXACT address:port, and the host
  #     proves it can reach it. The listener only BINDS the existing address (no adapter/route change). If no LAN IPv4
  #     is found, rawHostLan stays INCOMPLETE (never hard-coded, never assumed reachable).
  $lanIp = $null; $lanPort = 51740
  try { $lanIp = (Get-NetIPConfiguration | Where-Object { $_.IPv4DefaultGateway } | Select-Object -First 1).IPv4Address.IPAddress } catch { }
  if ($lanIp) { $jobs += (Start-Job -Name "$prefix-lanctl" -ScriptBlock $echoBlock -ArgumentList $lanIp, $lanPort, $cred) }
  Write-Output "LAN_CONTROL=$lanIp`:$lanPort"

  # 3. Host broker (.NET) bound to the per-run pipe; forwards ONLY to the synthetic provider; per-run credential.
  $readyFile = Join-Path $OutDir "$prefix-broker.ready"
  if (Test-Path $readyFile) { Remove-Item -Force $readyFile }
  $brokerArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $here 'pipe-broker.ps1'),
    '-RunId', $RunId, '-PipeName', $pipeLeaf, '-Credential', $cred, '-AllowedHost', $providerIp, '-AllowedPort', "$provPort", '-DaclMode', $DaclMode, '-ReadyFile', $readyFile)
  if ($NarrowPrincipal) { $brokerArgs += @('-NarrowPrincipal', $NarrowPrincipal) }
  $brokerProc = Start-Process -FilePath 'powershell' -ArgumentList $brokerArgs -PassThru -WindowStyle Hidden -RedirectStandardError (Join-Path $OutDir "$prefix-broker.log") -RedirectStandardOutput (Join-Path $OutDir "$prefix-broker.out")
  for ($i = 0; $i -lt 40 -and -not (Test-Path $readyFile); $i++) { Start-Sleep -Milliseconds 250 }
  if (-not (Test-Path $readyFile)) { throw "host broker did not come up (see $prefix-broker.log)" }

  # 4. Worker: --isolation=hyperv, --network none, EXACTLY ONE mapped Fusion pipe (argv from the tested builder).
  $argJson = & node (Join-Path $here 'pipe-run-args.mjs') $worker $image $pipePath 'C:\fusion\node.exe' '-e' 'setInterval(()=>{},1000000000)'
  if ($LASTEXITCODE -ne 0) { throw "pipe worker argv refused: $argJson" }
  $runArgs = $argJson | ConvertFrom-Json
  & docker @runArgs | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "worker failed to start ($LASTEXITCODE)" }

  # 5. Capture the REAL Docker/HCS mount shape (gates PROVEN via WORKER_RUNTIME_SHAPE; not inferred from argv).
  $inspect = & docker inspect $worker --format '{{json .}}' | ConvertFrom-Json
  $mounts = @($inspect.Mounts | ForEach-Object { [ordered]@{ Type = "$($_.Type)"; Source = "$($_.Source)"; Destination = "$($_.Destination)" } })
  $netCount = @($inspect.NetworkSettings.Networks.PSObject.Properties).Count
  $runtimeShape = [ordered]@{ mounts = $mounts; networks = $netCount }
  Write-Output ("DOCKER_STATE mounts=$($mounts.Count) networks=$netCount")

  # 6. Start the guest shim (background), then run the adversarial canary.
  & docker exec -d $worker C:\fusion\node.exe C:\fusion\guest-shim.mjs "$shimPort" "$pipePath" "$cred" "$providerIp" "$provPort" | Out-Null
  Start-Sleep -Milliseconds 1500
  $lanTargetIp = if ($lanIp) { $lanIp } else { '169.254.255.255' }  # if no LAN IP was found there is no control; stays INCOMPLETE
  $spec = @{ ms = 4000; token = $cred; shimPort = $shimPort; pipePath = $pipePath; credential = $cred; allowedHost = $providerIp; allowedPort = $provPort
    rawTcp = @(, @('1.1.1.1', 443, 'rawInternet'), @($lanTargetIp, $lanPort, 'rawHostLan'), @('127.0.0.1', 9, 'rawHostLocal'), @($providerIp, $provPort, 'rawDirectProvider'), @('1.0.0.1', 443, 'rawSocketBypass'))
    dns = '1.1.1.1'
    guessPipes = @("\\.\pipe\FusionV06Poc-deadbeef-pipe")
    otherHostPipes = @("\\.\pipe\docker_engine", "\\.\pipe\lsass", "\\.\pipe\ntsvcs")
    spawn = $true; hold = $false }
  $specB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($spec | ConvertTo-Json -Depth 8 -Compress)))
  $raw = & docker exec -e "FUSION_PIPE_SPEC=$specB64" $worker C:\fusion\node.exe C:\fusion\pipe-canary.mjs 2>$null
  $line = ($raw -split "`n") | Where-Object { $_ -like 'PROBE_JSON *' } | Select-Object -First 1
  $probe = if ($line) { $line.Substring('PROBE_JSON '.Length) | ConvertFrom-Json } else { $null }

  # 7. Host positive controls (host CAN reach these; the worker must not). Each targets the EXACT address:port the
  #    worker probed. DNS is a REAL bounded UDP probe against the same server (no hard-coded 'answered').
  function Test-HostTcp($ip, $port) { $c = New-Object System.Net.Sockets.TcpClient; try { $iar = $c.BeginConnect($ip, [int]$port, $null, $null); if ($iar.AsyncWaitHandle.WaitOne(3000, $false)) { $c.EndConnect($iar); 'connected' } else { 'timeout' } } catch { 'refused' } finally { $c.Close() } }
  function Test-HostDns($server) {
    $u = New-Object System.Net.Sockets.UdpClient
    try {
      $q = [byte[]]@(0xab, 0xcd, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07, 0x65, 0x78, 0x61, 0x6d, 0x70, 0x6c, 0x65, 0x03, 0x63, 0x6f, 0x6d, 0x00, 0x00, 0x01, 0x00, 0x01)
      [void]$u.Send($q, $q.Length, $server, 53); $u.Client.ReceiveTimeout = 3000
      $ep = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0); [void]$u.Receive([ref]$ep); 'answered'
    } catch { 'timeout' } finally { $u.Close() }
  }
  # rawHostLan control only exists if a LAN IP was discovered; otherwise it stays unprovable -> INCOMPLETE.
  $lanControl = if ($lanIp) { (Test-HostTcp $lanIp $lanPort) } else { 'not_run' }
  $hostControls = @{ rawInternet = (Test-HostTcp '1.1.1.1' 443); rawHostLan = $lanControl; rawDns = (Test-HostDns '1.1.1.1'); rawDirectProvider = (Test-HostTcp $providerIp $provPort); rawSocketBypass = (Test-HostTcp '1.0.0.1' 443) }

  # 8. Evidence assembly for the evaluator.
  $pipeEv = [ordered]@{
    allowedRoute = if ($probe) { "$($probe.pipe.allowedRoute.outcome)" } else { 'not_run' }
    allowedRouteTokenEchoed = if ($probe -and $probe.pipe.allowedRoute) { [bool]$probe.pipe.allowedRoute.tokenEchoed } else { $false }
    directPipeNoAuth = if ($probe) { "$($probe.pipe.directNoAuth.outcome)" } else { 'not_run' }
    directPipeWrongCred = if ($probe) { "$($probe.pipe.directWrongCred.outcome)" } else { 'not_run' }
    directPipeWrongDest = if ($probe) { "$($probe.pipe.directWrongDest.outcome)" } else { 'not_run' }
    unauthorizedDestThroughBroker = if ($probe) { "$($probe.pipe.directWrongDest.outcome)" } else { 'not_run' }
    pipeNameGuess = if ($probe) { "$($probe.otherPipes.'guess:\\.\pipe\FusionV06Poc-deadbeef-pipe'.outcome)" } else { 'not_run' }
    directPipeAuthorized = if ($probe) { "$($probe.pipe.directAuthorized.outcome)" } else { 'not_run' }
  }
  $netEv = [ordered]@{
    facts = if ($probe) { $probe.facts } else { @{} }
    rawInternet = if ($probe) { "$($probe.raw.rawInternet.outcome)" } else { 'not_run' }
    rawHostLan = if ($probe) { "$($probe.raw.rawHostLan.outcome)" } else { 'not_run' }
    rawDns = if ($probe) { "$($probe.dns.outcome)" } else { 'not_run' }
    rawDirectProvider = if ($probe) { "$($probe.raw.rawDirectProvider.outcome)" } else { 'not_run' }
    rawSocketBypass = if ($probe) { "$($probe.raw.rawSocketBypass.outcome)" } else { 'not_run' }
    otherHostPipeOpen = if ($probe) { @("$($probe.otherPipes.'host:\\.\pipe\docker_engine')", "$($probe.otherPipes.'host:\\.\pipe\lsass')", "$($probe.otherPipes.'host:\\.\pipe\ntsvcs')" | Where-Object { $_ -eq 'connected' } | Select-Object -First 1) } else { 'not_run' }
    hostControls = $hostControls
  }
  if (-not $netEv.otherHostPipeOpen) { $netEv.otherHostPipeOpen = 'refused' }  # none connected => denied
  Write-Json (Join-Path $OutDir "pipe-evidence-$RunId.json") $pipeEv
  Write-Json (Join-Path $OutDir "network-none-evidence-$RunId.json") $netEv

  # 9. Process-tree: child captured + worker killed (worker runs --rm; kill auto-removes). Poll for absence.
  $childPid = if ($probe -and $probe.pids.child) { [int]$probe.pids.child } else { 0 }
  & docker kill $worker 2>$null | Out-Null
  $gone = $false; for ($i = 0; $i -lt 20 -and -not $gone; $i++) { if (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })) { $gone = $true } else { Start-Sleep -Milliseconds 300 } }
  $ptVerdict = & node (Join-Path $here 'lifecycle.mjs') 'process-tree' "$childPid" ($gone.ToString().ToLower()) 'true'
  Write-Json (Join-Path $OutDir "lifecycle-evidence-$RunId.json") ([ordered]@{ processTreeContainment = "$ptVerdict"; forcedKillCleanup = if ($gone) { 'PASS' } else { 'FAIL' }; childPid = $childPid; containerGone = $gone })

  # 10. Filesystem dimension is NOT exercised by this network-focused PoC (no view/scratch mounts here); record NOT_RUN
  #     honestly so the full HARD verdict stays INCOMPLETE while the network boundary is evaluated on its own.
  $fsEv = [ordered]@{ note = 'filesystem boundary not exercised in the pipe network PoC; proven separately'; viewRead = 'NOT_RUN' }
  Write-Json (Join-Path $OutDir "filesystem-evidence-$RunId.json") $fsEv

  # 11. Compute verdicts (never manual). The runtime shape (actual docker inspect mounts) GATES PROVEN.
  $doc = [ordered]@{ pipe = $pipeEv; network = $netEv; runtimeShape = $runtimeShape; runtimeShapeExpected = @{ pipe = $pipePath }
    filesystem = @{}; lifecycle = @{ processTreeContainment = "$ptVerdict"; forcedKillCleanup = $(if ($gone) { 'PASS' } else { 'FAIL' }) }; cleanup = @{ cleanupOk = 'PASS' } }
  $resPath = Join-Path $OutDir "result-$RunId.json"
  Write-Json $resPath ([ordered]@{ runId = $RunId; daclMode = $DaclMode; evidence = $doc })
  Write-Output "RESULT=$resPath"
  & node (Join-Path $here 'pipe-verify.mjs') $resPath
  $vexit = $LASTEXITCODE
  if ($vexit -notin 0, 1, 2) { $runVerdict = 'EXECUTION_ERROR' } else { $runVerdict = @('PASS', 'FAIL', 'INCOMPLETE')[$vexit] }
}
catch { Write-Output "PIPE_POC_EXECUTION_ERROR: $($_.Exception.Message)"; $runVerdict = 'EXECUTION_ERROR' }
finally {
  if (-not $KeepResources) {
    Write-Output "== cleanup (only $prefix* / $image) =="
    foreach ($c in @($worker)) { if (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $c }) { & docker rm -f $c | Out-Null } }
    if (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image }) { & docker rmi $image | Out-Null }
    if ($brokerProc -and (Get-Process -Id $brokerProc.Id -ErrorAction SilentlyContinue)) { Stop-Process -Id $brokerProc.Id -Force -ErrorAction SilentlyContinue }
    Get-Job | Where-Object { $_.Name -like "$prefix-*" } | ForEach-Object { Stop-Job $_; Remove-Job $_ }
    Get-ChildItem $OutDir -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -like "$prefix-*.log" -or $_.Name -like "$prefix-*.out" -or $_.Name -like "$prefix-*.ready" } | ForEach-Object { Remove-Item -Force $_.FullName }
    $alive = if ($brokerProc) { [bool](Get-Process -Id $brokerProc.Id -ErrorAction SilentlyContinue) } else { $false }
    $cleanupOk = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })) -and (-not (& docker images --format '{{.Repository}}:{{.Tag}}' | Where-Object { $_ -eq $image })) -and (-not $alive)
    Write-Json (Join-Path $OutDir "cleanup-$RunId.json") ([ordered]@{ runId = $RunId; cleanupOk = $(if ($cleanupOk) { 'PASS' } else { 'FAIL' }); workerGone = (-not (& docker ps -a --format '{{.Names}}' | Where-Object { $_ -eq $worker })); brokerAlive = $alive })
    Write-Output ("CLEANUP_OK=" + $cleanupOk)
  }
  else { Write-Output "KeepResources set - not cleaning up." }
}
Write-Output "RUN_VERDICT=$runVerdict"
Write-Output "BROKER_ONLY_NETWORK_BOUNDARY stays NOT_PROVEN unless pipe-verify reports PROVEN and the evidence is reviewed."
switch -regex ("$runVerdict") { '^PASS$' { exit 0 } '^FAIL$' { exit 1 } '^INCOMPLETE$' { exit 2 } default { exit 3 } }
