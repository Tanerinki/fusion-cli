// Fusion v0.6 Hyper-V PoC - FILESYSTEM-DIMENSION evaluator (pure, unit-tested). Turns the guest FS canary evidence +
// the host-side Primary-Workspace fingerprints + the result-transfer validation into the three independent verdicts
// FILESYSTEM_BOUNDARY, PRIMARY_WORKSPACE_PROTECTION, VERIFICATION_ISOLATION. UNKNOWN/ERROR/NOT_RUN is NEVER a PASS.
//
// Security model: the worker is a separate Hyper-V VM with NO host bind mount, so the host filesystem is not present in
// the VM. A write that SUCCEEDS inside the VM's own disposable C:\ is harmless (the VM is thrown away); the only thing
// that matters is that NOTHING reaches host/Primary state. So an "ok" write is only an ESCAPE when it reaches a real
// host path - which the independent host-side Primary fingerprint (before==after) authoritatively settles.

const PASS = "PASS", FAIL = "FAIL", INCOMPLETE = "INCOMPLETE";

/** true if a write-attempt outcome is a definitive OS denial (never a silent pass for other codes). */
function denied(w) {
  if (!w || typeof w !== "object") return false;
  if (w.outcome === "denied") return true;
  return false;
}

/**
 * FILESYSTEM_BOUNDARY: the approved workspace is writable AND no host/Primary filesystem surface is reachable from the
 * worker, by any path shape or reparse trick. Requires the structural facts (host Primary path NOT present in the VM,
 * no host .git reachable, no docker control pipe) AND that every Primary-targeting write/reparse is denied.
 */
export function filesystemBoundaryVerdict(probe) {
  const p = probe ?? {};
  const reasons = [];
  const f = p.facts ?? {};
  const neg = p.negatives ?? {};
  const git = p.git ?? {};
  const rep = p.reparse ?? {};

  if (p.positive?.outcome !== "ok") reasons.push(`positive workspace write not ok (${p.positive?.outcome ?? "NOT_RUN"})`);
  if (f.primaryWorkspacePathExists !== false) reasons.push("the host Primary-Workspace path is present/visible inside the worker");
  if (f.gitDirExists !== false) reasons.push("a .git directory is reachable inside the worker");
  if (neg.N14_dockerEnginePipe?.exists !== false) reasons.push("the docker engine control pipe is present inside the worker");

  // Every Primary-targeting negative write must be denied (the host path does not exist in the VM => ENOENT/denied).
  for (const k of ["N1_primaryWriteExisting", "N3_primaryCreateNew", "N6_primaryAbsolute", "N7_extendedLength", "N8_uncAdminShare", "N13_hostRepoParent", "N15_fusionHostControl"]) {
    const e = neg[k];
    if (!e) { reasons.push(`${k}: NOT_RUN`); continue; }
    if (!denied(e.write)) {
      // an "ok" write is only an escape if it landed on a real host path (targetsPrimary + a drive-abs that is NOT the VM's own disposable tree). We flag any non-denied Primary-targeting write for review.
      reasons.push(`${k}: write not denied (${e.write?.outcome}); landed=${JSON.stringify(e.write?.landedReal ?? null)}`);
    }
  }
  // Git shared-state writes to the (absent) host repo must be denied.
  if (git.primaryGitReachable !== false) reasons.push("the host Primary .git is reachable");
  if (!denied(git.canWritePrimaryGitConfig)) reasons.push("writing the host Primary .git/config was not denied");
  if (!denied(git.canWritePrimaryGitHooks)) reasons.push("writing a host Primary .git hook was not denied");

  // Reparse: no self-created or pre-seeded reparse may resolve to a host Primary path AND be written through.
  const escViaReparse = entry => entry && entry.writeThrough && entry.writeThrough.outcome === "ok" && entry.resolvesTo && entry.resolvesTo.targetsPrimary;
  if (escViaReparse(rep.preSeeded)) reasons.push("a pre-seeded reparse escaped to the host Primary (write-through ok)");
  for (const [name, e] of Object.entries(rep.selfCreated ?? {})) if (escViaReparse(e)) reasons.push(`self-created reparse ${name} escaped to the host Primary`);

  return { verdict: reasons.length === 0 ? PASS : FAIL, reasons };
}

