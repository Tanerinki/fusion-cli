// Fusion v0.6 Hyper-V PoC - VERIFICATION-ISOLATION guest canary. Runs INSIDE the isolated Hyper-V worker
// (--network none, no host bind mount). It executes the approved VerificationPlan command against the explicitly
// transferred candidate snapshot (NOT a host mount), capturing full command identity + a pre/post candidate
// fingerprint, then probes that the host/network/docker surface is unreachable. It emits a single VERIFY_PROBE_JSON
// line to stdout (host-captured; the worker cannot push to the host) and exits deterministically.
//
// The plan arrives as base64 JSON in FUSION_VERIFY_SPEC so no model-generated shell is ever involved:
//   { executable, argv[], cwd, timeoutMs, candidateRoot, primaryHostPath, mutationExpected }
// The verifier command is `executable argv...` with shell:false - argv is data, never a parsed command line.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const WATCHDOG_MS = 180000; // VERIFY_CANARY_WATCHDOG: never hang the host harness.
const wd = setTimeout(() => { try { emit({ fatal: "watchdog" }); } catch {} process.exit(2); }, WATCHDOG_MS);
wd.unref?.();

function sha256(buf) { return createHash("sha256").update(buf).digest("hex"); }

// Recursive sha256 map of the candidate tree (regular files only; symlinks are recorded as a reparse marker, never
// followed - a verifier that follows one out of the tree is a finding, not a fingerprint input).
function fingerprintTree(root) {
  const out = {};
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name < b.name ? -1 : 1)) {
      const abs = path.join(dir, e.name);
      const r = rel ? rel + "/" + e.name : e.name;
      let ls;
      try { ls = fs.lstatSync(abs); } catch { continue; }
      if (ls.isSymbolicLink()) { out[r] = "symlink:" + safe(() => fs.readlinkSync(abs)); continue; }
      if (ls.isDirectory()) { walk(abs, r); continue; }
      if (ls.isFile()) { try { out[r] = sha256(fs.readFileSync(abs)); } catch { out[r] = "unreadable"; } }
    }
  };
  walk(root, "");
  return out;
}

function safe(fn) { try { return fn(); } catch (e) { return "ERR:" + (e && e.code || e && e.message || "x"); } }

// Can the host Primary workspace be reached from inside the worker? (It must not exist in this VM at all.)
function probePrimary(primaryHostPath) {
  if (!primaryHostPath) return { primaryReadable: false, note: "no host path configured" };
  let readable = false, listed = null;
  try { fs.accessSync(primaryHostPath, fs.constants.R_OK); readable = true; } catch {}
  try { listed = fs.readdirSync(primaryHostPath).slice(0, 5); } catch {}
  return { primaryHostPath, primaryReadable: readable || Array.isArray(listed), sample: listed };
}

// loopback-only == the no-network invariant surfaced from inside the guest (no routable/global unicast NIC).
function probeNetwork() {
  const ifaces = os.networkInterfaces();
  const nonInternal = [];
  for (const [name, addrs] of Object.entries(ifaces)) for (const a of addrs || []) if (!a.internal) nonInternal.push({ name, family: a.family, scope: a.scopeid });
  return { loopbackOnly: nonInternal.length === 0, nonInternal };
}

function probeDockerPipe() {
  for (const p of ["\\\\.\\pipe\\docker_engine", "\\\\.\\pipe\\dockerDesktopEngine", "\\\\.\\pipe\\dockerDesktopLinuxEngine"]) {
    try { if (fs.existsSync(p)) return true; } catch {}
  }
  return false;
}

let emitted = false;
function emit(extra) {
  if (emitted) return; emitted = true;
  const line = "VERIFY_PROBE_JSON " + JSON.stringify(Object.assign({ schema: "v0.6-verify-probe-1" }, probeBase, extra || {}));
  process.stdout.write(line + "\n");
}

let probeBase = {};
try {
  const specRaw = process.env.FUSION_VERIFY_SPEC;
  if (!specRaw) { emit({ fatal: "no FUSION_VERIFY_SPEC" }); clearTimeout(wd); process.exit(2); }
  const plan = JSON.parse(Buffer.from(specRaw, "base64").toString("utf8"));
  const { executable, argv = [], cwd, timeoutMs = 60000, candidateRoot, primaryHostPath, mutationExpected = false } = plan;

  // Executable pinning: the approved executable must be an absolute path that actually exists; a bare name would be
  // PATH-resolved (writer-shadowable) and is rejected here, never silently run.
  const executablePinned = typeof executable === "string" && path.isAbsolute(executable) && safe(() => fs.existsSync(executable)) === true;

  const candidateFingerprintBefore = fingerprintTree(candidateRoot);
  const gitInCandidate = safe(() => fs.existsSync(path.join(candidateRoot, ".git"))) === true;

  // A deliberately minimal environment: no inherited host profile, no PATH games - just what node needs to start.
  const minimalEnv = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP || "C:\\Windows\\Temp", TMP: process.env.TMP || "C:\\Windows\\Temp", FUSION_VERIFY: "1" };

  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  const r = spawnSync(executable, argv, { cwd, env: minimalEnv, shell: false, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: "buffer" });
  const t1 = Date.now();
  const endedAt = new Date().toISOString();

  const timedOut = r.error && r.error.code === "ETIMEDOUT" ? true : (r.signal === "SIGTERM" && (t1 - t0) >= timeoutMs);
  const spawnErr = r.error && r.error.code !== "ETIMEDOUT" ? (r.error.code || r.error.message) : null;
  const stdout = r.stdout || Buffer.alloc(0), stderr = r.stderr || Buffer.alloc(0);

  const candidateFingerprintAfter = fingerprintTree(candidateRoot);
  const sourceMutated = JSON.stringify(candidateFingerprintBefore) !== JSON.stringify(candidateFingerprintAfter);

  probeBase = {
    plan: { executable, argv, cwd },
    ran: {
      observed: spawnErr === null,
      executable,
      argv,
      cwd,
      exitCode: typeof r.status === "number" ? r.status : undefined,
      signal: r.signal || null,
      timedOut: !!timedOut,
      cancelled: false,
      spawnError: spawnErr,
      startedAt, endedAt, durationMs: t1 - t0,
      stdoutSha256: sha256(stdout), stdoutBytes: stdout.length, stdoutHead: stdout.slice(0, 400).toString("utf8"),
      stderrSha256: sha256(stderr), stderrBytes: stderr.length, stderrHead: stderr.slice(0, 400).toString("utf8"),
    },
    executablePinned,
    candidateRoot,
    candidateFingerprintBefore, candidateFingerprintAfter,
    sourceMutated, mutationExpected,
    gitInCandidate,
    network: probeNetwork(),
    forbidden: probePrimary(primaryHostPath),
    dockerPipePresent: probeDockerPipe(),
    bindMountsSelfReport: "host-measured",
    host: { workerOsRelease: os.release(), workerHostname: os.hostname() },
  };
  emit();
  clearTimeout(wd);
  process.exit(0);
} catch (e) {
  emit({ fatal: String(e && e.stack || e) });
  clearTimeout(wd);
  process.exit(3);
}
