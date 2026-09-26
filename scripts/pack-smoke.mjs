// v0.1 packaging smoke test (never publishes). It proves the CLI works OUTSIDE the development folder:
//
//   1. a clean clone of the committed HEAD (default) or this working tree (--worktree) is built and packed with `npm pack`;
//   2. the tarball holds the compiled CLI (and its container guest files) and nothing else of the repository;
//   3. it is installed with `npm install --global --prefix <temp dir with spaces>` (offline: the package has no runtime
//      dependencies), and the installed `fusion` shim runs: --version, --help, config, history, doctor --json.
//
// Everything happens under one temporary directory, removed at the end. Nothing is published, pushed or installed globally
// for the user; no provider is started (doctor without --probe never starts a model).
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKTREE = process.argv.includes("--worktree");
const windows = process.platform === "win32";
const quote = value => (/[\s"&|<>^()]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value);

/** Runs a command (npm and the installed shim are .cmd files on Windows, which need the shell), bounded, no stdin. */
function run(command, args, options = {}) {
  const result = windows
    ? spawnSync([quote(command), ...args.map(quote)].join(" "), { ...options, shell: true, encoding: "utf8", windowsHide: true, timeout: 600_000 })
    : spawnSync(command, args, { ...options, encoding: "utf8", timeout: 600_000 });
  if (result.error) throw result.error;
  return { code: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}
function check(condition, message, detail = "") {
  if (!condition) { console.error(`pack-smoke FAIL: ${message}${detail ? `\n${detail}` : ""}`); process.exitCode = 1; throw new Error(message); }
  console.log(`ok - ${message}`);
}

const temp = mkdtempSync(join(tmpdir(), "fusion pack smoke "));
try {
  // 1. Source: a clean clone of HEAD (what a user would check out), or this working tree.
  let source = REPO;
  if (!WORKTREE) {
    source = join(temp, "clean checkout");
    const cloned = run("git", ["-c", "core.autocrlf=false", "clone", "--quiet", "--no-hardlinks", REPO, source]);
    check(cloned.code === 0, "clean clone of HEAD", cloned.stderr);
    const installed = run("npm", ["ci", "--offline", "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: source });
    check(installed.code === 0, "npm ci (offline, dev dependencies from the local cache)", installed.stderr.slice(-2000));
  }
  const packDir = join(temp, "pack");
  mkdirSync(packDir);
  const packed = run("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: source });
  check(packed.code === 0, "npm pack (prepack builds from source)", packed.stderr.slice(-2000));
  const info = JSON.parse(packed.stdout.slice(packed.stdout.indexOf("[")))[0];
  const files = info.files.map(entry => entry.path);
  const version = JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version;
  check(files.includes("dist/src/cli/main.js"), "the tarball holds the CLI entry point");
  check(files.includes("dist/src/platform/verification/docker/guest-runner.js"), "the tarball holds the confined-verification guest files");
  check(files.every(path => path.startsWith("dist/src/") || ["package.json", "README.md", "SECURITY.md", "CHANGELOG.md"].includes(path)),
    "nothing else of the repository is packed (no tests, sources, evidence or research files)", files.filter(path => !path.startsWith("dist/src/")).join("\n"));
  check(!files.some(path => path.endsWith(".ts") || path.includes(".fusion/") || path.includes("/test/")), "no TypeScript sources, run evidence or tests");

  // 2. Install into a private prefix (a path with spaces) and run the installed shim.
  const prefix = join(temp, "global prefix");
  const tarball = join(packDir, info.filename);
  const install = run("npm", ["install", "--global", "--prefix", prefix, tarball, "--offline", "--no-audit", "--no-fund"]);
  check(install.code === 0, "npm install --global into a private prefix (no runtime dependencies)", install.stderr.slice(-2000));
  const bin = windows ? join(prefix, "fusion.cmd") : join(prefix, "bin", "fusion");
  check(existsSync(bin), `the fusion shim exists (${bin})`);
  const fusion = (args, cwd) => run(bin, args, { cwd });

  const work = join(temp, "work area");
  mkdirSync(work);
  const shownVersion = fusion(["--version"], work);
  check(shownVersion.code === 0 && shownVersion.stdout.trim() === `fusion ${version}`, `fusion --version prints ${version}`, shownVersion.stdout + shownVersion.stderr);
  const help = fusion(["--help"], work);
  check(help.code === 0 && help.stdout.startsWith("Usage: fusion") && help.stdout.includes("  create ") && help.stdout.includes("  history "),
    "fusion --help lists the v0.1 commands", help.stderr);
  const config = fusion(["config"], work);
  check(config.code === 0 && config.stdout.includes("run evidence: not in a Git repository"), "fusion config runs outside a repository", config.stdout + config.stderr);

  const repo = join(work, "a project");
  mkdirSync(repo);
  check(run("git", ["init", "-q"], { cwd: repo }).code === 0, "a scratch repository for the installed CLI");
  writeFileSync(join(repo, "README.md"), "# scratch\n");
  const history = fusion(["history"], repo);
  check(history.code === 0 && history.stdout.includes("No recorded runs yet"), "fusion history runs in a repository", history.stdout + history.stderr);
  const inventory = fusion(["analyze", "--inventory-only"], repo);
  check(inventory.code === 0, "fusion analyze --inventory-only runs (no provider)", inventory.stdout + inventory.stderr);
  const doctor = fusion(["--json", "doctor"], repo);
  let document;
  try { document = JSON.parse(doctor.stdout); } catch { document = undefined; }
  check(document !== undefined && document.command === "doctor" && document.exitCode === doctor.code,
    `fusion --json doctor reports (exit ${doctor.code}; provider CLIs and Docker are reported, not required here)`, doctor.stderr);
  const create = fusion(["create", "--json", "a library"], work);
  check(create.code === 2, "fusion create refuses to run unattended (--json)", create.stderr);
  console.log(`pack-smoke PASS (${info.filename}, ${files.length} files, ${info.size} bytes packed; source: ${WORKTREE ? "working tree" : "clean clone of HEAD"})`);
} finally {
  rmSync(temp, { recursive: true, force: true, maxRetries: 5 });
}