/**
 * PRIMARY_WORKSPACE_PROTECTION: an INDEPENDENT host-side proof that the untrusted worker mutated nothing in the Primary
 * Workspace. before/after are bounded state manifests (git porcelain + tracked-hash summary + key admin-file hashes).
 * PASS only when both are present and byte-identical. A missing fingerprint is INCOMPLETE (never PASS).
 */
export function primaryWorkspaceProtectionVerdict(before, after) {
  if (!before || !after) return { verdict: INCOMPLETE, reasons: ["a Primary fingerprint (before/after) is missing"], mutated: null };
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const diffs = [];
  for (const k of keys) if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) diffs.push(k);
  const mutated = diffs.length > 0;
  return { verdict: mutated ? FAIL : PASS, reasons: mutated ? diffs.map(k => `Primary fingerprint field changed: ${k}`) : [], mutated };
}

/**
 * VERIFICATION_ISOLATION: verifying untrusted writer output is itself untrusted-code execution, so it must run inside a
 * fresh isolated worker (same Hyper-V + --network none + no host mount), NEVER directly on the trusted host, and the
 * command identity/argv/cwd/env must be host-owned. `model` describes the actual execution plan.
 */
export function verificationIsolationVerdict(model) {
  const m = model ?? {};
  const reasons = [];
  if (m.executesOnHost === true) reasons.push("verification executes untrusted output directly on the trusted host");
  if (m.isolatedWorker !== true) reasons.push("verification is not run inside an isolated Hyper-V worker");
  if (m.commandIdentityHostOwned !== true) reasons.push("the verification command identity/argv is not host-owned");
  if (m.cwdHostControlled !== true) reasons.push("the verification cwd is not host-controlled");
  if (m.envHostControlled !== true) reasons.push("the verification environment is not host-controlled");
  if (m.executableResolutionPinned !== true) reasons.push("executable resolution is not pinned (writer-controlled PATH/shadowing possible)");
  if (m.prePostStateMeasured !== true) reasons.push("verification pre/post filesystem state is not measured");
  return { verdict: reasons.length === 0 ? PASS : FAIL, reasons };
}

/**
 * ISOLATED VERIFICATION verdict (the Windows-required Hyper-V verification-isolation gate). Derived from the REAL
 * evidence a verify worker produced - never from a hardcoded flag. Verification of untrusted writer output is itself
 * untrusted-code execution, so it must run inside a fresh --network none, no-host-mount Hyper-V worker, against an
 * explicitly transferred candidate snapshot, with a command that came from the approved VerificationPlan (not model
 * shell), a pinned absolute executable, a controlled cwd, pre/post candidate fingerprints, and no reachable host/
 * network/docker surface. Returns { verdict, reasons, sourceMutationDetected }. UNKNOWN/missing is never a PASS.
 */
