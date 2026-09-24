import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeOwnedTemporary } from "../fs/temporary.js";
import { evaluateBackendEvidence } from "./backend-evidence.js";
import { createProductionDockerBackend, DOCKER_REQUIRED_EVIDENCE_FACTS, isProductionDockerBackend,
  observedDockerEvidence } from "./docker/backend.js";
import { imageDigest, PRODUCTION_DOCKER_IMAGE, PRODUCTION_NODE_VERSION } from "./docker/config.js";
import { brandGrantedAcceptance, LINUX_VERIFICATION_CONTRACT, type AcceptanceRefusal,
  type VerificationIsolationAcceptance } from "./acceptance.js";
import type { VerificationBackend } from "./backend.js";

export { acceptedBackendOf, isGrantedAcceptance, LINUX_VERIFICATION_CONTRACT, type AcceptanceRefusal,
  type VerificationIsolationAcceptance } from "./acceptance.js";

/**
 * Production composition and the verification-isolation ACCEPTANCE AUTHORITY. A backend never self-declares
 * eligibility (`productionEligible` stays `false` on every backend); only this authority can grant an acceptance, and
 * only narrowly:
 *
 *   "On this validated Docker Desktop Linux runtime, the DockerLinux verification backend satisfies Fusion's V0.1
 *    confinement contract for eligible platform-neutral / linux-compatible tasks."
 *
 * Requirements, all mechanical: (1) the backend is an instance made by `createProductionDockerBackend` (the pinned
 * production image, the real docker CLI, no test seam) — a fake or reconfigured backend can never qualify; (2) the
 * evidence object was produced by THAT instance's own `collectEvidence` in this process — a hand-built or fixture
 * evidence object, however "complete", is unknown to the authority; (3) every required narrow fact was observed passing;
 * (4) the observed engine, image digest, architecture and in-guest Node version match the pinned runtime, on the
 * validated Docker Desktop Linux/WSL2 engine; (5) the
 * evidence is fresh. The acceptance is an in-memory object, never persisted or parsed back, and it says nothing about
 * Windows: `windowsAccepted` is the constant `false`.
 */
/** The runtime the V0.1 evidence was validated on; another engine (native Linux, remote, rootless) is out of scope. */
export const VALIDATED_ENGINE = Object.freeze({ platformName: /^Docker Desktop \d+\.\d+\.\d+/u, kernel: /-microsoft-standard-WSL2$/u });
export const ACCEPTANCE_MAX_AGE_MS = 60 * 60_000;
export const ACCEPTANCE_SCOPE = "On this validated Docker Desktop Linux runtime, the docker-linux verification backend satisfies " +
  "Fusion's V0.1 confinement contract for eligible platform-neutral and linux-compatible tasks. It proves Linux behavior " +
  "only and makes no claim about Windows semantics, VM-grade or kernel isolation, or covert channels.";

