# Fusion v0.6 Hyper-V PoC - HOST PIPE BROKER (ELEVATED not required; maintainer-run). A tiny .NET NamedPipeServerStream
# helper (node/libuv host-server mode was unreliable over the VMBus mapped pipe; .NET is proven). Wire format MIRRORS
# tools/hyperv-poc/pipe-protocol.mjs (MAGIC 'FHP1', ver 1, types AUTH=1/AUTH_OK=2/DATA=3/REJECT=4, MAX_PAYLOAD 65536).
# Bounded + fail-closed: one authenticated session per connection (per-run credential), EXACTLY one approved destination
# (no generic TCP forwarding, no wildcard), strict length caps, a timeout, malformed/oversized => drop. No filesystem
# ops, no command execution. A client that opens the pipe DIRECTLY gets no more authority than the shim (same gate).
# UNTESTED on hardware. Writes <pipeReady sentinel> then serves until killed.
[CmdletBinding()] param(
  [Parameter(Mandatory = $true)][ValidatePattern('^[A-Za-z0-9]{4,32}$')][string]$RunId,
  [Parameter(Mandatory = $true)][string]$PipeName,          # e.g. FusionV06Poc-<RunId>-pipe (NO \\.\pipe\ prefix)
  [Parameter(Mandatory = $true)][string]$Credential,        # per-run random secret (the real authenticator)
  [Parameter(Mandatory = $true)][string]$AllowedHost,       # the ONE synthetic provider host
  [Parameter(Mandatory = $true)][int]$AllowedPort,          # the ONE synthetic provider port
  [ValidateSet('narrow', 'broad')][string]$DaclMode = 'broad',  # 'broad' = Everyone (defense-in-depth only; see note)
  [string]$NarrowPrincipal = $null,                         # SID/account to grant in 'narrow' mode (the HCS proxy principal)
  [string]$ReadyFile = $null)
$ErrorActionPreference = 'Stop'

# PIPE_DACL_MODE is recorded honestly. 'broad' (Everyone) is DEFENSE-IN-DEPTH ONLY: the per-run cryptographic credential
# is mandatory and is the real boundary. We never claim the DACL is the HARD boundary, and never expose a reusable
# credential. Narrow the DACL once the exact HCS/VMBus mapped-pipe proxy principal is observed on the host.
$daclLabel = if ($DaclMode -eq 'broad') { 'BROAD_DACL:Everyone' } elseif ($NarrowPrincipal) { "narrow:$NarrowPrincipal" } else { 'narrow:current-user' }
Write-Output "PIPE_DACL_MODE=$daclLabel"

Add-Type -ReferencedAssemblies 'System.Core' -TypeDefinition @"
using System;
using System.IO;
using System.IO.Pipes;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Security.AccessControl;
using System.Security.Principal;

public static class FusionPipeBroker {
  const int MAGIC = 0x46485031; // 'FHP1' big-endian
  const byte VER = 1;
  const byte AUTH = 1, AUTH_OK = 2, DATA = 3, REJECT = 4;
  const int MAX_PAYLOAD = 64 * 1024;
  const int MAX_AUTH = 1024;

  static bool ReadExact(Stream s, byte[] b, int n) {
    int off = 0; while (off < n) { int r = s.Read(b, off, n - off); if (r <= 0) return false; off += r; } return true;
  }
  static void WriteFrame(Stream s, byte type, byte[] payload) {
    int len = payload == null ? 0 : payload.Length;
    byte[] h = new byte[10];
    h[0]=0x46; h[1]=0x48; h[2]=0x50; h[3]=0x31; h[4]=VER; h[5]=type;
    h[6]=(byte)((len>>24)&0xff); h[7]=(byte)((len>>16)&0xff); h[8]=(byte)((len>>8)&0xff); h[9]=(byte)(len&0xff);
    s.Write(h,0,10); if (len>0) s.Write(payload,0,len); s.Flush();
  }
  // Returns payload or null (fail closed) and sets type via out.
  static byte[] ReadFrame(Stream s, out byte type) {
    type = 0; byte[] h = new byte[10]; if (!ReadExact(s,h,10)) return null;
    if (h[0]!=0x46||h[1]!=0x48||h[2]!=0x50||h[3]!=0x31||h[4]!=VER) return null;
    type = h[5]; int len = (h[6]<<24)|(h[7]<<16)|(h[8]<<8)|h[9];
    if (len < 0 || len > MAX_PAYLOAD) return null;
    byte[] p = new byte[len]; if (len>0 && !ReadExact(s,p,len)) return null; return p;
  }
  static bool CredEquals(string a, string b) {
    if (a == null || b == null) return false; var x = Encoding.UTF8.GetBytes(a); var y = Encoding.UTF8.GetBytes(b);
    if (x.Length != y.Length || x.Length == 0) return false; int d = 0; for (int i=0;i<x.Length;i++) d |= x[i]^y[i]; return d==0;
  }
  static string JsonField(string s, string key) {
    // minimal, bounded extraction of "key":"value" or "key":number from a tiny AUTH JSON (no full parser needed).
    int i = s.IndexOf("\""+key+"\""); if (i<0) return null; i = s.IndexOf(':', i); if (i<0) return null; i++;
    while (i<s.Length && (s[i]==' '||s[i]=='\t')) i++;
    if (i<s.Length && s[i]=='"') { i++; int j=s.IndexOf('"', i); if (j<0) return null; return s.Substring(i, j-i); }
    int k=i; while (k<s.Length && (char.IsDigit(s[k]))) k++; return s.Substring(i, k-i);
  }