export function isolatedVerificationVerdict(probe) {
  const p = probe ?? {};
  const ran = p.ran ?? {};
  const plan = p.plan ?? {};

  // --- STRUCTURAL isolation invariants: these must hold regardless of what the verifier itself returned. If ANY of
  //     them fails the run is an isolation BREACH and can never be a PASS, even if the command exited 0. ---
  const isolationReasons = [];
  if (ran.observed !== true) isolationReasons.push("the verifier run was not observed inside the worker");
  if (ran.executable !== plan.executable) isolationReasons.push("the executable run did not match the approved plan");
  if (JSON.stringify(ran.argv) !== JSON.stringify(plan.argv)) isolationReasons.push("the argv run did not match the approved plan");
  if (ran.cwd !== plan.cwd) isolationReasons.push("the cwd was not the approved plan's cwd");
  if (p.executablePinned !== true) isolationReasons.push("executable resolution is not pinned to the approved absolute path");
  if (!p.candidateFingerprintBefore || !p.candidateFingerprintAfter) isolationReasons.push("candidate pre/post fingerprint was not measured");
  if (p.network?.loopbackOnly !== true) isolationReasons.push("the worker network was not loopback-only (no-network invariant)");
  if (p.bindMounts !== 0) isolationReasons.push(`the worker had ${p.bindMounts} bind mount(s) (must be 0)`);
  if (p.forbidden?.primaryReadable !== false) isolationReasons.push("the host Primary workspace was readable from the verifier");
  if (p.dockerPipePresent !== false) isolationReasons.push("the docker engine pipe was present in the verifier");
  const isolationIntact = isolationReasons.length === 0;
  const sourceMutationDetected = p.sourceMutated === true;

  // --- OUTCOME classification (evidence-derived, DISTINCT labels - a timeout is never a generic failure, a mutation is
  //     never a plain non-zero exit). Only `verified` (isolation intact + completed + exit 0 + unmutated) is a PASS. ---
  const reasons = [...isolationReasons];
  let outcome;
  if (!isolationIntact) {
    outcome = "isolation-breach";
  } else if (ran.cancelled === true) {
    outcome = "cancelled"; reasons.push("the verification was cancelled before completing");
  } else if (ran.timedOut === true) {
    outcome = "timeout"; reasons.push("the verification exceeded its timeout and was terminated (no verdict reached)");
  } else if (p.sourceMutated === true && p.mutationExpected !== true) {
    outcome = "rejected-mutation"; reasons.push("a read-only verifier mutated the candidate source (detected via pre/post fingerprint)");
  } else if (ran.exitCode === undefined) {
    outcome = "incomplete"; reasons.push("no exit code / timeout / cancellation was captured");
  } else if (ran.exitCode !== 0) {
    outcome = "rejected-nonzero"; reasons.push(`the verification command exited non-zero (${ran.exitCode})`);
  } else {
    outcome = "verified";
  }
  return { verdict: outcome === "verified" ? PASS : FAIL, outcome, reasons, sourceMutationDetected, isolationIntact };
}

const RESERVED = new Set(["CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"]);

/**
 * RESULT-TRANSFER validator (fail-closed). A writer result is a set of relative entry paths (a diff/archive manifest).
 * Fusion validates EVERY path before applying it to an isolated host staging dir. Rejects: absolute, drive-letter,
 * parent-traversal, UNC, \\?\ extended, backslash or mixed separators that normalize outside, ADS (colon), reserved
 * device names, trailing dot/space, control chars, over-long, case-insensitive duplicate collisions, empty. Returns
 * { ok, accepted[], rejected:[{path,reason}] }. ok is true ONLY when nothing was rejected AND at least nothing escapes.
 */
export function validateResultEntries(entries, opts) {
  const maxLen = (opts && opts.maxPathLen) || 240;
  const accepted = [];
  const rejected = [];
  const seenCi = new Map();
  for (const raw of Array.isArray(entries) ? entries : []) {
    const p = typeof raw === "string" ? raw : (raw && raw.path);
    const reason = rejectReason(p, maxLen);
    if (reason) { rejected.push({ path: typeof p === "string" ? p.slice(0, 120) : String(p), reason }); continue; }
    const ci = p.toLowerCase();
    if (seenCi.has(ci)) { rejected.push({ path: p.slice(0, 120), reason: "case-insensitive duplicate collision" }); continue; }
    seenCi.set(ci, true);
    accepted.push(p);
  }
  return { ok: rejected.length === 0 && accepted.length >= 0, accepted, rejected };
}

function rejectReason(p, maxLen) {
  if (typeof p !== "string" || p.length === 0) return "empty or non-string path";
  if (p.length > maxLen) return "path too long";
  if (/[\u0000-\u001f]/u.test(p)) return "control character";
  if (/^[A-Za-z]:/.test(p)) return "drive-letter absolute path";
  if (p.startsWith("/") || p.startsWith("\\")) return "leading-separator absolute path";
  if (p.startsWith("\\\\") || p.startsWith("//")) return "UNC path";
  if (p.includes("\\\\?\\") || p.startsWith("\\\\?\\")) return "extended-length path";
  if (p.includes(":")) return "colon (drive or NTFS alternate data stream)";
  // normalize with forward + back separators; any '..' segment escapes
  const segs = p.split(/[\\/]+/u);
  for (const s of segs) {
    if (s === "..") return "parent traversal segment";
    if (s === ".") continue;
    if (s.length === 0) continue;
    if (s.endsWith(".") || s.endsWith(" ")) return "trailing dot or space segment";
    const base = s.split(".")[0].toUpperCase();
    if (RESERVED.has(base)) return "reserved device name";
  }
  return null;
}

export const FS_V = Object.freeze({ PASS, FAIL, INCOMPLETE });
