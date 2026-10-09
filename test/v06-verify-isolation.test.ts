import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Deterministic tests for the VERIFICATION-ISOLATION verdict. They exercise the ACTUAL evidence-derived classifier
// (isolatedVerificationVerdict) - never a hardcoded PASS - and the static shape of the guest canary + orchestrator.
const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const read = (f: string) => readFileSync(join(pocDir, f), "utf8");

type Verdict = { verdict: string; outcome: string; reasons: string[]; sourceMutationDetected: boolean; isolationIntact: boolean };
const ev = await import(new URL("../../tools/hyperv-poc/fs-evaluator.mjs", import.meta.url).href) as {
  isolatedVerificationVerdict: (p: unknown) => Verdict;
  primaryWorkspaceProtectionVerdict: (b: unknown, a: unknown) => { verdict: string; mutated: boolean | null };
};

const EXE = "C:\\fusion\\node.exe";
const ARGV = ["C:\\fusion\\approved-verify.mjs"];
const CWD = "C:\\fusion\\candidate";

// A clean probe = an isolated worker that ran EXACTLY the approved plan, exited 0, mutated nothing, and could reach no
// host/network/docker surface. Every other case is a single deliberate deviation from this.
const cleanProbe = () => ({
  plan: { executable: EXE, argv: [...ARGV], cwd: CWD },
  ran: {
    observed: true, executable: EXE, argv: [...ARGV], cwd: CWD,
    exitCode: 0, signal: null, timedOut: false, cancelled: false, spawnError: null,
    durationMs: 120, stdoutSha256: "s", stdoutBytes: 20, stderrSha256: "e", stderrBytes: 0,
  },
  executablePinned: true,
  candidateRoot: CWD,
  candidateFingerprintBefore: { "src/sum.mjs": "aaa", "manifest.json": "bbb" },
  candidateFingerprintAfter: { "src/sum.mjs": "aaa", "manifest.json": "bbb" },
  sourceMutated: false, mutationExpected: false,
  gitInCandidate: false,
  network: { loopbackOnly: true, nonInternal: [] },
  forbidden: { primaryReadable: false },
  dockerPipePresent: false,
  bindMounts: 0,
});
const mut = (f: (p: ReturnType<typeof cleanProbe>) => void) => { const p = cleanProbe(); f(p); return ev.isolatedVerificationVerdict(p); };

// 1. clean approved verification -> PASS
test("v0.6 verify-iso 1: a clean approved isolated verification is the ONLY PASS", () => {
  const v = ev.isolatedVerificationVerdict(cleanProbe());
  assert.equal(v.verdict, "PASS");
  assert.equal(v.outcome, "verified");
  assert.equal(v.isolationIntact, true);
  assert.deepEqual(v.reasons, []);
});

// 2. non-zero exit -> FAIL, classified as a verification rejection (NOT isolation breach)
test("v0.6 verify-iso 2: a non-zero verifier exit is FAIL / rejected-nonzero", () => {
  const v = mut(p => { p.ran.exitCode = 1; });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.outcome, "rejected-nonzero");
  assert.equal(v.isolationIntact, true, "isolation still held; only the candidate failed verification");
});

// 3. timeout -> classified DISTINCTLY from a generic failure
test("v0.6 verify-iso 3: a timeout is classified distinctly (not a generic failure)", () => {
  const v = mut(p => { const r = p.ran as Record<string, unknown>; r.exitCode = undefined; r.timedOut = true; r.signal = "SIGTERM"; });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.outcome, "timeout");
  assert.notEqual(v.outcome, "rejected-nonzero");
});

// 4. cancellation -> classified DISTINCTLY
test("v0.6 verify-iso 4: a cancellation is classified distinctly from timeout and failure", () => {
  const v = mut(p => { (p.ran as Record<string, unknown>).exitCode = undefined; p.ran.cancelled = true; });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.outcome, "cancelled");
});