export function acceptVerificationIsolation(backend: unknown, evidence: unknown,
  options: Readonly<{ nowMs?: number; maxAgeMs?: number }> = {}): VerificationIsolationAcceptance | AcceptanceRefusal {
  const reasons: string[] = [];
  if (!isProductionDockerBackend(backend)) reasons.push("backend-not-a-production-instance");
  const observed = observedDockerEvidence(evidence);
  if (observed === undefined) reasons.push("evidence-not-observed-by-a-backend");
  else if (observed.backend !== backend) reasons.push("evidence-observed-by-another-backend");
  if (reasons.length > 0 || observed === undefined) return Object.freeze({ accepted: false, reasons: Object.freeze(reasons) });
  const evaluation = evaluateBackendEvidence(evidence as Parameters<typeof evaluateBackendEvidence>[0], DOCKER_REQUIRED_EVIDENCE_FACTS);
  if (!evaluation.complete)
    reasons.push(...[...evaluation.failed, ...evaluation.notObserved, ...evaluation.missing].map(fact => `fact-not-passed:${fact}`));
  if (observed.imageReference !== PRODUCTION_DOCKER_IMAGE || observed.image.id !== imageDigest(PRODUCTION_DOCKER_IMAGE))
    reasons.push("image-not-the-pinned-production-image");
  if (observed.server.os !== "linux" || observed.image.os !== "linux") reasons.push("engine-not-linux");
  if (observed.image.architecture !== observed.server.arch) reasons.push("architecture-mismatch");
  // The narrow claim is about THIS validated runtime: a local Docker Desktop Linux engine on its WSL2 VM kernel.
  if (!VALIDATED_ENGINE.platformName.test(observed.server.platformName) || !VALIDATED_ENGINE.kernel.test(observed.server.kernelVersion))
    reasons.push("engine-not-the-validated-docker-desktop-linux-runtime");
  if (observed.runtime === null || observed.runtime.node !== PRODUCTION_NODE_VERSION || observed.runtime.platform !== "linux")
    reasons.push("guest-runtime-not-the-pinned-node");
  const nowMs = options.nowMs ?? Date.now(), maxAgeMs = options.maxAgeMs ?? ACCEPTANCE_MAX_AGE_MS;
  const age = nowMs - Date.parse(observed.observedAt);
  if (!Number.isFinite(age) || age < -60_000 || age > maxAgeMs) reasons.push("evidence-stale");
  if (reasons.length > 0) return Object.freeze({ accepted: false, reasons: Object.freeze(reasons) });
  const acceptance: VerificationIsolationAcceptance = Object.freeze({ accepted: true, contract: LINUX_VERIFICATION_CONTRACT,
    backendId: (backend as VerificationBackend).id, semantics: "linux", satisfies: Object.freeze(["platform-neutral", "linux-compatible"] as const),
    windowsAccepted: false, scope: ACCEPTANCE_SCOPE,
    runtime: Object.freeze({ engineOs: observed.server.os, engineArch: observed.server.arch, engineVersion: observed.server.version,
      kernel: observed.server.kernelVersion, platformName: observed.server.platformName, image: observed.imageReference,
      imageId: observed.image.id, node: observed.runtime!.node }),
    evidence: Object.freeze({ required: DOCKER_REQUIRED_EVIDENCE_FACTS.length, passed: evaluation.passed.length }),
    observedAt: observed.observedAt });
  return brandGrantedAcceptance(acceptance, backend as object);
}

/**
 * The whole acceptance procedure for one process: the backend must be a production instance and available; it then runs
 * one read-only probe (`node --version` in a throw-away Fusion-owned directory), collects its OWN evidence from that
 * container, disposes it (an incomplete teardown refuses), and the authority decides. Nothing is persisted; a refusal
 * carries only reason codes. This starts Docker work (≈ 9 s on the validated machine) and runs no repository code.
 */
export async function acquireVerificationIsolationAcceptance(backend: unknown,
  options: Readonly<{ signal?: AbortSignal; absentMarkerNames?: readonly string[] }> = {}): Promise<VerificationIsolationAcceptance | AcceptanceRefusal> {
  const refuse = (reason: string): AcceptanceRefusal => Object.freeze({ accepted: false, reasons: Object.freeze([reason]) });
  if (!isProductionDockerBackend(backend)) return refuse("backend-not-a-production-instance");
  const probe = await backend.probe(options.signal);
  if (!probe.available) return refuse("backend-unavailable");
  const root = await mkdtemp(join(tmpdir(), "fusion-acceptance-probe-"));
  try {
    await writeFile(join(root, "package.json"), '{"type":"module"}\n', { flag: "wx" });
    const request = { plan: { commands: [{ id: "version", executable: "/usr/local/bin/node", args: ["--version"], cwd: ".", timeoutMs: 60_000,
      mutationPolicy: "readOnly" as const }] }, workspaceRoot: root, git: {} as never, env: {}, platformRequirement: "linux-compatible" as const,
      ...(options.signal ? { signal: options.signal } : {}) };
    const lease = await backend.prepare(request);
    let evidence: unknown;
    try {
      await backend.run(lease, request);
      evidence = await backend.collectEvidence(lease, { absentMarkerNames: [...(options.absentMarkerNames ?? [])] });
    } finally {
      const teardown = await backend.dispose(lease);
      if (!teardown.complete) evidence = undefined;
    }
    return evidence === undefined ? refuse("evidence-teardown-incomplete") : acceptVerificationIsolation(backend, evidence);
  } finally { await removeOwnedTemporary(root); }
}

/** The production backend set for autonomous Writer verification. The trusted host backend is deliberately absent. */
export function createProductionVerificationBackends(options: Parameters<typeof createProductionDockerBackend>[0] = {}):
  readonly VerificationBackend[] {
  return Object.freeze([createProductionDockerBackend(options)]);
}
