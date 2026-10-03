/**
 * Fusion Hyper-V WINDOWS verification guest runner. It runs INSIDE the isolated Hyper-V worker (a separate VM;
 * `--isolation=hyperv`, `--network none`, no host bind mount). It is baked into the per-run worker image next to the
 * candidate snapshot (C:\fusion\candidate) and the pinned node; the host starts it with `docker exec`. It executes the
 * approved VerificationPlan (supplied as base64 JSON in FUSION_HV_PLAN — never a model-generated shell), captures each
 * command's full identity and outcome, and detects any candidate mutation with a pre/post fingerprint, so a
 * `readOnly` command that writes is caught even when it exits 0. It emits exactly one `HV_RESULT_JSON <json>` line on
 * stdout (the host-controlled result channel: there is no host mount and `docker cp` is unsupported for a running
 * Hyper-V container) and exits deterministically. It imports only Node built-ins.
 */
import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { hostname, release } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

interface GuestCommand {
  readonly id: string;
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly mutationPolicy: "readOnly" | "allowMutation";
}
interface GuestPlan {
  readonly commands: readonly GuestCommand[];
  readonly candidateRoot: string;
  readonly nonce: string;
}

const WATCHDOG_MS = 3_600_000;
const wd = setTimeout(() => { try { emit({ fatal: "watchdog" }); } catch { /* ignore */ } process.exit(2); }, WATCHDOG_MS);
(wd as { unref?: () => void }).unref?.();

const MAX_TAIL = 4000;
const sha256 = (buf: Buffer): string => createHash("sha256").update(buf).digest("hex");

/** Recursive sha256 map of the candidate tree (regular files only; a symlink is a marker, never followed). */
function fingerprint(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    let ents;
    try { ents = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(dir, e.name), r = rel ? `${rel}/${e.name}` : e.name;
      let ls;
      try { ls = lstatSync(abs); } catch { continue; }
      if (ls.isSymbolicLink()) { out[r] = "symlink"; continue; }
      if (ls.isDirectory()) { walk(abs, r); continue; }
      if (ls.isFile()) { try { out[r] = sha256(readFileSync(abs)); } catch { out[r] = "unreadable"; } }
    }
  };
  walk(root, "");
  return out;
}
const differs = (a: unknown, b: unknown): boolean => JSON.stringify(a) !== JSON.stringify(b);

let emitted = false;
let base: Record<string, unknown> = {};
function emit(extra?: Record<string, unknown>): void {
  if (emitted) return;
  emitted = true;
  process.stdout.write(`HV_RESULT_JSON ${JSON.stringify({ schema: "v0.6-hv-verify-result-1", ...base, ...(extra ?? {}) })}\n`);
}

try {
  const raw = process.env.FUSION_HV_PLAN;
  if (raw === undefined || raw === "") { emit({ fatal: "no FUSION_HV_PLAN" }); clearTimeout(wd); process.exit(2); }
  const plan = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as GuestPlan;
  const candidateRoot = plan.candidateRoot;
  const minimalEnv: NodeJS.ProcessEnv = { SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP ?? "C:\\Windows\\Temp",
    TMP: process.env.TMP ?? "C:\\Windows\\Temp", FUSION_VERIFY: "1" };

  const before = fingerprint(candidateRoot);
  const results: Record<string, unknown>[] = [];
  const notRun: string[] = [];
  let stop = false;
  for (const cmd of plan.commands) {
    if (stop) { notRun.push(cmd.id); continue; }
    const cwd = resolve(candidateRoot, cmd.cwd && cmd.cwd !== "." ? cmd.cwd : ".");
    const pinned = typeof cmd.executable === "string" && isAbsolute(cmd.executable);
    const preCmd = fingerprint(candidateRoot);
    const t0 = Date.now();
    const r: SpawnSyncReturns<Buffer> | { error: { code: string }; status?: never; signal?: never; stdout?: never; stderr?: never } =
      pinned
        ? spawnSync(cmd.executable, [...cmd.args], { cwd, env: minimalEnv, shell: false, timeout: cmd.timeoutMs,
            maxBuffer: 8 * 1024 * 1024, windowsHide: true })
        : { error: { code: "EXECUTABLE_NOT_PINNED" } };
    const durationMs = Date.now() - t0;
    const postCmd = fingerprint(candidateRoot);
    const mutatedCandidate = differs(preCmd, postCmd);
    const errCode = r.error ? String((r.error as NodeJS.ErrnoException).code ?? (r.error as Error).message) : null;
    const timedOut = errCode === "ETIMEDOUT" || (r.signal === "SIGTERM" && durationMs >= cmd.timeoutMs);
    const spawnError = errCode !== null && errCode !== "ETIMEDOUT" ? errCode : null;
    const stdout = (r.stdout as Buffer | undefined) ?? Buffer.alloc(0);
    const stderr = (r.stderr as Buffer | undefined) ?? Buffer.alloc(0);
    const exitCode = typeof r.status === "number" ? r.status : null;
    const violatesReadOnly = cmd.mutationPolicy === "readOnly" && mutatedCandidate;
    const passed = spawnError === null && !timedOut && exitCode === 0 && !violatesReadOnly;
    results.push({ id: cmd.id, executable: cmd.executable, args: cmd.args, cwd: cmd.cwd, mutationPolicy: cmd.mutationPolicy,
      exitCode, signal: r.signal ?? null, timedOut, cancelled: false, spawnError, durationMs,
      stdoutSha256: sha256(stdout), stdoutBytes: stdout.length, stdoutTail: stdout.subarray(-MAX_TAIL).toString("utf8"),
      stderrSha256: sha256(stderr), stderrBytes: stderr.length, stderrTail: stderr.subarray(-MAX_TAIL).toString("utf8"),
      mutatedCandidate, violatesReadOnly, passed });
    if (!passed) stop = true;
  }
  const after = fingerprint(candidateRoot);

  base = {
    nonce: plan.nonce,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    candidateRoot,
    candidateFingerprintBefore: before,
    candidateFingerprintAfter: after,
    sourceMutated: differs(before, after),
    results,
    notRun,
    host: { workerOsRelease: release(), workerHostname: hostname() },
  };
  emit();
  clearTimeout(wd);
  process.exit(results.length > 0 && results.every(r => r.passed === true) && notRun.length === 0 ? 0 : 1);
} catch (e) {
  emit({ fatal: String((e as Error)?.stack ?? e) });
  clearTimeout(wd);
  process.exit(3);
}
