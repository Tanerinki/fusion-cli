// Fusion v0.6 Hyper-V PoC - GUEST FILESYSTEM CANARY (runs INSIDE the --network none Hyper-V worker). Deliberately
// hostile: it tries to touch host/user state OUTSIDE the one approved disposable writer workspace, by every path shape
// (absolute, parent-traversal, \\?\ extended, UNC, drive roots, user-profile env, docker control pipe, pre-seeded and
// self-created reparse points, and the host's REAL primary-workspace path). It emits ONE FS_PROBE_JSON line then exits.
//
// Security model under test: the worker is a SEPARATE Hyper-V VM with its OWN ephemeral filesystem and NO host bind
// mount (argv.assertPipeWorkerArgv forbids mounts), so the host filesystem is simply NOT PRESENT in the VM. Every
// off-workspace write must therefore fail or land only inside the VM's own disposable FS - never on host/Primary state.
// NO secrets are emitted (only path shapes, outcomes, and bounded capability facts).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const spec = JSON.parse(Buffer.from(process.env.FUSION_FS_SPEC || "e30=", "base64").toString("utf8"));
const approvedRoot = String(spec.approvedRoot || "C:\\fusion\\workspace");
const primaryPath = String(spec.primaryWorkspacePath || "D:\\__no_such_primary__");
const PROGRESS = "C:\\fusion\\fs-canary-progress.log";
const prog = m => { try { fs.appendFileSync(PROGRESS, Date.now() + " " + m + "\n"); } catch {} };

// Watchdog: a one-shot probe must never hang the harness (a CPU spin can't be interrupted by a timer, but an I/O stall
// can; this bounds the latter). unref'd so it only fires if the process is otherwise still alive.
const watchdog = setTimeout(() => { try { process.stderr.write("FS_CANARY_WATCHDOG\n"); } catch {} process.exit(3); }, 60000);
if (typeof watchdog.unref === "function") watchdog.unref();

// Try an operation; classify the outcome WITHOUT leaking content. "ok" = the op SUCCEEDED (for a forbidden target that
// is an ESCAPE => FAIL); "denied" = blocked by the OS (ENOENT/EPERM/EACCES/EINVAL/ENOTDIR/UNC-unreachable); "error:*"
// = an unexpected harness error (never silently a pass).
function attemptWrite(target) {
  try {
    const dir = path.dirname(target);
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* dir may be unreachable; the write below decides */ }
    fs.writeFileSync(target, "FUSION_FS_CANARY_PWNED\n");
    // It "succeeded" locally - record WHERE it actually landed (realpath) so the evaluator can tell an in-VM write from
    // a genuine host escape. We never assume success == escape; the host side confirms Primary is untouched regardless.
    let real = target; try { real = fs.realpathSync(target); } catch {}
    return { outcome: "ok", landedReal: real };
  } catch (e) { return { outcome: "denied", code: e && e.code }; }
}
function attemptReadDir(target) {
  try { const n = fs.readdirSync(target).length; return { outcome: "ok", entries: n }; }
  catch (e) { return { outcome: "denied", code: e && e.code }; }
}
function attemptExists(target) { try { return fs.existsSync(target); } catch { return false; } }

const out = {
  marker: "FUSION_FS_CANARY",
  approvedRoot, primaryWorkspacePathProbed: primaryPath,
  facts: {}, positive: {}, negatives: {}, reparse: {}, git: {},
};

