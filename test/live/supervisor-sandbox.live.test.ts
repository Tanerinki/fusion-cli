import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { DENY_ALL_NETWORK } from "../../src/core/isolation/network-policy.js";
import { locateLauncher } from "../../src/platform/isolation/appcontainer-backend.js";
import { ProcessSupervisor } from "../../src/platform/process/supervisor.js";
import { prepareSandboxLaunch } from "../../src/platform/process/sandboxed-spawn.js";

/**
 * OPT-IN Windows real-OS proof for v0.6 I10 (§17, §19): the SAME confinement the live provider-sandbox suite proves, now
 * driven through the PRODUCTION `ProcessSupervisor.start({ sandbox })` branch a real provider turn would take — the real
 * `fusion-sandbox.exe` launcher runs a FAKE provider child (cmd.exe) inside a no-capability AppContainer, and the
 * supervisor bridges its stdio / owns its lifetime. Granted view reads work (positive control); the primary checkout,
 * sibling candidate, Fusion journal/delivery and a credential canary are all OS-DENIED; no forbidden write lands; the
 * launcher scratch is cleaned up. Disposable canaries only; NO real provider, credentials, quota or model call.
 *   powershell -File native/fusion-sandbox/build.ps1
 *   $env:FUSION_APPCONTAINER_LIVE = '1'; npm run build; node --test dist/test/live/supervisor-sandbox.live.test.js
 */
const LIVE = process.env.FUSION_APPCONTAINER_LIVE === "1";

test("v0.6 I10 LIVE supervisor-sandbox: a provider-like child run through ProcessSupervisor is OS-confined by the real launcher", { skip: !LIVE && "set FUSION_APPCONTAINER_LIVE=1 to run" }, async () => {
  if (!LIVE) return;
  const launcher = await locateLauncher();
  assert.ok(launcher !== null, "build the launcher first (native/fusion-sandbox/build.ps1)");
  const dir = await mkdtemp(join(tmpdir(), "fusion-i10-live-"));
  const secrets = { primary: `PRIM_${randomBytes(6).toString("hex")}`, sibling: `SIB_${randomBytes(6).toString("hex")}`,
    journal: `JRN_${randomBytes(6).toString("hex")}`, delivery: `DLV_${randomBytes(6).toString("hex")}`, cred: `CRED_${randomBytes(6).toString("hex")}` };
  try {
    for (const d of ["view", "scratch", "primary", "sibling", "journal", "delivery", "cred"]) await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, "view", "ok.txt"), "VIEW_GRANTED_OK");
    await writeFile(join(dir, "primary", "src.ts"), secrets.primary);
    await writeFile(join(dir, "sibling", "candidate.txt"), secrets.sibling);
    await writeFile(join(dir, "journal", "journal.jsonl"), secrets.journal);
    await writeFile(join(dir, "delivery", "bundle.json"), secrets.delivery);
    await writeFile(join(dir, "cred", "id_rsa"), secrets.cred);
    const win = process.env.SystemRoot ?? "C:\\Windows";
    const p = (...x: string[]) => join(dir, ...x);
    const cmd = ["echo POSITIVE_MARKER", `& type ${p("view", "ok.txt")}`,
      `& type ${p("primary", "src.ts")}`, `& type ${p("sibling", "candidate.txt")}`, `& type ${p("journal", "journal.jsonl")}`,
      `& type ${p("delivery", "bundle.json")}`, `& type ${p("cred", "id_rsa")}`,
      `& (echo x > ${p("primary", "injected.txt")})`, `& (echo x > ${p("sibling", "injected.txt")})`].join(" ");
    const cmdExe = join(win, "System32", "cmd.exe");
    const spec = { identity: `fusion.i10.${randomBytes(6).toString("hex")}`, workingDirectory: join(dir, "scratch"),
      readPaths: [join(dir, "view")], writePaths: [join(dir, "scratch")], executable: cmdExe, args: ["/d", "/c", cmd],
      timeoutMs: 30_000, network: DENY_ALL_NETWORK };
    const launch = await prepareSandboxLaunch(launcher, spec);
    assert.equal(launch.available, true, "the real launcher is present");
    // The PRODUCTION supervisor sandbox branch — the same path a real provider turn takes.
    const outcome = await new ProcessSupervisor().start({ executable: cmdExe, args: spec.args, cwd: join(dir, "scratch"),
      env: {}, sandbox: launch, timeoutMs: 45_000 }).result;
    assert.equal(outcome.issue, undefined, `${outcome.issue?.kind}: ${outcome.issue?.safeMessage}`);
    assert.match(outcome.stdout, /POSITIVE_MARKER/u, "the sandboxed child ran and its stdout streamed through the supervisor");
    assert.match(outcome.stdout, /VIEW_GRANTED_OK/u, "a GRANTED file IS readable — so the denials are real, not parse errors");
    for (const [where, secret] of Object.entries(secrets))
      assert.ok(!outcome.stdout.includes(secret) && !outcome.stderr.includes(secret), `${where} secret must be OS-denied to the sandbox`);
    assert.ok(!existsSync(join(dir, "primary", "injected.txt")), "primary checkout write denied");
    assert.ok(!existsSync(join(dir, "sibling", "injected.txt")), "sibling candidate write denied");
    assert.equal(await readFile(join(dir, "primary", "src.ts"), "utf8"), secrets.primary, "primary file byte-unchanged");
    // The launcher scratch is cleaned up by the supervisor after settle (no contamination).
    let gone = false;
    for (let i = 0; i < 40 && !gone; i++) { gone = !existsSync(launch.cwd); if (!gone) await new Promise(r => setTimeout(r, 50)); }
    assert.equal(gone, true, "the launcher scratch is removed after the run");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
