import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { locateLauncher, runSandboxed } from "../../src/platform/isolation/appcontainer-backend.js";

/**
 * OPT-IN Windows real-OS proof (§22, §61): a credential SENTINEL placed in a location the sandbox is NOT granted never
 * reaches the sandboxed child's output — the OS denies the read. Disposable canaries only; never a real secret. Skips
 * (does not fail) without the flag or the built launcher.
 *   powershell -File native/fusion-sandbox/build.ps1
 *   $env:FUSION_APPCONTAINER_LIVE = '1'; npm run build; node --test dist/test/live/sandbox-contamination.live.test.js
 */
const LIVE = process.env.FUSION_APPCONTAINER_LIVE === "1";

test("v0.6 LIVE contamination: an ungranted credential sentinel never reaches the sandboxed child's output", { skip: !LIVE && "set FUSION_APPCONTAINER_LIVE=1 to run" }, async () => {
  if (!LIVE) return;
  const launcher = await locateLauncher();
  assert.ok(launcher !== null, "build the launcher first (native/fusion-sandbox/build.ps1)");
  const dir = await mkdtemp(join(tmpdir(), "fusion-contam-"));
  const sentinel = `FUSION_SENTINEL_${randomBytes(8).toString("hex")}`;
  try {
    await mkdir(join(dir, "view"), { recursive: true });
    await mkdir(join(dir, "home"), { recursive: true });
    await mkdir(join(dir, "denied"), { recursive: true });
    await writeFile(join(dir, "denied", "credential.txt"), sentinel);
    const winDir = process.env.SystemRoot ?? "C:\\Windows";
    await writeFile(join(dir, "view", "ok.txt"), "VIEW_GRANTED_OK");
    // The child echoes a marker, reads a GRANTED file (proves reads work when allowed), then tries to read the ungranted
    // sentinel. Paths are unquoted (%TEMP% is space-free) so a denied read is a real access-denial, not a parse error.
    const outcome = await runSandboxed(launcher!, {
      identity: `fusion.contam.${randomBytes(6).toString("hex")}`, workingDirectory: join(dir, "home"),
      readPaths: [join(dir, "view")], writePaths: [join(dir, "home")],
      executable: join(winDir, "System32", "cmd.exe"),
      args: ["/d", "/c", `echo POSITIVE_MARKER & type ${join(dir, "view", "ok.txt")} & type ${join(dir, "denied", "credential.txt")}`],
      timeoutMs: 30_000,
    });
    assert.ok(outcome.jobTotalProcesses >= 1, "the sandboxed child ran");
    assert.match(outcome.stdout, /POSITIVE_MARKER/u, "the child produced output (positive control)");
    assert.match(outcome.stdout, /VIEW_GRANTED_OK/u, "a GRANTED file IS readable (proves denial is real, not a parse error)");
    assert.ok(!outcome.stdout.includes(sentinel), "the ungranted sentinel never reached the child's stdout");
    assert.ok(!outcome.stderr.includes(sentinel), "the ungranted sentinel never reached the child's stderr");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
