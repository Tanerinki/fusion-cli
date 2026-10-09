import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const read = (f: string) => readFileSync(join(pocDir, f), "utf8");
const ev = await import(new URL("../../tools/hyperv-poc/fs-evaluator.mjs", import.meta.url).href) as {
  filesystemBoundaryVerdict: (p: unknown) => { verdict: string; reasons: string[] };
  primaryWorkspaceProtectionVerdict: (b: unknown, a: unknown) => { verdict: string; mutated: boolean | null };
  validateResultEntries: (e: unknown, o?: unknown) => { ok: boolean; accepted: string[]; rejected: { path: string; reason: string }[] };
  verificationIsolationVerdict: (m: unknown) => { verdict: string; reasons: string[] };
};

// A clean probe = the structural safe state: host Primary not present in the VM, approved write ok, every
// Primary-targeting write denied, no host .git, no docker pipe, no reparse escape.
const cleanProbe = () => ({
  positive: { outcome: "ok" },
  facts: { primaryWorkspacePathExists: false, gitDirExists: false, visibleDriveRoots: ["C:\\"] },
  negatives: {
    N1_primaryWriteExisting: { write: { outcome: "denied", code: "ENOENT" } },
    N3_primaryCreateNew: { write: { outcome: "denied", code: "ENOENT" } },
    N6_primaryAbsolute: { write: { outcome: "denied", code: "ENOENT" } },
    N7_extendedLength: { write: { outcome: "denied", code: "ENOENT" } },
    N8_uncAdminShare: { write: { outcome: "denied", code: "ENOENT" } },
    N13_hostRepoParent: { write: { outcome: "denied", code: "ENOENT" } },
    N15_fusionHostControl: { write: { outcome: "denied", code: "ENOENT" } },
    N14_dockerEnginePipe: { exists: false },
  },
  git: { primaryGitReachable: false, canWritePrimaryGitConfig: { outcome: "denied" }, canWritePrimaryGitHooks: { outcome: "denied" } },
  reparse: { preSeeded: { outcome: "not_applicable" }, selfCreated: {} },
});

test("v0.6 FS evaluator: a structurally-isolated worker (no host mount) PASSES the filesystem boundary", () => {
  assert.equal(ev.filesystemBoundaryVerdict(cleanProbe()).verdict, "PASS");
});

test("v0.6 FS evaluator: each host-escape signal forces FILESYSTEM_BOUNDARY=FAIL (never a silent pass)", () => {
  const mut = (f: (p: ReturnType<typeof cleanProbe>) => void) => { const p = cleanProbe(); f(p); return ev.filesystemBoundaryVerdict(p).verdict; };
  assert.equal(mut(p => { p.facts.primaryWorkspacePathExists = true; }), "FAIL", "host Primary path visible => FAIL");
  assert.equal(mut(p => { p.positive.outcome = "error"; }), "FAIL", "approved write broken => FAIL");
  assert.equal(mut(p => { (p.negatives.N6_primaryAbsolute as Record<string, unknown>).write = { outcome: "ok", landedReal: "D:\\primary-workspace\\repo\\x" }; }), "FAIL", "a Primary-targeting write not denied => FAIL");
  assert.equal(mut(p => { p.facts.gitDirExists = true; }), "FAIL", "a reachable .git => FAIL");
  assert.equal(mut(p => { (p.negatives.N14_dockerEnginePipe as Record<string, unknown>).exists = true; }), "FAIL", "docker engine pipe present => FAIL");
  assert.equal(mut(p => { (p.git as Record<string, unknown>).canWritePrimaryGitConfig = { outcome: "ok" }; }), "FAIL", "writable host .git/config => FAIL");
  assert.equal(mut(p => { (p.reparse as Record<string, unknown>).selfCreated = { dirJunction: { created: true, writeThrough: { outcome: "ok" }, resolvesTo: { targetsPrimary: true } } }; }), "FAIL", "a reparse that escapes to Primary => FAIL");
});

test("v0.6 FS evaluator: a NOT_RUN negative probe is never a PASS", () => {
  const p = cleanProbe(); delete (p.negatives as Record<string, unknown>).N6_primaryAbsolute;
  assert.equal(ev.filesystemBoundaryVerdict(p).verdict, "FAIL");
});

test("v0.6 FS evaluator: PRIMARY_WORKSPACE_PROTECTION is independent before/after; identical=PASS, drift=FAIL, missing=INCOMPLETE", () => {
  const fp = { porcelain: "", trackedSummary: "abc123", gitConfigHash: "h1", headHash: "h2" };
  assert.equal(ev.primaryWorkspaceProtectionVerdict(fp, { ...fp }).verdict, "PASS");
  assert.equal(ev.primaryWorkspaceProtectionVerdict(fp, { ...fp, porcelain: " M src/x.ts" }).verdict, "FAIL");
  assert.equal(ev.primaryWorkspaceProtectionVerdict(fp, { ...fp, gitConfigHash: "tampered" }).verdict, "FAIL");
  assert.equal(ev.primaryWorkspaceProtectionVerdict(fp, null).verdict, "INCOMPLETE");
});