(async () => {
  prog("start");

  // ---- capability inventory: what host FS surface is actually visible to the worker? ----------------------------
  const drives = [];
  for (const d of ["C:\\", "D:\\", "E:\\", "F:\\", "G:\\", "Z:\\"]) { if (attemptExists(d)) drives.push(d); }
  out.facts.visibleDriveRoots = drives;
  out.facts.cwd = process.cwd();
  out.facts.tmpdir = os.tmpdir();
  // env PATH-shape presence only (names, never values) - does the worker carry host user-profile env?
  out.facts.envPresence = {
    USERPROFILE: Boolean(process.env.USERPROFILE), APPDATA: Boolean(process.env.APPDATA),
    LOCALAPPDATA: Boolean(process.env.LOCALAPPDATA), TEMP: Boolean(process.env.TEMP), HOMEPATH: Boolean(process.env.HOMEPATH),
  };
  // Does the host's REAL primary-workspace path even EXIST inside the VM? (It must not.)
  out.facts.primaryWorkspacePathExists = attemptExists(primaryPath);
  // Is any .git reachable at the usual spots? (No host repo is mounted, so none must be.)
  out.facts.gitDirExists = attemptExists(path.join(approvedRoot, ".git")) || attemptExists("C:\\fusion\\.git");
  prog("inventory");

  // ---- POSITIVE CONTROL (P1): write/modify/delete inside the approved workspace must SUCCEED --------------------
  try {
    const f = path.join(approvedRoot, "writer-output.txt");
    fs.mkdirSync(approvedRoot, { recursive: true });
    fs.writeFileSync(f, "v1");
    const created = fs.readFileSync(f, "utf8") === "v1";
    fs.writeFileSync(f, "v2-modified");
    const modified = fs.readFileSync(f, "utf8") === "v2-modified";
    const sub = path.join(approvedRoot, "sub"); fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, "nested.txt"), "nested");
    fs.unlinkSync(f);
    const deleted = !fs.existsSync(f);
    out.positive = { outcome: (created && modified && deleted) ? "ok" : "partial", created, modified, deleted, approvedRootReal: (() => { try { return fs.realpathSync(approvedRoot); } catch { return approvedRoot; } })() };
  } catch (e) { out.positive = { outcome: "error", code: e && e.code }; }
  prog("positive");

  // ---- NEGATIVE CONTROLS: every forbidden target, by every path shape. Each records the WRITE attempt outcome and
  //      (for directories) a read attempt. An "ok" that lands on a REAL host path is an escape; the evaluator decides.
  const P = primaryPath;                         // host absolute primary-workspace path, supplied at runtime via the spec
  const pdrive = (P.match(/^[A-Za-z]:/) || ["C:"])[0];
  const negTargets = {
    N1_primaryWriteExisting: path.join(P, "package.json"),           // modify an existing Primary file
    N3_primaryCreateNew: path.join(P, "FUSION_PWNED_NEW.txt"),       // create a new Primary file
    N5_parentTraversal: path.join(approvedRoot, "..", "..", "..", "..", "..", "FUSION_PWNED_TRAVERSAL.txt"),
    N6_primaryAbsolute: path.join(P, "src", "FUSION_PWNED_ABS.txt"),
    N7_extendedLength: "\\\\?\\" + path.join(P, "FUSION_PWNED_EXT.txt"),
    N8_uncAdminShare: "\\\\127.0.0.1\\" + pdrive.replace(":", "$") + "\\FUSION_PWNED_UNC.txt",
    N9_otherDriveRoot: "C:\\FUSION_PWNED_CROOT.txt",                 // write to another drive root
    N13_hostRepoParent: path.join(P, "..", "FUSION_PWNED_PARENT.txt"),
    N15_fusionHostControl: path.join(P, "tools", "hyperv-poc", "FUSION_PWNED_EVIDENCE.json"),
  };
  for (const [k, t] of Object.entries(negTargets)) { out.negatives[k] = { target: shape(t), write: attemptWrite(t) }; prog("neg " + k); }
  // N10 user-profile dirs (read + write), by env and by the canonical absolute host path
  out.negatives.N10_userProfileEnv = { target: "%USERPROFILE%", exists: Boolean(process.env.USERPROFILE) && attemptExists(process.env.USERPROFILE), write: process.env.USERPROFILE ? attemptWrite(path.join(process.env.USERPROFILE, "FUSION_PWNED_PROFILE.txt")) : { outcome: "denied", code: "NOENV" } };
  // N14 docker engine control pipe (must not be present/openable as a path)
  out.negatives.N14_dockerEnginePipe = { target: "\\\\.\\pipe\\docker_engine", exists: attemptExists("\\\\.\\pipe\\docker_engine") };
  // N9b read attempts on drive roots other than the VM's own system drive (to inventory cross-drive visibility)
  out.negatives.N9b_driveRootReads = Object.fromEntries(["C:\\", "D:\\", "E:\\"].map(d => [d, attemptReadDir(d)]));
  prog("negatives-done");

  // ---- REPARSE / SYMLINK / JUNCTION (mandatory on Windows) ------------------------------------------------------
  // (A) pre-seeded reparse in the image/source snapshot pointing at the host Primary path (seeded by the orchestrator
  //     if the OS allowed it): can the writer write THROUGH it to escape? (B) the writer tries to CREATE its own.
  out.reparse.preSeeded = (() => {
    const link = path.join(approvedRoot, "seeded-link");
    if (!attemptExists(link)) return { outcome: "not_applicable", reason: "no pre-seeded reparse present" };
    const w = attemptWrite(path.join(link, "FUSION_PWNED_VIA_SEED.txt"));
    let real = null; try { real = fs.realpathSync(link); } catch {}
    return { present: true, write: w, resolvesTo: shape(real) };
  })();
  out.reparse.selfCreated = (() => {
    const results = {};
    const candidates = [
      ["dirJunction", () => fs.symlinkSync(primaryPath, path.join(approvedRoot, "jx"), "junction")],
      ["dirSymlink", () => fs.symlinkSync(primaryPath, path.join(approvedRoot, "lnk"), "dir")],
      ["fileSymlinkAbs", () => fs.symlinkSync(path.join(primaryPath, "package.json"), path.join(approvedRoot, "lnkf"), "file")],
    ];
    for (const [name, mk] of candidates) {
      try {
        mk();
        // created a reparse - now try to write THROUGH it to escape to the host target
        const thru = name.startsWith("file") ? null : attemptWrite(path.join(approvedRoot, name === "dirJunction" ? "jx" : "lnk", "FUSION_PWNED_THRU.txt"));
        let real = null; try { real = fs.realpathSync(path.join(approvedRoot, name === "dirJunction" ? "jx" : name === "dirSymlink" ? "lnk" : "lnkf")); } catch {}
        results[name] = { created: true, writeThrough: thru, resolvesTo: shape(real) };
      } catch (e) { results[name] = { created: false, code: e && e.code }; } // EPERM/EINVAL => cannot create (fine)
    }
    return results;
  })();
  prog("reparse-done");

  // ---- GIT SHARED STATE: no host .git is mounted, so none must be reachable to influence Primary ----------------
  out.git = {
    dotGitFileInWorkspace: attemptExists(path.join(approvedRoot, ".git")),
    primaryGitReachable: attemptExists(path.join(primaryPath, ".git")),
    canWritePrimaryGitConfig: attemptWrite(path.join(primaryPath, ".git", "config")),
    canWritePrimaryGitHooks: attemptWrite(path.join(primaryPath, ".git", "hooks", "pre-commit")),
  };
  prog("git-done");

  // Result manifest: the LEGITIMATE files the writer produced under the approved workspace, as relative forward-slash
  // paths (regular files only; reparse links are not followed). Fusion receives this on stdout (a host-controlled pull;
  // `docker cp` is unsupported for a running Hyper-V container) and independently re-validates every path before any
  // host-side application. (After the positive control, the surviving entry is sub/nested.txt.)
  out.resultEntries = (() => {
    const files = [];
    const walk = dir => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of ents) { const full = path.join(dir, e.name);
        let st = null; try { st = fs.lstatSync(full); } catch { continue; }
        if (st.isSymbolicLink()) continue;                                   // never follow a reparse into the manifest
        if (st.isDirectory()) walk(full);
        else files.push(path.relative(approvedRoot, full).replace(/\\/g, "/")); } };
    walk(approvedRoot);
    return files;
  })();
  prog("result-entries");

  const line = "FS_PROBE_JSON " + JSON.stringify(out) + "\n";
  try { fs.writeFileSync("C:\\fusion\\fs-probe-result.json", JSON.stringify(out)); } catch {}
  prog("emit");
  clearTimeout(watchdog);
  process.stdout.write(line, () => process.exit(0));
})();

// Reduce a concrete path to a non-sensitive SHAPE (drive letter class + whether it targets the probed primary), never
// echoing a full host path or any content. Keeps evidence auditable without leaking the host layout.
function shape(p) {
  if (p == null) return null;
  const s = String(p);
  return {
    kind: s.startsWith("\\\\?\\") ? "extended" : s.startsWith("\\\\") ? "unc" : /^[A-Za-z]:/.test(s) ? "drive-abs" : "relative",
    underApprovedRoot: s.toLowerCase().startsWith(approvedRoot.toLowerCase()),
    targetsPrimary: s.toLowerCase().includes(String(spec.primaryWorkspaceLeaf || "fusion-cli").toLowerCase()),
    len: s.length,
  };
}
