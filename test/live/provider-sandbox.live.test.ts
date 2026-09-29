import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { locateLauncher, runSandboxed } from "../../src/platform/isolation/appcontainer-backend.js";

/**
 * OPT-IN Windows real-OS proof (§17, §19, §23): an untrusted provider-like process, run through `runSandboxed` with a
 * provider capability manifest's grants (read the view, write scratch, nothing else), is mechanically UNABLE to reach
 * unauthorized resources — the primary checkout, sibling candidate, Fusion journal, delivery store and a credential
 * canary are all DENIED, and its spawned child inherits the boundary. Disposable canaries only; never a real secret.
 * This is the deterministic-canary stand-in for Gate #2 (a REAL provider turn in HARD mode).
 *   powershell -File native/fusion-sandbox/build.ps1
 *   $env:FUSION_APPCONTAINER_LIVE = '1'; npm run build; node --test dist/test/live/provider-sandbox.live.test.js
 */
const LIVE = process.env.FUSION_APPCONTAINER_LIVE === "1";

test("v0.6 LIVE provider-sandbox: primary/sibling/journal/delivery/credential are OS-denied to a sandboxed provider-like child", { skip: !LIVE && "set FUSION_APPCONTAINER_LIVE=1 to run" }, async () => {
  if (!LIVE) return;
  const launcher = await locateLauncher();
  assert.ok(launcher !== null, "build the launcher first (native/fusion-sandbox/build.ps1)");
  const dir = await mkdtemp(join(tmpdir(), "fusion-provsbx-"));
  const secrets = { primary: `PRIM_${randomBytes(6).toString("hex")}`, sibling: `SIB_${randomBytes(6).toString("hex")}`,
    journal: `JRN_${randomBytes(6).toString("hex")}`, delivery: `DLV_${randomBytes(6).toString("hex")}`, cred: `CRED_${randomBytes(6).toString("hex")}` };
  try {
    for (const d of ["view", "scratch", "primary", "sibling", "journal", "delivery", "cred"]) await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, "view", "ok.txt"), "VIEW_OK");
    await writeFile(join(dir, "primary", "src.ts"), secrets.primary);
    await writeFile(join(dir, "sibling", "candidate.txt"), secrets.sibling);
    await writeFile(join(dir, "journal", "journal.jsonl"), secrets.journal);
    await writeFile(join(dir, "delivery", "bundle.json"), secrets.delivery);
    await writeFile(join(dir, "cred", "id_rsa"), secrets.cred);
    const win = process.env.SystemRoot ?? "C:\\Windows";
    const q = (p: string) => `"${join(dir, p)}"`;
    // The provider-like child echoes a positive marker, tries to READ every forbidden secret, and tries to WRITE into
    // the primary and sibling. It also spawns a child (cmd) that tries the same read, to prove inheritance.
    const cmd = [
      "echo POSITIVE_MARKER",
      `& type ${q("primary\\src.ts")}`, `& type ${q("sibling\\candidate.txt")}`, `& type ${q("journal\\journal.jsonl")}`,
      `& type ${q("delivery\\bundle.json")}`, `& type ${q("cred\\id_rsa")}`,
      `& (echo x > ${q("primary\\injected.txt")})`, `& (echo x > ${q("sibling\\injected.txt")})`,
      `& cmd /d /c type ${q("cred\\id_rsa")}`,
    ].join(" ");
    const outcome = await runSandboxed(launcher!, {
      identity: `fusion.prov.${randomBytes(6).toString("hex")}`, workingDirectory: join(dir, "scratch"),
      readPaths: [join(dir, "view")], writePaths: [join(dir, "scratch")],
      executable: join(win, "System32", "cmd.exe"), args: ["/d", "/c", cmd], timeoutMs: 30_000,
    });
    assert.match(outcome.stdout, /POSITIVE_MARKER/u, "the sandboxed child ran (positive control)");
    for (const [where, secret] of Object.entries(secrets))
      assert.ok(!outcome.stdout.includes(secret) && !outcome.stderr.includes(secret), `${where} secret must be OS-denied to the sandbox`);
    // No forbidden write landed on the host (the parent, full-trust, verifies the real filesystem — defense in depth).
    assert.ok(!existsSync(join(dir, "primary", "injected.txt")), "primary checkout write denied");
    assert.ok(!existsSync(join(dir, "sibling", "injected.txt")), "sibling candidate write denied");
    // The primary/sibling/credential files are byte-unchanged.
    assert.equal(await readFile(join(dir, "primary", "src.ts"), "utf8"), secrets.primary);
    assert.equal(await readFile(join(dir, "cred", "id_rsa"), "utf8"), secrets.cred);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