  static void Pump(Stream fromPipe, Stream toTcp, bool framed, NamedPipeServerStream pipe, Socket tcp) {
    try {
      if (framed) { // pipe -> tcp: deframe DATA
        byte t; byte[] p; while ((p = ReadFrame(fromPipe, out t)) != null) { if (t == DATA && p.Length>0) toTcp.Write(p,0,p.Length); else if (t != DATA) break; }
      } else { // tcp -> pipe: wrap in DATA
        byte[] buf = new byte[16*1024]; int r; while ((r = fromPipe.Read(buf,0,buf.Length)) > 0) { byte[] d = new byte[r]; Array.Copy(buf,0,d,0,r); WriteFrame(toTcp, DATA, d); } }
    } catch { }
    finally { try { pipe.Disconnect(); } catch {} try { tcp.Close(); } catch {} }
  }

  static PipeSecurity BuildSec(bool daclBroad, string narrowPrincipal) {
    PipeSecurity sec = new PipeSecurity();
    if (daclBroad) {
      var everyone = new SecurityIdentifier(WellKnownSidType.WorldSid, null);
      sec.AddAccessRule(new PipeAccessRule(everyone, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
    } else {
      IdentityReference who = narrowPrincipal != null ? (IdentityReference)(new NTAccount(narrowPrincipal)) : (IdentityReference)WindowsIdentity.GetCurrent().User;
      sec.AddAccessRule(new PipeAccessRule(who, PipeAccessRights.ReadWrite | PipeAccessRights.CreateNewInstance, AccessControlType.Allow));
      sec.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User, PipeAccessRights.FullControl, AccessControlType.Allow));
    }
    return sec;
  }

  static void Handle(NamedPipeServerStream pipe, string credential, string allowedHost, int allowedPort) {
    try {
      byte t; byte[] auth = ReadFrame(pipe, out t);
      if (auth == null || t != AUTH || auth.Length == 0 || auth.Length > MAX_AUTH) { WriteFrame(pipe, REJECT, Encoding.UTF8.GetBytes("malformedAuth")); return; }
      string j = Encoding.UTF8.GetString(auth);
      string cred = JsonField(j, "credential"); string dh = JsonField(j, "destHost"); string dpS = JsonField(j, "destPort");
      int dp; int.TryParse(dpS, out dp);
      if (!CredEquals(cred, credential)) { WriteFrame(pipe, REJECT, Encoding.UTF8.GetBytes("auth")); return; }
      if (dh != allowedHost || dp != allowedPort) { WriteFrame(pipe, REJECT, Encoding.UTF8.GetBytes("destNotAllowed")); return; }
      Socket tcp = new Socket(AddressFamily.InterNetwork, SocketType.Stream, ProtocolType.Tcp);
      try { tcp.Connect(allowedHost, allowedPort); } catch { WriteFrame(pipe, REJECT, Encoding.UTF8.GetBytes("upstream")); return; }
      WriteFrame(pipe, AUTH_OK, null);
      NetworkStream ns = new NetworkStream(tcp, true);
      Thread up = new Thread(() => Pump(pipe, ns, true, pipe, tcp)); up.IsBackground = true; up.Start();
      Pump(ns, pipe, false, pipe, tcp);
      up.Join(2000);
    } catch { }
    finally { try { if (pipe.IsConnected) pipe.Disconnect(); } catch {} try { pipe.Dispose(); } catch {} }
  }

  public static void Serve(string pipeName, string credential, string allowedHost, int allowedPort, bool daclBroad, string narrowPrincipal, string readyFile) {
    if (readyFile != null) { try { File.WriteAllText(readyFile, "BROKER_READY"); } catch {} }
    Console.WriteLine("BROKER_READY pipe=" + pipeName + " dest=" + allowedHost + ":" + allowedPort);
    // Always keep a listening instance: accept, dispatch to a handler thread, then immediately recreate the next
    // instance (avoids the ENOENT race where a client connects between a disconnect and the next create).
    while (true) {
      NamedPipeServerStream pipe;
      try { pipe = new NamedPipeServerStream(pipeName, PipeDirection.InOut, 8, PipeTransmissionMode.Byte, PipeOptions.None, 0, 0, BuildSec(daclBroad, narrowPrincipal)); }
      catch { Thread.Sleep(200); continue; }
      try { pipe.WaitForConnection(); }
      catch { try { pipe.Dispose(); } catch {} continue; }
      NamedPipeServerStream connected = pipe;
      Thread h = new Thread(() => Handle(connected, credential, allowedHost, allowedPort)); h.IsBackground = true; h.Start();
    }
  }
}
"@
$broad = ($DaclMode -eq 'broad')
[FusionPipeBroker]::Serve($PipeName, $Credential, $AllowedHost, [int]$AllowedPort, $broad, $NarrowPrincipal, $ReadyFile)