test("v0.6 FS evaluator: VERIFICATION_ISOLATION passes only for an isolated host-owned execution model", () => {
  const good = { executesOnHost: false, isolatedWorker: true, commandIdentityHostOwned: true, cwdHostControlled: true, envHostControlled: true, executableResolutionPinned: true, prePostStateMeasured: true };
  assert.equal(ev.verificationIsolationVerdict(good).verdict, "PASS");
  assert.equal(ev.verificationIsolationVerdict({ ...good, executesOnHost: true }).verdict, "FAIL");
  assert.equal(ev.verificationIsolationVerdict({ ...good, executableResolutionPinned: false }).verdict, "FAIL");
  assert.equal(ev.verificationIsolationVerdict({}).verdict, "FAIL");
});

test("v0.6 FS evaluator: result-transfer validator fails CLOSED on every path-attack shape", () => {
  const ok = ev.validateResultEntries(["src/a.ts", "docs/readme.md", "nested/dir/file.txt"]);
  assert.equal(ok.ok, true); assert.equal(ok.accepted.length, 3);
  const attacks = [
    "../evil.txt", "..\\evil.txt", "a/../../evil", "C:\\evil.txt", "/etc/evil", "\\\\server\\share\\x",
    "\\\\?\\C:\\evil", "a/b:stream", "con", "PRN.txt", "trailingdot.", "trailing ", "a\u0000b",
  ];
  for (const a of attacks) {
    const r = ev.validateResultEntries([a]);
    assert.equal(r.ok, false, `attack must be rejected: ${JSON.stringify(a)}`);
    assert.equal(r.rejected.length, 1, `exactly one rejection for ${JSON.stringify(a)}`);
  }
  // case-insensitive collision (would clobber on Windows)
  const dup = ev.validateResultEntries(["Src/File.ts", "src/file.ts"]);
  assert.equal(dup.ok, false);
  assert.ok(dup.rejected.some(r => /collision/u.test(r.reason)));
});

test("v0.6 FS argv: the FS worker is --network none with ZERO mounts; a smuggled mount/pipe is refused", async () => {
  const argv = await import(new URL("../../tools/hyperv-poc/argv.mjs", import.meta.url).href) as {
    buildFsWorkerRunArgs: (s: unknown) => string[];
    assertFsWorkerArgv: (a: unknown) => { ok: boolean; reasons: string[] };
  };
  const args = argv.buildFsWorkerRunArgs({ name: "FusionV06Poc-fstest-fs", image: "img:fsx", cmd: ["C:\\fusion\\node.exe", "-e", "0"] });
  assert.ok(args.includes("--isolation=hyperv") && args[args.indexOf("--network") + 1] === "none");
  assert.ok(!args.includes("--mount") && !args.includes("-v") && !args.includes("--volume"), "no mount flag");
  assert.equal(argv.assertFsWorkerArgv(args).ok, true, "the clean FS argv passes its invariant");
  // a smuggled bind mount or npipe must be refused by the asserter
  assert.equal(argv.assertFsWorkerArgv([...args, "--mount", "type=bind,source=C:\\,target=C:\\host"]).ok, false);
  assert.equal(argv.assertFsWorkerArgv([...args, "--mount", "type=npipe,source=\\\\.\\pipe\\x,target=\\\\.\\pipe\\x"]).ok, false);
});

// ---- static guards on the guest canary ---------------------------------------------------------------------------
test("v0.6 FS canary: emits FS_PROBE_JSON, has a watchdog, and probes every mandatory negative shape", () => {
  const c = read("fs-canary.mjs");
  assert.match(c, /FS_PROBE_JSON /u, "emits the probe line");
  assert.match(c, /FS_CANARY_WATCHDOG/u, "has a self-terminating watchdog");
  assert.match(c, /process\.exit\(0\)/u, "exits deterministically");
  for (const shape of ["N5_parentTraversal", "N7_extendedLength", "N8_uncAdminShare", "N10_userProfileEnv", "N14_dockerEnginePipe", "selfCreated", "preSeeded"]) {
    assert.ok(c.includes(shape), `canary must probe ${shape}`);
  }
  assert.doesNotMatch(c, /FUSION_FS_CANARY_PWNED[\s\S]{0,40}credential|password|token/u, "no secret-shaped content in the canary");
});

test("v0.6 FS orchestrator: result pull is the stdout manifest (NOT docker cp on a running Hyper-V container); reparse seed uses node not cmd mklink", () => {
  const poc = read("fs-poc.ps1");
  // docker cp is unsupported for a RUNNING Hyper-V container; the result must be captured from the canary's stdout.
  assert.doesNotMatch(poc, /docker cp .*fs-probe-result|docker cp .*workspace/u, "must not docker cp from the running Hyper-V worker");
  assert.match(poc, /FS_PROBE_JSON '\.Length/u, "captures the canary's FS_PROBE_JSON stdout line");
  // the hostile reparse seed is created via node + an env var (no cmd/mklink quoting of the spaced host path).
  assert.doesNotMatch(poc, /cmd \/c "mklink/u, "must not seed the reparse via cmd mklink (spaced-path quoting bug)");
  assert.match(poc, /symlinkSync\(process\.env\.SEED_TGT/u, "seeds the reparse via node symlinkSync with the target in an env var");
  // the primary fingerprint is an independent before/after comparison (mutation detector), not a self-report.
  assert.match(poc, /Get-PrimaryFingerprint/u);
  assert.match(poc, /porcelainHash\s*=/u, "the primary fingerprint hashes git porcelain");
});
