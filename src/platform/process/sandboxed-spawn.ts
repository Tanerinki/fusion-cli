import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LauncherIdentity, runSpecDocument, type SandboxRunSpec } from "../isolation/appcontainer-backend.js";
import { launcherHostEnv } from "../isolation/appcontainer-backend.js";

/**
 * v0.6 I10 — SANDBOXED SPAWN: the resolved instruction that makes `ProcessSupervisor.start` launch a process INSIDE the
 * AppContainer instead of directly. The supervisor spawns `executable args` (the native launcher with a run spec); the
 * launcher creates the no-capability AppContainer, applies the grants and minimized env, runs the real target inside a
 * kill-on-close Job and bridges stdio transparently, exiting with the child's exit code. So the supervisor's own
 * streaming/timeout/cancel/kill machinery operates unchanged — killing the launcher closes the Job and the whole
 * sandboxed tree dies.
 *
 * Fail-closed is structural: when the backend is unavailable, `available` is false and the supervisor REFUSES to start —
 * it never falls back to running the target unsandboxed. Only omitting `sandbox` entirely runs unsandboxed, which is a
 * deliberate choice for trusted host tools (git, the verifier), never a silent downgrade of a HARD request.
 */
export interface SandboxLaunch {
  /** false ⇒ the HARD sandbox backend is unavailable; the supervisor fails closed and starts nothing. */
  readonly available: boolean;
  /** The launcher executable the supervisor actually spawns (the real `fusion-sandbox.exe`). */
  readonly executable: string;
  /** The launcher arguments (`--spec <spec.json> --result <result.json>`). */
  readonly args: readonly string[];
  /** The LAUNCHER's own host-profile environment (never the child's — the child's minimized env is inside the spec). */
  readonly launcherEnv: Readonly<Record<string, string>>;
  /** The launcher's working directory (its scratch, where spec/result live). */
  readonly cwd: string;
  /** The logical target executable, for the outcome/records (what a caller asked to run, run sandboxed). */
  readonly logicalExecutable: string;
  /** Where the launcher writes its bounded run result (exit code, timedOut, jobTotalProcesses). */
  readonly resultPath: string;
  /** Removes the launcher scratch (spec/result). Best-effort; called once the process has settled. */
  cleanup(): Promise<void>;
}

/** The fail-closed launch: the supervisor refuses to start, never running the target unsandboxed. */
export function unavailableSandboxLaunch(logicalExecutable: string): SandboxLaunch {
  return Object.freeze({ available: false, executable: logicalExecutable, args: Object.freeze([]),
    launcherEnv: Object.freeze({}), cwd: "", logicalExecutable, resultPath: "", cleanup: () => Promise.resolve() });
}

/**
 * Prepares a sandboxed launch from a located launcher and a run spec. A `null` launcher (the backend is not built) yields
 * a fail-closed launch. Otherwise the run spec is written to a fresh scratch directory and the launcher command is built;
 * the returned `cleanup` removes that scratch.
 */
export async function prepareSandboxLaunch(launcher: LauncherIdentity | null, spec: SandboxRunSpec,
  options: Readonly<{ tempBase?: string }> = {}): Promise<SandboxLaunch> {
  if (launcher === null) return unavailableSandboxLaunch(spec.executable);
  const dir = await mkdtemp(join(options.tempBase ?? tmpdir(), "fusion-run-"));
  const specPath = join(dir, "spec.json");
  const resultPath = join(dir, "result.json");
  await writeFile(specPath, JSON.stringify(runSpecDocument(spec)), "utf8");
  return Object.freeze({
    available: true, executable: launcher.path, args: Object.freeze(["--spec", specPath, "--result", resultPath]),
    launcherEnv: Object.freeze(launcherHostEnv(dir)), cwd: dir, logicalExecutable: spec.executable, resultPath,
    cleanup: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).then(() => undefined, () => undefined),
  });
}
