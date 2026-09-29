param([string]$OutputDirectory = (Join-Path $PSScriptRoot 'bin'))
# Builds the v0.6 AppContainer confinement launcher with the in-box .NET Framework x64 C# compiler. No SDK, no NuGet,
# no network. The output (native/fusion-sandbox/bin/fusion-sandbox.exe) is git-ignored; the host hashes it before use.
$ErrorActionPreference = 'Stop'
$compiler = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw 'The in-box .NET Framework x64 C# compiler (csc.exe) is unavailable.' }
$source = Join-Path $PSScriptRoot 'Program.cs'
$output = Join-Path $OutputDirectory 'fusion-sandbox.exe'
New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
& $compiler /nologo /target:exe /platform:x64 /optimize+ "/out:$output" /r:System.Web.Extensions.dll /r:System.Core.dll $source
if ($LASTEXITCODE -ne 0) { throw "The fusion-sandbox launcher build failed ($LASTEXITCODE)." }
Get-Item -LiteralPath $output | Select-Object FullName, Length
