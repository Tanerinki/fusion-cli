import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import { fusionTemporaryBase } from "../src/platform/fs/temporary.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { PrivateWriterWorkspace } from "../src/platform/workspace/private-writer.js";

/**
 * Windows can name the temporary directory through 8.3 short names (GitHub-hosted runners: a `RUNNER~1` profile segment),
 * while Git and the filesystem report long names. Fusion's temporary base is canonicalized so that its exact comparisons
 * hold for a legitimate short-named TEMP — and only that spelling is normalized: a TEMP reached through a junction is
 * returned unchanged, so the strict link checks keep refusing it.
 */
const windows = process.platform === "win32";
const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
const skip = !windows ? "Windows 8.3 names only" : !gitAvailable ? "git executable unavailable" : false;

/** The 8.3 short spelling of an existing path, or undefined when the volume generates no short names. */
function shortPath(path: string): string | undefined {
  const result = spawnSync("cmd.exe", ["/d", "/s", "/c", `"for %I in ("${path}") do @echo %~sI"`],
    { encoding: "utf8", windowsHide: true, windowsVerbatimArguments: true });
  const short = result.status === 0 ? result.stdout.trim() : "";
  return short.length > 0 && short.toLowerCase() !== path.toLowerCase() && short.includes("~") ? short : undefined;
}
/** Runs `work` with TEMP and TMP naming `directory` (how `os.tmpdir()` finds the temporary directory on Windows). */
async function withTemp<T>(directory: string, work: () => Promise<T> | T): Promise<T> {
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP };
  process.env.TEMP = directory; process.env.TMP = directory;
  try { return await work(); }
  finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
}
const git = (cwd: string, ...args: string[]): void => {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "core.autocrlf=false", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args], { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
};

test("Windows temp base: an 8.3-named TEMP is canonicalized to its long name; a TEMP reached through a junction is not resolved",
  { skip }, async t => {
    const base = fusionTemporaryBase();
    const long = await mkdtemp(join(base, "fusion-short-temp-regression-"));
    const target = await mkdtemp(join(base, "fusion-short-temp-target-"));
    const junction = join(base, `fusion-short-temp-junction-${process.pid}`);
    try {
      const short = shortPath(long);
      if (short === undefined) { t.skip("this volume generates no 8.3 short names"); return; }
      assert.equal(await withTemp(short, () => fusionTemporaryBase()), realpathSync.native(long));
      assert.equal(await withTemp(short, () => fusionTemporaryBase()), long, "the long spelling Git and realpath report");
      symlinkSync(target, junction, "junction");
      assert.equal(await withTemp(junction, () => fusionTemporaryBase()), resolve(junction),
        "a linked temporary directory is returned as named, never resolved to its target");
    } finally {
      try { unlinkSync(junction); } catch { /* not created */ }
      await rm(long, { recursive: true, force: true });
      await rm(target, { recursive: true, force: true });
    }
  });

test("Windows temp base: a private Writer candidate opens, proves its unshared Git state and closes under an 8.3-named TEMP",
  { skip }, async t => {
    const base = fusionTemporaryBase();
    const dir = await mkdtemp(join(base, "fusion-short-temp-writer-"));
    try {
      const short = shortPath(dir);
      if (short === undefined) { t.skip("this volume generates no 8.3 short names"); return; }
      const root = join(dir, "primary");
      await mkdir(root);
      git(root, "init", "-q");
      await writeFile(join(root, "a.txt"), "base\n");
      git(root, "add", "."); git(root, "commit", "-qm", "base");
      await withTemp(short, async () => {
        // Before canonicalization this failed closed with "The reconstructed repository has shared or incomplete Git state."
        const writer = await PrivateWriterWorkspace.open(root, "owner-short-temp", await ProcessGitClient.fromPath(process.env, true), undefined);
        try {
          assert.ok(writer.path.toLowerCase().startsWith(`${dir.toLowerCase()}${sep}`), "the candidate lies under the canonical temp base");
          assert.ok(!writer.path.includes("~"), "no 8.3 spelling reaches Fusion's exact comparisons");
        } finally { await writer.close("owner-short-temp", { discardChanges: true }); }
      });
    } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
  });
