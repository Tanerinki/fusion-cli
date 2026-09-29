import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256Hex } from "../../core/delivery/canonical.js";
import type { BackendProbe, EnforcementState, ProbeNote } from "../../core/isolation/posture.js";
import {
  CONFINEMENT_FACTS, evaluateConfinementProof, type ConfinementFact, type ConfinementProofEvaluation,
} from "../verification/confinement-proof.js";
import { ProcessSupervisor } from "../process/supervisor.js";

/**
 * v0.6 — the Windows AppContainer SANDBOX BACKEND, host side. It drives the native `fusion-sandbox.exe` launcher (built
 * from `native/fusion-sandbox/`), which creates a per-execution AppContainer (no capabilities) with explicit filesystem
 * grants inside a kill-on-close Job. This module never itself enforces anything — the OS does; it locates and HASHES the
 * launcher, runs its canary self-test, validates the returned ConfinementProof against that hash and a clock window, and
 * maps the mechanically-observed facts onto the provider-neutral `BackendProbe` the posture layer consumes.
 *
 * No security theater: a dimension is reported `enforced` only when the launcher's canary PROVED OS denial. If the
 * launcher is missing (not built), the probe is `available:false` with `backendMissing`, and a HARD request fails closed.
 */

export const LAUNCHER_RELATIVE = "native/fusion-sandbox/bin/fusion-sandbox.exe";
const LAUNCHER_TIMEOUT_MS = 60_000;

/**
 * Resolves the package root from this file by walking up until a `package.json` with the launcher's `native/` sibling is
 * found — robust whether running from `dist/src/...` or `src/...`.
 */
function repositoryRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json")) && existsSync(join(dir, "native"))) return dir;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return dir;
}

export interface LauncherIdentity {
  readonly path: string;
  readonly sha256: string;
}

/** Finds the built launcher and hashes it. `null` when it is not built (the caller reports `backendMissing`). */
export async function locateLauncher(root = repositoryRoot()): Promise<LauncherIdentity | null> {
  const path = join(root, ...LAUNCHER_RELATIVE.split("/"));
  const info = await stat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return null;
  return { path, sha256: sha256Hex(await readFile(path)) };
}

export interface CanaryOutcome {
  readonly ran: boolean;
  readonly evaluation: ConfinementProofEvaluation | null;
  readonly note: ProbeNote;
}

/**
 * Runs the launcher's canary self-test in a disposable directory and evaluates its ConfinementProof against the pinned
 * launcher hash, the `appcontainer` backend id and a clock window around the run. Disposable canaries only — no secrets.
 */
export async function runConfinementCanary(launcher: LauncherIdentity, options: Readonly<{ tempBase?: string }> = {}): Promise<CanaryOutcome> {
  const base = options.tempBase ?? tmpdir();
  const root = await mkdtemp(join(base, "fusion-canary-"));
  const spec = join(root, "spec.json");
  const result = join(root, "result.json");
  const identity = `fusion.canary.${randomBytes(6).toString("hex")}`;
  const notBeforeMs = Date.now() - 5_000;
  try {
    await writeFile(spec, JSON.stringify({ mode: "canary", identity, root }), "utf8");
    const supervisor = new ProcessSupervisor();
    const running = supervisor.start({
      executable: launcher.path, args: ["--spec", spec, "--result", result], cwd: root,
      // The launcher runs full-trust and needs the user's profile env (AppContainer profiles live under %LOCALAPPDATA%).
      // This is the LAUNCHER's environment, not the sandboxed child's — the child's env is minimized by the launcher.
      env: { SystemRoot: process.env.SystemRoot ?? "C:\\Windows", windir: process.env.windir ?? "C:\\Windows",
        SystemDrive: process.env.SystemDrive ?? "C:", PATH: process.env.PATH ?? "", TEMP: root, TMP: root,
        USERPROFILE: process.env.USERPROFILE ?? "", LOCALAPPDATA: process.env.LOCALAPPDATA ?? "", APPDATA: process.env.APPDATA ?? "" },
      timeoutMs: LAUNCHER_TIMEOUT_MS,
    });
    const outcome = await running.result;
    const text = await readFile(result, "utf8").catch(() => undefined);
    if (text === undefined) return { ran: outcome.issue === undefined, evaluation: null, note: "canaryFailed" };
    const evaluation = evaluateConfinementProof(JSON.parse(text), {
      backend: "appcontainer", helperSha256: launcher.sha256, platform: "win32-x64",
      observedWindow: { notBeforeMs, notAfterMs: Date.now() + 5_000 },
    });
    return { ran: true, evaluation, note: evaluation.complete ? "canaryPassed" : "canaryFailed" };
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(() => undefined);
  }
}

