import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");

function findWinPs(): string | undefined {
  for (const cand of ["powershell.exe", "powershell"]) {
    try {
      const major = execFileSync(cand, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).trim();
      if (major.startsWith("5")) return cand;
    } catch { /* next */ }
  }
  return undefined;
}

/** Canonicalize a Windows path so an 8.3 short form (RUNNER~1) and its long form (runneradmin) compare equal. */
function canon(p: string): string {
  try { return realpathSync.native(p).toLowerCase(); } catch { return p.replace(/[/\\]+$/u, "").toLowerCase(); }
}

/**
 * Invoke provision.ps1 EXACTLY as elevated-run does (powershell.exe -NoProfile -ExecutionPolicy Bypass -File <abs>), from
 * a DIFFERENT working directory, with -DiagnoseOnly so provision prints SCRIPT_DIR/OUT_DIR, writes the durable owner
 * file, and exits BEFORE any docker/network/process work — deterministic and side-effect-free (exercises the exact path
 * resolution that broke the live run, nothing else).
 */
function runProvisionDiag(winPs: string, args: string[], cwd: string): string {
  return execFileSync(winPs, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pocDir, "provision.ps1"), ...args, "-DiagnoseOnly"], { cwd, encoding: "utf8" });
}

test("v0.6 Hyper-V paths: provision.ps1 -File resolves SCRIPT_DIR to tools/hyperv-poc and honors an explicit -OutDir (spaced path, different cwd)", () => {
  const winPs = findWinPs();
  if (winPs === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const runId = "pathexp" + Date.now().toString().slice(-6);
  const outDir = mkdtempSync(join(tmpdir(), "fusion hv poc ")); // the trailing space keeps a real space in the path
  try {
    const out = runProvisionDiag(winPs, ["-RunId", runId, "-Token", "tok", "-OutDir", outDir], tmpdir());
    const scriptDir = /SCRIPT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    const resolvedOut = /OUT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    assert.ok(scriptDir && canon(scriptDir).endsWith("hyperv-poc"), `SCRIPT_DIR is the harness dir: ${scriptDir}`);
    assert.equal(canon(resolvedOut ?? ""), canon(outDir), "explicit -OutDir wins (same directory, canonicalized)");
    assert.ok(/DIAGNOSE_ONLY=1/u.test(out) && !/Creating network/u.test(out), "stopped before any docker/network mutation");
    // The durable owner file was written under the intended OutDir — proof no Join-Path got an empty Path.
    assert.ok(existsSync(join(outDir, `owner-${runId}.json`)), "owner-<RunId>.json is under the explicit OutDir");
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
});

test("v0.6 Hyper-V paths: provision.ps1 -File defaults OUT_DIR to SCRIPT_DIR when -OutDir is omitted (no empty Join-Path)", () => {
  const winPs = findWinPs();
  if (winPs === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const runId = "pathdef" + Date.now().toString().slice(-6);
  try {
    const out = runProvisionDiag(winPs, ["-RunId", runId, "-Token", "tok"], tmpdir());
    const scriptDir = /SCRIPT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    const resolvedOut = /OUT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    assert.ok(scriptDir && resolvedOut, `both diagnostics printed: SCRIPT_DIR=${scriptDir} OUT_DIR=${resolvedOut}`);
    assert.equal(canon(resolvedOut ?? ""), canon(scriptDir ?? ""), "default OutDir resolves to the script dir (never an empty string)");
    assert.ok(!/leere Zeichenfolge|empty string/u.test(out), "no empty-Path binding error (the original bug)");
  } finally {
    for (const f of readdirSync(pocDir)) if (f.includes(runId)) rmSync(join(pocDir, f), { force: true });
  }
});
