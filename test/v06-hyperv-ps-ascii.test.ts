import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");

/** Every .ps1 under tools/hyperv-poc (recursive). */
function ps1Files(): string[] {
  return (readdirSync(pocDir, { recursive: true } as never) as unknown as string[])
    .filter(f => typeof f === "string" && f.endsWith(".ps1"))
    .map(rel => join(pocDir, rel));
}

// ---------------------------------------------------------------------------------------------------------------------
// ASCII-only gate (platform-independent). Windows PowerShell 5.1 decodes a BOM-less UTF-8 .ps1 with the legacy ANSI code
// page, so a typographic character like em dash (U+2014, bytes E2 80 94) becomes mojibake that includes a smart quote
// (CP1252 0x94 = ”), which PowerShell parses as a string delimiter and the whole script fails to parse BEFORE running.
// Keeping executable .ps1 strictly 7-bit ASCII removes the decode ambiguity entirely. This test would FAIL on the em
// dashes that broke the first elevated run.
// ---------------------------------------------------------------------------------------------------------------------
test("v0.6 Hyper-V PoC: every harness .ps1 is strictly 7-bit ASCII (Windows PowerShell 5.1 BOM-less-UTF-8 safe)", () => {
  const files = ps1Files();
  assert.ok(files.length >= 10, `found harness .ps1 files (${files.length})`);
  const offenders: string[] = [];
  for (const full of files) {
    const bytes = readFileSync(full);
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i]! > 0x7f) {
        const rel = full.slice(pocDir.length + 1);
        offenders.push(`${rel} @byte ${i}: 0x${bytes[i]!.toString(16)}`);
        break;
      }
    }
  }
  assert.deepEqual(offenders, [], `non-ASCII bytes found in executable .ps1 (would mojibake under Windows PowerShell 5.1):\n${offenders.join("\n")}`);
});

// ---------------------------------------------------------------------------------------------------------------------
// Windows PowerShell 5.1 decode+parse regression (runs only where Windows `powershell.exe` 5.1 is present, e.g. the
// Windows CI runner). It uses [Parser]::ParseFile under 5.1, which reads the file with the SAME encoding path the script
// loader (`powershell -File`) uses — the ANSI code page for a BOM-less file. On the em-dash version this reproduced the
// exact live failure (an em dash inside a double-quoted string becomes a CP1252 smart quote U+201D, which the tokenizer
// treats as a string delimiter: "string missing its terminator" / "Unexpected token"). On the ASCII version it passes
// because ANSI and UTF-8 decode identically for 7-bit bytes. This is NOT the pwsh (7) gate (pwsh decodes BOM-less as
// UTF-8 and would miss the bug) — it specifically targets Windows PowerShell 5.1 the documented command uses.
// ---------------------------------------------------------------------------------------------------------------------
test("v0.6 Hyper-V PoC: every harness .ps1 parses under Windows PowerShell 5.1 loader decoding (powershell.exe ParseFile)", () => {
  let winPs: string | undefined;
  for (const cand of ["powershell.exe", "powershell"]) {
    try {
      const major = execFileSync(cand, ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { encoding: "utf8" }).trim();
      if (major.startsWith("5")) { winPs = cand; break; }
    } catch { /* not this one */ }
  }
  if (winPs === undefined) { console.log("(skipped: Windows PowerShell 5.1 not available on this platform)"); return; }
  for (const full of ps1Files()) {
    const p = full.replace(/'/gu, "''");
    // ParseFile uses the 5.1 script-loader encoding (ANSI for a BOM-less file) — the exact path that broke the live run.
    const script = `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${p}', [ref]$null, [ref]$e); if ($e -and $e.Count) { $e | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 3 }`;
    // Throws (non-zero exit) if the 5.1-decoded source has any parse error → the test fails and names the file.
    execFileSync(winPs, ["-NoProfile", "-Command", script], { stdio: ["ignore", "ignore", "inherit"] });
  }
});