// 5. source mutation during a read-only verification -> detected + FAIL
test("v0.6 verify-iso 5: a read-only verifier that mutates the candidate is detected and FAILs", () => {
  const v = mut(p => { p.sourceMutated = true; p.candidateFingerprintAfter = { "src/sum.mjs": "TAMPERED", "manifest.json": "bbb" }; });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.outcome, "rejected-mutation");
  assert.equal(v.sourceMutationDetected, true);
});

// 6. malformed / partial guest result -> never a PASS
test("v0.6 verify-iso 6: a malformed or partial guest probe is rejected, never a silent PASS", () => {
  assert.equal(ev.isolatedVerificationVerdict({}).verdict, "FAIL");
  assert.equal(ev.isolatedVerificationVerdict({}).outcome, "isolation-breach");
  assert.equal(ev.isolatedVerificationVerdict(null).verdict, "FAIL");
  // a probe that observed nothing (no ran block) can never pass
  const v = mut(p => { (p as Record<string, unknown>).ran = { observed: false }; });
  assert.equal(v.verdict, "FAIL");
});

// 7. forbidden / outside host path must be unreachable
test("v0.6 verify-iso 7: a reachable host Primary path is an isolation breach (even with exit 0)", () => {
  const v = mut(p => { p.forbidden.primaryReadable = true; });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.outcome, "isolation-breach");
  assert.ok(v.reasons.some(r => /Primary workspace was readable/u.test(r)));
});

// 8. network must be unavailable (loopback-only)
test("v0.6 verify-iso 8: a routable NIC (not loopback-only) is an isolation breach", () => {
  const v = mut(p => { p.network.loopbackOnly = false; (p.network.nonInternal as unknown[]) = [{ name: "Ethernet", family: "IPv4" }]; });
  assert.equal(v.verdict, "FAIL");
  assert.equal(v.outcome, "isolation-breach");
});

// 9. docker engine pipe must be unavailable
test("v0.6 verify-iso 9: a present docker engine pipe is an isolation breach", () => {
  assert.equal(mut(p => { p.dockerPipePresent = true; }).outcome, "isolation-breach");
});

// 9b. a host bind mount or a deviating argv/cwd/unpinned exe is an isolation breach that a clean exit cannot mask
test("v0.6 verify-iso 9b: a clean exit NEVER masks a structural isolation breach", () => {
  assert.equal(mut(p => { p.bindMounts = 1; }).outcome, "isolation-breach", "a host bind mount => breach");
  assert.equal(mut(p => { p.executablePinned = false; }).outcome, "isolation-breach", "unpinned executable => breach");
  assert.equal(mut(p => { p.ran.argv = ["C:\\fusion\\rogue.mjs"]; }).outcome, "isolation-breach", "argv != approved plan => breach");
  assert.equal(mut(p => { p.ran.cwd = "C:\\somewhere\\else"; }).outcome, "isolation-breach", "cwd != approved plan => breach");
  // all of the above keep verdict FAIL despite exitCode 0
  assert.equal(mut(p => { p.bindMounts = 1; }).verdict, "FAIL");
});

// 10. cleanup / no residue - the orchestrator removes the worker + image and records it
test("v0.6 verify-iso 10: the orchestrator self-cleans (worker + image removed, residue checked)", () => {
  const poc = read("verify-poc.ps1");
  assert.match(poc, /function Invoke-ViCleanup/u);
  assert.match(poc, /docker rm -f \$worker/u, "removes the worker");
  assert.match(poc, /docker rmi \$image/u, "removes the image");
  assert.match(poc, /\$cleanupOk = \$workerGone -and \$imageGone/u, "asserts no residue");
  assert.match(poc, /docker kill \$worker/u, "kills the ephemeral worker (destroys the VM + its disposable FS)");
});

