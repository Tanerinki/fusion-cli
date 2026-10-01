# Fusion v0.6 Hyper-V PoC — apply the endpoint ACL via the NATIVE HCN API (ELEVATED; maintainer-run).
#
# Native computenetwork.dll exports: HcnOpenEndpoint / HcnModifyEndpoint / HcnCloseEndpoint. (The hcsshim Go wrapper is
# called ModifyEndpointSettings — that is NOT the native entry point; using it would fail to bind.) Each API returns an
# optional ErrorRecord (a native LPWSTR allocated with LocalAlloc); we read it and free it with LocalFree, and surface
# the full bounded HCN error (HRESULT + text) on failure.
#
# SAFETY: the ACL is applied to the WORKER's OWN ephemeral endpoint (discovered for this run). It is NOT a machine
# firewall rule and creates NO persistent host object: when the worker container is removed, its endpoint — and this ACL
# — ceases to exist. There is nothing global to roll back. The ACL JSON is produced by the pure, CI-tested builder
# (acl-policy.mjs -> toHcnModifyRequest). This machine has computenetwork.dll but NOT the HostComputeNetwork PS module,
# so the policy is submitted by P/Invoke. UNTESTED on hardware until the maintainer runs it elevated.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [Parameter(Mandatory = $true)][string]$EndpointId,
  [Parameter(Mandatory = $true)][string]$SettingsPath)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $SettingsPath)) { throw "ACL settings JSON not found: $SettingsPath" }
$settings = Get-Content -Raw $SettingsPath
$guid = [Guid]$EndpointId   # throws if the discovered endpoint id is not a GUID — never guesses

if (-not ([System.Management.Automation.PSTypeName]'Fusion.Hcn').Type) {
  Add-Type -Namespace 'Fusion' -Name 'Hcn' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("computenetwork.dll")]
public static extern int HcnOpenEndpoint(ref System.Guid Id, out System.IntPtr Endpoint, out System.IntPtr ErrorRecord);
[System.Runtime.InteropServices.DllImport("computenetwork.dll")]
public static extern int HcnModifyEndpoint(System.IntPtr Endpoint, [System.Runtime.InteropServices.MarshalAs(System.Runtime.InteropServices.UnmanagedType.LPWStr)] string Settings, out System.IntPtr ErrorRecord);
[System.Runtime.InteropServices.DllImport("computenetwork.dll")]
public static extern int HcnCloseEndpoint(System.IntPtr Endpoint);
[System.Runtime.InteropServices.DllImport("kernel32.dll")]
public static extern System.IntPtr LocalFree(System.IntPtr hMem);
'@
}

function Read-ErrorRecord([System.IntPtr]$ptr) {
  if ($ptr -eq [System.IntPtr]::Zero) { return '' }
  try { return [System.Runtime.InteropServices.Marshal]::PtrToStringUni($ptr) } finally { [void][Fusion.Hcn]::LocalFree($ptr) }
}

$ep = [IntPtr]::Zero; $errOpen = [IntPtr]::Zero
$hrOpen = [Fusion.Hcn]::HcnOpenEndpoint([ref]$guid, [ref]$ep, [ref]$errOpen)
$openErrText = Read-ErrorRecord $errOpen
if ($hrOpen -ne 0) { Write-Output "ACL_APPLIED=NO (HcnOpenEndpoint hr=0x$($hrOpen.ToString('X8')) err=$openErrText)"; exit 2 }
try {
  $errMod = [IntPtr]::Zero
  $hrMod = [Fusion.Hcn]::HcnModifyEndpoint($ep, $settings, [ref]$errMod)
  $modErrText = Read-ErrorRecord $errMod
  if ($hrMod -ne 0) { Write-Output "ACL_APPLIED=NO (HcnModifyEndpoint hr=0x$($hrMod.ToString('X8')) err=$modErrText)"; exit 2 }
  Write-Output "ACL_APPLIED=YES (endpoint $EndpointId)"
  exit 0
} finally {
  [void][Fusion.Hcn]::HcnCloseEndpoint($ep)
}
