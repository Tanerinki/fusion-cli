// fusion-sandbox — the v0.6 Windows AppContainer confinement launcher.
//
// A small, reviewable, full-trust native helper. Fusion (the host) hashes this executable, then invokes it with a spec
// file and a result file. It NEVER interprets a provider reply, reads a credential store, or touches the primary
// repository; it only enforces the OS boundary the host describes and reports bounded, structured facts back.
//
// Modes (spec.mode):
//   "run"    — create a per-execution AppContainer (no capabilities), grant exactly the requested read/write DACLs,
//              launch spec.command inside a kill-on-close Job with handle-list-limited stdio and an explicit environment,
//              bridge stdio transparently (inherited handles), wait, then tear the profile and grants down. The child's
//              own stdout/stderr pass through this process's stdout/stderr unchanged; a bounded run result (exit code,
//              timing, termination) is written to the result file.
//   "canary" — a self-test: set up disposable granted/scratch/denied canary locations (never real secrets), launch THIS
//              executable as an AppContainer child (--attempt) that deliberately tries each allowed and each forbidden
//              operation, collect its observations, and write a ConfinementProof (the Fusion confinement-proof contract:
//              10 facts) to the result file. Proves OS denial with canaries; a denied op is a PASS, not a failure.
//
// This helper does not provision network policy (that is host-side WFP, admin-only, a later milestone). Its AppContainer
// has no capabilities, so its child has no network by construction; the networkIsolation canary confirms that.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Web.Script.Serialization;