// 11. PrimaryWorkspace remains unchanged - independent before/after fingerprint comparison
test("v0.6 verify-iso 11: Primary workspace protection is an independent before/after compare", () => {
  const fp = { porcelainHash: "p", headHash: "h", treeHash: "t", gitConfigHash: "c", gitHeadFileHash: "gh", gitHooksHash: "hk" };
  assert.equal(ev.primaryWorkspaceProtectionVerdict(fp, { ...fp }).verdict, "PASS");
  assert.equal(ev.primaryWorkspaceProtectionVerdict(fp, { ...fp, porcelainHash: "drift" }).verdict, "FAIL");
  const poc = read("verify-poc.ps1");
  assert.match(poc, /Get-PrimaryFingerprint/u);
  assert.match(poc, /fpBefore = Get-PrimaryFingerprint/u);
  assert.match(poc, /fpAfter = Get-PrimaryFingerprint/u);
});

// 12. candidate fingerprint before/after is recorded and compared
test("v0.6 verify-iso 12: a missing candidate pre/post fingerprint can never PASS; both must be recorded", () => {
  assert.equal(mut(p => { (p as Record<string, unknown>).candidateFingerprintBefore = undefined; }).outcome, "isolation-breach");
  assert.equal(mut(p => { (p as Record<string, unknown>).candidateFingerprintAfter = undefined; }).outcome, "isolation-breach");
  // the canary records both and derives sourceMutated from their inequality
  const c = read("verify-canary.mjs");
  assert.match(c, /candidateFingerprintBefore/u);
  assert.match(c, /candidateFingerprintAfter/u);
  assert.match(c, /sourceMutated\s*=\s*JSON\.stringify\(candidateFingerprintBefore\)\s*!==\s*JSON\.stringify\(candidateFingerprintAfter\)/u);
});

// ---- static guards on the guest verify canary ---------------------------------------------------------------------
test("v0.6 verify canary: captures full command identity + runs the approved plan with shell:false, emits VERIFY_PROBE_JSON", () => {
  const c = read("verify-canary.mjs");
  assert.match(c, /VERIFY_PROBE_JSON /u, "emits the probe line");
  assert.match(c, /VERIFY_CANARY_WATCHDOG/u, "has a self-terminating watchdog");
  assert.match(c, /spawnSync\(executable, argv, \{[^}]*shell: false/u, "runs argv as data, shell:false (no model shell)");
  assert.match(c, /FUSION_VERIFY_SPEC/u, "the plan arrives as a spec, not a parsed command line");
  assert.match(c, /path\.isAbsolute\(executable\)/u, "pins the executable to an absolute path");
  for (const field of ["exitCode", "timedOut", "startedAt", "endedAt", "stdoutSha256", "stderrSha256", "argv", "cwd"]) {
    assert.ok(c.includes(field), `canary must capture ${field}`);
  }
  assert.match(c, /process\.exit\(/u, "exits deterministically");
});

// ---- static guards on the orchestrator preserving the proven architecture -----------------------------------------
test("v0.6 verify orchestrator: preserves isolation=hyperv + --network none + zero bind mounts + explicit candidate transfer", () => {
  const poc = read("verify-poc.ps1");
  // the candidate is TRANSFERRED into the image (baked), never host-mounted
  assert.match(poc, /COPY candidate C:\/fusion\/candidate/u, "candidate snapshot is baked into the image (no host mount)");
  assert.match(poc, /verify-candidate/u, "transfers the candidate fixture");
  // the worker is started via the asserted pipe-run-args (--network none, one npipe, NO bind mount)
  assert.match(poc, /pipe-run-args\.mjs/u);
  assert.doesNotMatch(poc, /--mount[^\n]*type=bind/u, "no host bind mount");
  assert.doesNotMatch(poc, /docker cp /u, "no docker cp from a running Hyper-V container");
  // three live scenarios drive the gate
  for (const s of ["clean", "timeout", "mutate"]) assert.ok(poc.includes("'" + s + "'"), `scenario ${s} present`);
  assert.match(poc, /GATE_MUTATION_DETECTED/u);
  assert.match(poc, /GATE_TIMEOUT_DETECTED/u);
  // the verdict is computed by the driver, never asserted by hand
  assert.match(poc, /verify-verify\.mjs/u);
});
