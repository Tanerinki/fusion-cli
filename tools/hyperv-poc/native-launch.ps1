# Fusion v0.6 Hyper-V PoC - native node launcher helper (dot-sourced). Windows PowerShell 5.1 `Start-Process
# -ArgumentList @(...)` joins array elements with spaces WITHOUT quoting, so a script path like
# `D:\apps backup\fusion-cli\tools\hyperv-poc\listener.mjs` would split into two arguments. These helpers quote each
# argument per the MSVCRT/CreateProcess rules so paths with spaces survive as ONE argument. Start-Process with
# -RedirectStandardError uses CreateProcess (UseShellExecute=$false), so there is no shell/cmd interpolation and thus no
# argument-injection surface; we still quote defensively.

function Format-NativeArg {
  param([Parameter(Mandatory = $true)][AllowEmptyString()][string]$Arg)
  if ($Arg -ne '' -and $Arg -notmatch '[\s"]') { return $Arg }   # no quoting needed
  $s = [regex]::Replace($Arg, '(\\*)"', '$1$1\"')                 # double the backslashes preceding a quote, escape the quote
  $s = [regex]::Replace($s, '(\\+)$', '$1$1')                     # double trailing backslashes before the closing quote
  return '"' + $s + '"'
}

function Get-NativeArgString {
  param([Parameter(Mandatory = $true)][string[]]$Args)
  return (($Args | ForEach-Object { Format-NativeArg $_ }) -join ' ')
}

# Launches `node <scriptPath> <scriptArgs...>` as an explicitly-owned detached process, with its stderr redirected.
# Returns the process object (use .Id as the persisted owned PID). The script path and args may contain spaces.
function Start-NativeNode {
  param(
    [Parameter(Mandatory = $true)][string]$ScriptPath,
    [string[]]$ScriptArgs = @(),
    [Parameter(Mandatory = $true)][string]$StderrLog)
  $argString = Get-NativeArgString (@($ScriptPath) + $ScriptArgs)
  return Start-Process -FilePath 'node' -ArgumentList $argString -PassThru -WindowStyle Hidden -RedirectStandardError $StderrLog
}
