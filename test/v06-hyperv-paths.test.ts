import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
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

/**
 * Invoke provision.ps1 EXACTLY as elevated-run does (powershell.exe -NoProfile -ExecutionPolicy Bypass -File <abs>), from
 * a DIFFERENT working directory, with `docker` removed from PATH so provision dies cleanly at its first docker call
 * (prestate) — AFTER the path diagnostics and the durable owner-file write, and BEFORE any network/process is created.
 * Returns combined stdout (provision exits non-zero, which execFileSync surfaces as an error carrying stdout).
 */
function runProvision(winPs: string, args: string[], cwd: string): string {
  // A PATH with Windows PowerShell + System32 but NOT Docker, so `& docker` fails fast with "not recognized".
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
  const safePath = [`${sysRoot}\\System32\\WindowsPowerShell\\v1.0`, `${sysRoot}\\System32`, sysRoot].join(";");
  const env = { ...process.env, PATH: safePath, Path: safePath };
  try {
    return execFileSync(winPs, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(pocDir, "provision.ps1"), ...args], { cwd, env, encoding: "utf8" });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return (err.stdout ?? "") + "\n" + (err.stderr ?? "");
  }
}

test("v0.6 Hyper-V paths: provision.ps1 -File resolves SCRIPT_DIR to tools/hyperv-poc and honors an explicit -OutDir (spaced path, different cwd)", () => {
  const winPs = findWinPs();
  if (winPs === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const runId = "pathexp" + Date.now().toString().slice(-6);
  const outParent = mkdtempSync(join(tmpdir(), "fusion hv poc ")); // mkdtemp suffix keeps the required space in the path
  const outDir = outParent;
  try {
    const out = runProvision(winPs, ["-RunId", runId, "-Token", "tok", "-OutDir", outDir], tmpdir());
    const scriptDir = /SCRIPT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    const resolvedOut = /OUT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    assert.ok(scriptDir && scriptDir.toLowerCase().endsWith("hyperv-poc"), `SCRIPT_DIR is the harness dir: ${scriptDir}`);
    assert.equal(resolvedOut?.toLowerCase(), outDir.toLowerCase(), "explicit -OutDir wins (normalized)");
    assert.ok(!/Creating network/u.test(out), "no network creation was attempted (died at the first docker call)");
    // The durable owner file was written under the intended OutDir — proof no Join-Path got an empty Path.
    assert.ok(existsSync(join(outDir, `owner-${runId}.json`)), "owner-<RunId>.json is under the explicit OutDir");
  } finally {
    rmSync(outParent, { recursive: true, force: true });
  }
});

test("v0.6 Hyper-V paths: provision.ps1 -File defaults OUT_DIR to SCRIPT_DIR when -OutDir is omitted", () => {
  const winPs = findWinPs();
  if (winPs === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available)"); return; }
  const runId = "pathdef" + Date.now().toString().slice(-6);
  try {
    const out = runProvision(winPs, ["-RunId", runId, "-Token", "tok"], tmpdir());
    const scriptDir = /SCRIPT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    const resolvedOut = /OUT_DIR=(.+)/u.exec(out)?.[1]?.trim();
    assert.ok(scriptDir && resolvedOut, `both diagnostics printed: SCRIPT_DIR=${scriptDir} OUT_DIR=${resolvedOut}`);
    assert.equal(resolvedOut?.toLowerCase(), scriptDir?.toLowerCase(), "default OutDir resolves to the script dir (not an empty string)");
    assert.ok(!/leere Zeichenfolge|empty string/u.test(out), "no empty-Path binding error (the original bug)");
  } finally {
    // The default-OutDir run wrote owner-<RunId>.json (and nothing else, since it died at prestate) into the harness dir.
    for (const f of readdirSync(pocDir)) if (f.includes(runId)) rmSync(join(pocDir, f), { force: true });
  }
});
