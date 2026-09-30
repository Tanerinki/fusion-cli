# Fusion v0.6 Hyper-V PoC — verify (thin wrapper; the verdict is computed by node verify.mjs, never manually).
[CmdletBinding()] param([Parameter(Mandatory=$true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId)
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$res = Join-Path $here "result-$RunId.json"
if(-not (Test-Path $res)){ Write-Error "no result-$RunId.json — run ./run.ps1 -RunId $RunId first"; exit 2 }
node (Join-Path $here 'verify.mjs') $res
exit $LASTEXITCODE