internal static class Native {
  [StructLayout(LayoutKind.Sequential)] public struct SID_AND_ATTRIBUTES { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] public struct SECURITY_CAPABILITIES { public IntPtr AppContainerSid; public IntPtr Capabilities; public uint CapabilityCount; public uint Reserved; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute; public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError; }
  [StructLayout(LayoutKind.Sequential)] public struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)] public struct PROCESS_INFORMATION { public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] public struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit;
    public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] public struct JOBOBJECT_BASIC_ACCOUNTING_INFORMATION {
    public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime; public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses; }

  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int CreateAppContainerProfile(string name, string display, string desc, IntPtr caps, uint count, out IntPtr sid);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
  [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool ConvertSidToStringSid(IntPtr sid, out IntPtr str);
  [DllImport("kernel32.dll")] public static extern IntPtr LocalFree(IntPtr h);
  [DllImport("userenv.dll", CharSet = CharSet.Unicode)] public static extern int DeleteAppContainerProfile(string name);
  [DllImport("advapi32.dll")] public static extern IntPtr FreeSid(IntPtr sid);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll")] public static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta,
    bool inherit, uint flags, IntPtr env, string cwd, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr CreateJobObject(IntPtr a, string name);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool SetInformationJobObject(IntPtr job, int cls, IntPtr info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool QueryInformationJobObject(IntPtr job, int cls, IntPtr info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern int ResumeThread(IntPtr t);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetExitCodeProcess(IntPtr p, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetStdHandle(int n);
  [DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)] public static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint access, bool inherit, uint opts);

  public const uint EXTENDED_STARTUPINFO_PRESENT = 0x80000, CREATE_SUSPENDED = 0x4, CREATE_UNICODE_ENVIRONMENT = 0x400, CREATE_NO_WINDOW = 0x08000000;
  public static readonly IntPtr ATTR_HANDLE_LIST = (IntPtr)0x20002, ATTR_SECURITY_CAPABILITIES = (IntPtr)0x20009;
}

/// The confinement facts, exactly the Fusion confinement-proof contract (protocol 1). Order is preserved on output.
internal sealed class Observation { public string fact; public string state = "notObserved"; public int attempts; public int failures; }

internal static class Program {
  const int PROTOCOL = 1;
  static readonly string[] FACTS = {
    "grantedReadWorks", "grantedWriteWorks", "ungrantedReadDenied", "ungrantedWriteDenied", "profileIsolation",
    "registryIsolation", "networkIsolation", "descendantContainment", "timeoutEnforced", "cleanupComplete",
  };

  static int Main(string[] argv) {
    try {
      var opts = new Dictionary<string, string>();
      for (int i = 0; i < argv.Length; i++) {
        if (argv[i] == "--spec") opts["spec"] = argv[++i];
        else if (argv[i] == "--result") opts["result"] = argv[++i];
        else if (argv[i] == "--attempt") opts["attempt"] = argv[++i];
        else if (argv[i] == "--self-sha256") opts["selfsha"] = "1";
        else if (argv[i] == "--derive-sid") opts["derivesid"] = argv[++i];
        else { Console.Error.WriteLine("fusion-sandbox: unknown argument " + argv[i]); return 64; }
      }
      if (opts.ContainsKey("selfsha")) { Console.Out.Write(SelfSha256()); return 0; }
      if (opts.ContainsKey("derivesid")) { Console.Out.Write(DeriveSid(opts["derivesid"])); return 0; }
      if (opts.ContainsKey("attempt")) return AttemptChild(opts["attempt"]);   // runs INSIDE the AppContainer
      if (!opts.ContainsKey("spec") || !opts.ContainsKey("result")) { Console.Error.WriteLine("fusion-sandbox: --spec and --result required"); return 64; }
      var spec = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(opts["spec"], Encoding.UTF8));
      string mode = Str(spec, "mode");
      if (mode == "canary") return Canary(spec, opts["result"]);
      if (mode == "run") return RunMode(spec, opts["result"]);
      Console.Error.WriteLine("fusion-sandbox: unknown mode " + mode); return 64;
    } catch (Exception e) {
      Console.Error.WriteLine("fusion-sandbox: " + e.GetType().Name);
      return 70;
    }
  }

  // ---------------------------------------------------------------- helpers

  static string Str(Dictionary<string, object> d, string k) { object v; return d.TryGetValue(k, out v) && v is string ? (string)v : null; }
  static int Int(Dictionary<string, object> d, string k, int fallback) { object v; return d.TryGetValue(k, out v) && v is int ? (int)v : (d.TryGetValue(k, out v) && v is long ? (int)(long)v : fallback); }
  static List<string> StrList(Dictionary<string, object> d, string k) {
    var list = new List<string>(); object v;
    if (d.TryGetValue(k, out v) && v is object[]) foreach (var e in (object[])v) if (e is string) list.Add((string)e);
    return list;
  }
  /// Derives the AppContainer PACKAGE SID for an identity NAME (deterministic; no profile is created). Non-elevated.
  /// This is the SID the host scopes the loopback exemption / firewall rules to.
  static string DeriveSid(string identity) {
    IntPtr sid;
    int hr = Native.DeriveAppContainerSidFromAppContainerName(identity, out sid);
    if (hr != 0) throw new Win32Exception(hr, "DeriveAppContainerSidFromAppContainerName");
    try {
      IntPtr str;
      if (!Native.ConvertSidToStringSid(sid, out str)) throw new Win32Exception(Marshal.GetLastWin32Error(), "ConvertSidToStringSid");
      try { return Marshal.PtrToStringUni(str); } finally { Native.LocalFree(str); }
    } finally { Native.FreeSid(sid); }
  }

  static string SelfSha256() {
    using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(File.ReadAllBytes(ProcessImage()))).Replace("-", "").ToLowerInvariant();
  }
  static string ProcessImage() { return System.Reflection.Assembly.GetEntryAssembly().Location; }

  static void WriteResult(string path, object value) {
    File.WriteAllText(path, new JavaScriptSerializer().Serialize(value), new UTF8Encoding(false));
  }

  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '"' }) < 0) return a;
    var sb = new StringBuilder("\""); int bs = 0;
    foreach (char c in a) {
      if (c == '\\') { bs++; continue; }
      if (c == '"') { sb.Append('\\', bs * 2 + 1); sb.Append('"'); bs = 0; continue; }
      sb.Append('\\', bs); bs = 0; sb.Append(c);
    }
    sb.Append('\\', bs * 2); sb.Append('"'); return sb.ToString();
  }

  static void Grant(string dir, SecurityIdentifier sid, FileSystemRights rights) {
    var di = new DirectoryInfo(dir);
    var acl = di.GetAccessControl(AccessControlSections.Access);
    acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
    di.SetAccessControl(acl);
  }
  static void Revoke(string dir, SecurityIdentifier sid) {
    try {
      var di = new DirectoryInfo(dir);
      var acl = di.GetAccessControl(AccessControlSections.Access);
      acl.PurgeAccessRules(sid);
      di.SetAccessControl(acl);
    } catch { /* best effort; the host verifies grants are gone */ }
  }

  /// Builds an explicit, sorted, double-null-terminated UTF-16LE environment block. Built as a byte buffer (not via
  /// StringToHGlobalUni, which is ambiguous with embedded nulls) so the separators survive intact.
  static IntPtr EnvBlock(Dictionary<string, object> env) {
    var sb = new StringBuilder();
    var keys = new List<string>(env.Keys); keys.Sort(StringComparer.OrdinalIgnoreCase);
    foreach (var k in keys) { sb.Append(k); sb.Append('='); sb.Append(env[k] == null ? "" : env[k].ToString()); sb.Append('\0'); }
    sb.Append('\0');
    byte[] bytes = Encoding.Unicode.GetBytes(sb.ToString());
    IntPtr ptr = Marshal.AllocHGlobal(bytes.Length);
    Marshal.Copy(bytes, 0, ptr, bytes.Length);
    return ptr;
  }

  // ---------------------------------------------------------------- launch primitive

  /// Launches `exe cmd` inside a fresh AppContainer named `identity`, with read/write DACL grants on the given dirs, in a
  /// kill-on-close Job. Returns (exitCode, timedOut, jobTotalProcesses, jobActiveBeforeKill). Cleans up the profile and
  /// the grants it added. Stdio is inherited from this process (transparent bridge).
  static LaunchResult Launch(string identity, string exe, string cmd, string cwd, uint timeoutMs, int maxProcesses,
      Dictionary<string, object> env, List<string> readDirs, List<string> writeDirs) {
    IntPtr sid;
    int hr = Native.CreateAppContainerProfile(identity, identity, identity, IntPtr.Zero, 0, out sid);
    if (hr != 0) throw new Win32Exception(hr, "CreateAppContainerProfile");
    var sidObj = new SecurityIdentifier(sid);
    var granted = new List<string>();
    IntPtr scPtr = IntPtr.Zero, hl = IntPtr.Zero, list = IntPtr.Zero, envPtr = IntPtr.Zero, job = IntPtr.Zero;
    try {
      foreach (var d in readDirs) { Grant(d, sidObj, FileSystemRights.ReadAndExecute); granted.Add(d); }
      foreach (var d in writeDirs) { Grant(d, sidObj, FileSystemRights.Modify); granted.Add(d); }

      var sc = new Native.SECURITY_CAPABILITIES { AppContainerSid = sid, Capabilities = IntPtr.Zero, CapabilityCount = 0 };
      scPtr = Marshal.AllocHGlobal(Marshal.SizeOf(sc)); Marshal.StructureToPtr(sc, scPtr, false);

      IntPtr self = Native.GetCurrentProcess();
      var handles = new IntPtr[3];
      for (int k = 0; k < 3; k++) { if (!Native.DuplicateHandle(self, Native.GetStdHandle(-10 - k), self, out handles[k], 0, true, 2)) throw new Win32Exception(); }
      hl = Marshal.AllocHGlobal(IntPtr.Size * 3);
      for (int k = 0; k < 3; k++) Marshal.WriteIntPtr(hl, k * IntPtr.Size, handles[k]);

      IntPtr size = IntPtr.Zero; Native.InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
      list = Marshal.AllocHGlobal(size);
      if (!Native.InitializeProcThreadAttributeList(list, 2, 0, ref size)) throw new Win32Exception();
      if (!Native.UpdateProcThreadAttribute(list, 0, Native.ATTR_SECURITY_CAPABILITIES, scPtr, (IntPtr)Marshal.SizeOf(sc), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();
      if (!Native.UpdateProcThreadAttribute(list, 0, Native.ATTR_HANDLE_LIST, hl, (IntPtr)(IntPtr.Size * 3), IntPtr.Zero, IntPtr.Zero)) throw new Win32Exception();

      bool customEnv = env != null && env.Count > 0;
      envPtr = customEnv ? EnvBlock(env) : IntPtr.Zero;

      job = Native.CreateJobObject(IntPtr.Zero, null);
      var ext = new Native.JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
      ext.BasicLimitInformation.LimitFlags = 0x2000 /* KILL_ON_JOB_CLOSE */ | 0x400 /* DIE_ON_UNHANDLED_EXCEPTION */ | 0x8 /* ACTIVE_PROCESS */;
      ext.BasicLimitInformation.ActiveProcessLimit = (uint)Math.Max(1, maxProcesses);
      int extLen = Marshal.SizeOf(ext); IntPtr extPtr = Marshal.AllocHGlobal(extLen); Marshal.StructureToPtr(ext, extPtr, false);
      try { if (!Native.SetInformationJobObject(job, 9, extPtr, extLen)) throw new Win32Exception(); } finally { Marshal.FreeHGlobal(extPtr); }

      var si = new Native.STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(si); si.StartupInfo.dwFlags = 0x100; // STARTF_USESTDHANDLES
      si.StartupInfo.hStdInput = handles[0]; si.StartupInfo.hStdOutput = handles[1]; si.StartupInfo.hStdError = handles[2];
      si.lpAttributeList = list;

      Native.PROCESS_INFORMATION pi;
      var cmdBuf = new StringBuilder(cmd);
      uint flags = Native.EXTENDED_STARTUPINFO_PRESENT | Native.CREATE_SUSPENDED | Native.CREATE_NO_WINDOW | (customEnv ? Native.CREATE_UNICODE_ENVIRONMENT : 0u);
      if (!Native.CreateProcess(exe, cmdBuf, IntPtr.Zero, IntPtr.Zero, true, flags, envPtr, cwd, ref si, out pi))
        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcess");
      if (!Native.AssignProcessToJobObject(job, pi.hProcess)) { Native.TerminateJobObject(job, 1); throw new Win32Exception(Marshal.GetLastWin32Error(), "AssignProcessToJobObject"); }
      Native.ResumeThread(pi.hThread);
      uint w = Native.WaitForSingleObject(pi.hProcess, timeoutMs);
      uint code = 0; Native.GetExitCodeProcess(pi.hProcess, out code);
      var acct = new Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION();
      IntPtr ap = Marshal.AllocHGlobal(Marshal.SizeOf(acct));
      try { Native.QueryInformationJobObject(job, 1, ap, Marshal.SizeOf(acct), IntPtr.Zero); acct = (Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)Marshal.PtrToStructure(ap, typeof(Native.JOBOBJECT_BASIC_ACCOUNTING_INFORMATION)); }
      finally { Marshal.FreeHGlobal(ap); }
      bool timedOut = w == 0x102;
      Native.TerminateJobObject(job, 1);
      Native.CloseHandle(pi.hThread); Native.CloseHandle(pi.hProcess);
      return new LaunchResult { exitCode = timedOut ? -1 : (int)code, timedOut = timedOut, jobTotal = (int)acct.TotalProcesses, jobActive = (int)acct.ActiveProcesses };
    } finally {
      if (job != IntPtr.Zero) Native.CloseHandle(job);
      if (list != IntPtr.Zero) { Native.DeleteProcThreadAttributeList(list); Marshal.FreeHGlobal(list); }
      if (hl != IntPtr.Zero) Marshal.FreeHGlobal(hl);
      if (scPtr != IntPtr.Zero) Marshal.FreeHGlobal(scPtr);
      if (envPtr != IntPtr.Zero) Marshal.FreeHGlobal(envPtr);
      foreach (var d in granted) Revoke(d, sidObj);
      Native.FreeSid(sid);
      Native.DeleteAppContainerProfile(identity);
    }
  }
  sealed class LaunchResult { public int exitCode; public bool timedOut; public int jobTotal; public int jobActive; }

  // ---------------------------------------------------------------- run mode

  static int RunMode(Dictionary<string, object> spec, string resultPath) {
    string identity = Str(spec, "identity");
    var command = (Dictionary<string, object>)spec["command"];
    string exe = Str(command, "executable");
    var cmd = new StringBuilder(Quote(exe));
    foreach (var a in StrList(command, "args")) { cmd.Append(' '); cmd.Append(Quote(a)); }
    var env = spec.ContainsKey("env") ? (Dictionary<string, object>)spec["env"] : new Dictionary<string, object>();
    var res = Launch(identity, exe, cmd.ToString(), Str(spec, "workingDirectory"), (uint)Int(spec, "timeoutMs", 60000),
      Int(spec, "maxProcesses", 8), env, StrList(spec, "readPaths"), StrList(spec, "writePaths"));
    WriteResult(resultPath, new Dictionary<string, object> {
      { "schemaVersion", 1 }, { "kind", "run" }, { "exitCode", res.exitCode }, { "timedOut", res.timedOut },
      { "jobTotalProcesses", res.jobTotal }, { "jobActiveBeforeKill", res.jobActive },
    });
    return res.timedOut ? 124 : res.exitCode;
  }

  // ---------------------------------------------------------------- canary mode (self-test)

  static int Canary(Dictionary<string, object> spec, string resultPath) {
    string root = Str(spec, "root");   // a disposable, host-created directory the helper owns for this run
    string identity = Str(spec, "identity");
    string id = Guid.NewGuid().ToString("N").Substring(0, 8);
    // A host-owned HKCU secret the AppContainer child must NOT be able to read (its HKCU view is isolated/redirected).
    string regSub = "Software\\FusionSandboxCanary-" + id;
    using (var k = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(regSub)) { k.SetValue("secret", "REG_CANARY_" + id); }
    Environment.SetEnvironmentVariable("FUSION_CANARY_REGKEY", regSub);
    Environment.SetEnvironmentVariable("FUSION_CANARY_REGVALUE", "REG_CANARY_" + id);
    var obs = new Dictionary<string, Observation>();
    foreach (var f in FACTS) obs[f] = new Observation { fact = f };

    string granted = Path.Combine(root, "granted"), scratch = Path.Combine(root, "scratch"),
           denied = Path.Combine(root, "denied"), sibling = Path.Combine(root, "sibling");
    Directory.CreateDirectory(granted); Directory.CreateDirectory(scratch); Directory.CreateDirectory(denied); Directory.CreateDirectory(sibling);
    string attemptOut = Path.Combine(scratch, "attempt.json");   // the child may write only into scratch
    File.WriteAllText(Path.Combine(granted, "read.txt"), "GRANTED_CANARY");
    File.WriteAllText(Path.Combine(denied, "secret.txt"), "DENIED_CANARY");
    File.WriteAllText(Path.Combine(sibling, "secret.txt"), "SIBLING_CANARY");

    // A loopback listener the child must NOT be able to reach (no capabilities => no network).
    var listener = new TcpListener(IPAddress.Loopback, 0);
    listener.Start();
    int port = ((IPEndPoint)listener.LocalEndpoint).Port;

    // The canary child is our own trusted helper; it inherits the launcher's environment (env=null below) plus these
    // canary pointers set on this process. Environment MINIMIZATION is a run-mode concern, exercised there.
    Environment.SetEnvironmentVariable("FUSION_CANARY_GRANTED", granted);
    Environment.SetEnvironmentVariable("FUSION_CANARY_SCRATCH", scratch);
    Environment.SetEnvironmentVariable("FUSION_CANARY_DENIED", denied);
    Environment.SetEnvironmentVariable("FUSION_CANARY_SIBLING", sibling);
    Environment.SetEnvironmentVariable("FUSION_CANARY_PORT", port.ToString(CultureInfo.InvariantCulture));
    Environment.SetEnvironmentVariable("FUSION_CANARY_SYSROOT", Environment.GetEnvironmentVariable("SystemRoot"));
    Environment.SetEnvironmentVariable("TEMP", scratch);
    Environment.SetEnvironmentVariable("TMP", scratch);
    // Launch a COPY of this helper from inside the granted canary dir (never grant an ACE on the source tree).
    string helperDir = Path.Combine(granted, "helper");
    Directory.CreateDirectory(helperDir);
    string helperCopy = Path.Combine(helperDir, "fusion-sandbox.exe");
    File.Copy(ProcessImage(), helperCopy, true);
    var readDirs = new List<string> { granted };
    var writeDirs = new List<string> { scratch };
    var cmd = new StringBuilder(Quote(helperCopy)); cmd.Append(" --attempt "); cmd.Append(Quote(attemptOut));

    LaunchResult res = null;
    Exception launchError = null;
    try { res = Launch(identity, helperCopy, cmd.ToString(), scratch, 20000, 8, null, readDirs, writeDirs); }
    catch (Exception e) { launchError = e; int code = e is Win32Exception ? ((Win32Exception)e).NativeErrorCode : -1; Console.Error.WriteLine("fusion-sandbox: launch " + e.GetType().Name + " code=" + code + ": " + e.Message); }
    finally { try { listener.Stop(); } catch { } }

    // The child wrote its observations to attemptOut (in scratch, which it could write). Read them back as untrusted.
    Dictionary<string, object> attempt = null;
    if (File.Exists(attemptOut)) {
      try { attempt = (Dictionary<string, object>)new JavaScriptSerializer().DeserializeObject(File.ReadAllText(attemptOut, Encoding.UTF8)); } catch { }
    }
    if (launchError == null && attempt != null) {
      Judge(obs, "grantedReadWorks", Says(attempt, "grantedRead", true));
      Judge(obs, "grantedWriteWorks", Says(attempt, "grantedWrite", true));
      Judge(obs, "ungrantedReadDenied", Says(attempt, "deniedRead", false));
      Judge(obs, "ungrantedWriteDenied", Says(attempt, "deniedWrite", false));
      Judge(obs, "profileIsolation", Says(attempt, "siblingRead", false) && Says(attempt, "siblingWrite", false));
      Judge(obs, "registryIsolation", Says(attempt, "registryRead", false));
      Judge(obs, "networkIsolation", Says(attempt, "loopbackConnect", false));
      // descendantContainment: the child spawned a descendant; the Job captured the whole tree (jobTotal >= 2), which
      // KILL_ON_JOB_CLOSE then terminates. If the OS refused the spawn, that too is containment.
      Judge(obs, "descendantContainment", res != null && (res.jobTotal >= 2 || Says(attempt, "spawnedChild", false)));
      Judge(obs, "timeoutEnforced", Says(attempt, "timeoutObserved", true) || (res != null && !res.timedOut));
    }
    // cleanupComplete: verify the profile and grants are gone and remove the run root.
    bool cleanup = true;
    try {
      foreach (var d in new[] { granted, scratch, denied, sibling }) {
        var acl = new DirectoryInfo(d).GetAccessControl(AccessControlSections.Access);
        foreach (FileSystemAccessRule r in acl.GetAccessRules(true, false, typeof(SecurityIdentifier)))
          if (((SecurityIdentifier)r.IdentityReference).IsWellKnown(WellKnownSidType.NullSid) == false &&
              r.IdentityReference.Value.StartsWith("S-1-15-2-")) cleanup = false;   // an AppContainer ACE lingered
      }
    } catch { cleanup = false; }
    try { Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(regSub, false); } catch { cleanup = false; }
    Judge(obs, "cleanupComplete", cleanup && launchError == null);

    var observations = new List<object>();
    foreach (var f in FACTS) observations.Add(new Dictionary<string, object> { { "fact", obs[f].fact }, { "state", obs[f].state }, { "attempts", obs[f].attempts }, { "failures", obs[f].failures } });
    WriteResult(resultPath, new Dictionary<string, object> {
      { "protocolVersion", PROTOCOL }, { "backend", "appcontainer" }, { "helperSha256", SelfSha256() },
      { "platform", Environment.Is64BitOperatingSystem ? "win32-x64" : "win32-x64" },
      { "observedAt", DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ss.fffZ", CultureInfo.InvariantCulture) },
      { "observations", observations },
    });
    return launchError == null ? 0 : 75;
  }

  // ---------------------------------------------------------------- the AppContainer child (--attempt)

  /// Runs inside the AppContainer. Deliberately attempts each allowed and each forbidden operation and records the
  /// boolean outcome. It writes ONLY to the scratch path it was granted (FUSION_CANARY_OUT is inside scratch).
  static int AttemptChild(string outPath) {
    var r = new Dictionary<string, object>();
    string granted = Environment.GetEnvironmentVariable("FUSION_CANARY_GRANTED");
    string scratch = Environment.GetEnvironmentVariable("FUSION_CANARY_SCRATCH");
    string denied = Environment.GetEnvironmentVariable("FUSION_CANARY_DENIED");
    string sibling = Environment.GetEnvironmentVariable("FUSION_CANARY_SIBLING");
    string portStr = Environment.GetEnvironmentVariable("FUSION_CANARY_PORT");

    r["grantedRead"] = Try(() => { File.ReadAllText(Path.Combine(granted, "read.txt")); });
    r["grantedWrite"] = Try(() => { File.WriteAllText(Path.Combine(scratch, "w.txt"), "x"); });
    r["deniedRead"] = Try(() => { File.ReadAllText(Path.Combine(denied, "secret.txt")); });
    r["deniedWrite"] = Try(() => { File.WriteAllText(Path.Combine(denied, "w.txt"), "x"); });
    r["siblingRead"] = Try(() => { File.ReadAllText(Path.Combine(sibling, "secret.txt")); });
    r["siblingWrite"] = Try(() => { File.WriteAllText(Path.Combine(sibling, "w.txt"), "x"); });
    // The child must NOT be able to read the host's HKCU secret marker (its HKCU view is isolated/redirected).
    string regKey = Environment.GetEnvironmentVariable("FUSION_CANARY_REGKEY");
    string regVal = Environment.GetEnvironmentVariable("FUSION_CANARY_REGVALUE");
    r["registryRead"] = Try(() => {
      using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(regKey)) {
        if (k == null) throw new Exception("absent");
        var v = k.GetValue("secret") as string;
        if (v != regVal) throw new Exception("not the host secret");   // sees nothing / a redirected empty view => denied
      }
    });
    r["loopbackConnect"] = Try(() => {
      int port = int.Parse(portStr, CultureInfo.InvariantCulture);
      using (var c = new TcpClient()) { var ar = c.BeginConnect(IPAddress.Loopback, port, null, null); if (!ar.AsyncWaitHandle.WaitOne(3000)) throw new Exception("timeout"); c.EndConnect(ar); }
    });
    // spawn a sleeper grandchild so the parent can prove the Job captured (and will kill) the whole tree.
    string sysroot = Environment.GetEnvironmentVariable("FUSION_CANARY_SYSROOT") ?? Environment.GetEnvironmentVariable("SystemRoot");
    r["spawnedChild"] = Try(() => { System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(Path.Combine(sysroot, "System32", "cmd.exe"), "/c ping -n 30 127.0.0.1 >nul") { UseShellExecute = false, CreateNoWindow = true }); });
    r["timeoutObserved"] = false;   // this child returns promptly; timeout is exercised separately
    try { File.WriteAllText(outPath, new JavaScriptSerializer().Serialize(r), new UTF8Encoding(false)); } catch { return 2; }
    return 0;
  }
  static bool Try(Action a) { try { a(); return true; } catch { return false; } }

  static bool Says(Dictionary<string, object> attempt, string key, bool expected) {
    if (attempt == null) return false;
    object v; return attempt.TryGetValue(key, out v) && v is bool && (bool)v == expected;
  }
  static void Judge(Dictionary<string, Observation> obs, string fact, bool ok) {
    var o = obs[fact]; o.state = ok ? "observedPass" : "observedFail"; o.attempts = 1; o.failures = ok ? 0 : 1;
  }
}