/** The facts that, all passing, prove OS filesystem enforcement. */
const FILESYSTEM_FACTS: readonly ConfinementFact[] = ["grantedReadWorks", "grantedWriteWorks", "ungrantedReadDenied", "ungrantedWriteDenied", "profileIsolation"];
/** The facts that prove process-tree containment. */
const PROCESS_FACTS: readonly ConfinementFact[] = ["descendantContainment", "timeoutEnforced"];
/** The fact that proves deny-by-default network enforcement (allowlist provisioning is a later milestone). */
const NETWORK_FACTS: readonly ConfinementFact[] = ["networkIsolation"];

const allPassed = (evaluation: ConfinementProofEvaluation, facts: readonly ConfinementFact[]): boolean =>
  facts.every(fact => evaluation.passed.includes(fact));

/**
 * PURE mapping from a canary outcome to the provider-neutral `BackendProbe` — the security-critical decision, kept free
 * of I/O so it is directly unit-testable with synthetic evaluations. `launcherPresent:false` ⇒ `backendMissing`. Each
 * dimension is `enforced` only when its facts all passed; `unknown` when no evaluation ran. Network is reported
 * `enforced` only for the deny-by-default posture the no-capability AppContainer gives; an ALLOWLIST needs host-side WFP
 * provisioning (a later milestone), noted with `networkNotProvisioned`.
 */
export function deriveBackendProbe(launcherPresent: boolean, canary: CanaryOutcome | null): BackendProbe {
  if (!launcherPresent)
    return Object.freeze({ backend: "appcontainer", available: false,
      dimensions: Object.freeze({ filesystem: "unavailable" as EnforcementState, network: "unavailable", processTree: "unavailable" }),
      notes: Object.freeze<ProbeNote[]>(["backendMissing"]) });
  const evaluation = canary?.evaluation ?? null;
  const dim = (facts: readonly ConfinementFact[]): EnforcementState =>
    evaluation === null ? "unknown" : allPassed(evaluation, facts) ? "enforced" : "unavailable";
  const notes: ProbeNote[] = [canary?.note ?? "canaryFailed", "networkNotProvisioned"];
  return Object.freeze({
    backend: "appcontainer", available: evaluation !== null && evaluation.complete,
    dimensions: Object.freeze({ filesystem: dim(FILESYSTEM_FACTS), network: dim(NETWORK_FACTS), processTree: dim(PROCESS_FACTS) }),
    notes: Object.freeze([...new Set(notes)]),
  });
}

/**
 * The provider-neutral backend probe for the posture layer: locate + hash the launcher, run its canary self-test, and
 * map the mechanically-observed facts. Builds nothing (the launcher is built by provisioning).
 */
export async function probeAppContainerBackend(options: Readonly<{ tempBase?: string; root?: string }> = {}): Promise<BackendProbe> {
  const launcher = await locateLauncher(options.root);
  if (launcher === null) return deriveBackendProbe(false, null);
  const canary = await runConfinementCanary(launcher, options);
  return deriveBackendProbe(true, canary);
}

export { CONFINEMENT_FACTS };
