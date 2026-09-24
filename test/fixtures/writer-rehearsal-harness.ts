import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { DelegationPacket, ReviewerFinding } from "../../src/core/domain.js";
import type { TaskRequest } from "../../src/core/policy/task-inspector.js";
import { WorkflowEngine } from "../../src/core/workflow/engine.js";
import type { CleanupReport, EventSink, VerificationVerdict, WorkflowEvent, WorkflowRequest, WorkflowResult,
  WorkspaceHandle } from "../../src/core/workflow/types.js";
import { DockerLinuxVerificationBackend, type DockerVerificationExecutionResult } from "../../src/platform/verification/docker/backend.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort, type CandidateVerificationObservation,
  type PrivateCandidatePortOptions } from "../../src/platform/workflow/candidates.js";
import { ProviderViewWorkspacePort } from "../../src/platform/workflow/ports.js";
import { ProcessGitClient } from "../../src/platform/workspace/git.js";
import { ProviderViewStore } from "../../src/platform/workspace/provider-views.js";
import { providerWorkspaceStatePaths } from "../../src/runtime/provider-profiles.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext, type AttachReply, type FakeDockerOptions } from "./fake-docker.js";
import { changeSet, oracle, scriptedRoles, testSummary, type Script, type Spy } from "./fake-writer.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG, REHEARSAL_FILES,
  REHEARSAL_PLAN } from "./rehearsal-project.js";

export const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
export function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=Fusion Test", "-c", "user.email=fusion@example.invalid", "-c", "commit.gpgsign=false",
    "-c", "init.defaultBranch=main", "-c", "core.autocrlf=false", "-c", `core.hooksPath=${join(cwd, ".no-hooks")}`, ...args],
  { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
  return result.stdout;
}

/** Synthetic canaries planted in the primary checkout; none may ever reach a candidate, a container, an event or an artifact. */
export const CANARIES = Object.freeze({
  env: "FUSION-CANARY-ENV-8d1f02c7",
  ignored: "FUSION-CANARY-IGNORED-4b9e",
  untracked: "FUSION-CANARY-UNTRACKED-77aa",
  uncommitted: "FUSION-CANARY-UNCOMMITTED-2f3c",
  nodeModules: "FUSION-CANARY-NODE-MODULES-91d0",
});

/**
 * Before/after evidence of the user's primary checkout: `git status` (ignored files included), HEAD, the index, every
 * file's SHA-256 (tracked, untracked AND ignored — a full walk, not only what Git reports) and every `.git` file. Only
 * Fusion's own self-ignored run storage (`.fusion/`) is excluded: `fusion build` legitimately records runs there.
 */
export interface PrimaryEvidence {
  readonly status: string;
  readonly head: string;
  readonly files: Readonly<Record<string, string>>;
}
export async function primaryEvidence(root: string): Promise<PrimaryEvidence> {
  const files: Record<string, string> = {};
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name), rel = relative(root, path).split(sep).join("/");
    if (!entry.isFile() || rel === ".fusion" || rel.startsWith(".fusion/")) continue;
    files[rel] = createHash("sha256").update(await readFile(path)).digest("hex");
  }
  const status = git(root, "--no-optional-locks", "status", "--porcelain=v1", "-uall", "--ignored").split("\n").filter(line => !line.startsWith("!! .fusion/")).join("\n");
  return { status, head: git(root, "rev-parse", "HEAD").trim(),
    files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) };
}

export interface RehearsalRepo { readonly dir: string; readonly root: string; readonly before: PrimaryEvidence }
/**
 * A primary checkout of the rehearsal project with every class of user state a Writer must never touch: an uncommitted
 * edit, an untracked file, ignored secrets and an ignored (untrusted) `node_modules`.
 */
export async function withRehearsalRepo<T>(run: (repo: RehearsalRepo) => Promise<T>,
  options: Readonly<{ extraFiles?: Readonly<Record<string, string>> }> = {}): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-b7-"));
  try {
    const root = join(dir, "primary");
    for (const [path, content] of Object.entries({ ...REHEARSAL_FILES, ...options.extraFiles })) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), content);
    }
    git(root, "init", "-q");
    git(root, "add", ".");
    git(root, "commit", "-qm", "baseline");
    await writeFile(join(root, "CHANGELOG.md"), `${REHEARSAL_FILES["CHANGELOG.md"]}- ${CANARIES.uncommitted}\n`);
    await writeFile(join(root, "notes.txt"), `${CANARIES.untracked}\n`);
    await writeFile(join(root, ".env"), `API_TOKEN=${CANARIES.env}\n`);
    await writeFile(join(root, "secrets.local"), `${CANARIES.ignored}\n`);
    await mkdir(join(root, "node_modules", "zod"), { recursive: true });
    await writeFile(join(root, "node_modules", "zod", "index.js"), `module.exports = "${CANARIES.nodeModules}";\n`);
    const before = await primaryEvidence(root);
    return await run({ dir, root, before });
  } finally {
    if (!resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`)) throw new Error("fixture escaped tmpdir");
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * The deterministic stand-in for the pinned container running REHEARSAL_PLAN, validated against the real project on a
 * real Node 22.20 + TypeScript 5.9.3 install: the type check passes with the dependency tree present; the unit run
 * fails 1 of 10 tests on the baseline, 2 of 11 for the wrong fix, and passes 11 of 11 for the correct fix. It decides
 * only from the files the real backend streamed.
 */
export function rehearsalOracle(observed?: AttachContext[]): (context: AttachContext) => AttachReply {
  return oracle((command, context) => {
    const deps = (name: string): boolean => context.dependencyFiles?.has(`${name}/package.json`) === true;
    const text = (path: string): string => context.files.get(path)?.toString("utf8") ?? "";
    if (command.id === "typecheck") {
      const ok = deps("typescript") && deps("@types/node") && deps("zod") && ![...context.files.values()].some(file => file.includes("BROKEN_TYPES"));
      return { pass: ok, stdout: ok ? "" : "src/quote.ts(1,1): error TS2307: Cannot find module.\n" };
    }
    if (command.id === "unit") {
      const fixed = text("src/quote.ts").includes("basisPoints(subtotal - discount, quote.taxBasisPoints)") && deps("zod") && deps("ms") && deps("semver");
      const regression = text("test/quote.test.ts").includes("a full discount leaves nothing to tax");
      const total = regression ? 11 : 10, failed = fixed ? 0 : regression ? 2 : 1;
      return { pass: failed === 0, stdout: testSummary(total - failed, failed) };
    }
    return { pass: false, stdout: "unknown command\n" };
  }, observed);
}

export interface Rig {
  readonly fake: FakeDocker;
  readonly backend: DockerLinuxVerificationBackend;
  readonly port: PrivateCandidateWorkspacePort;
  /** The real provider-view store and port over the real candidate port (as `fusion build` composes them). */
  readonly store: ProviderViewStore;
  readonly views: ProviderViewWorkspacePort;
  readonly streamed: AttachContext[];
  readonly verifications: CandidateVerificationObservation[];
}
/** Provider state paths excluded from every view, as the default registry declares them. */
export const VIEW_EXCLUSIONS = providerWorkspaceStatePaths();
export function viewsOver(root: string, git: ProcessGitClient, port: PrivateCandidateWorkspacePort):
  Readonly<{ store: ProviderViewStore; views: ProviderViewWorkspacePort }> {
  const store = new ProviderViewStore({ primaryRoot: root, git, excludedPaths: VIEW_EXCLUSIONS });
  return { store, views: new ProviderViewWorkspacePort(store, port) };
}
/** The real candidate port, the real verification service and the real Docker backend over an in-memory daemon. */
export async function rig(repo: RehearsalRepo, options: Readonly<{ docker?: FakeDockerOptions; port?: Partial<PrivateCandidatePortOptions> }> = {}):
  Promise<Rig> {
  const streamed: AttachContext[] = [];
  const verifications: CandidateVerificationObservation[] = [];
  const fake = new FakeDocker({ attach: rehearsalOracle(streamed), depsTree: FAKE_DEPENDENCY_TREE, ...options.docker });
  const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: fake, resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
    dependencyStoreDirectory: join(repo.dir, "dependency-store") });
  const git = await ProcessGitClient.fromPath(process.env, true);
  const port = new PrivateCandidateWorkspacePort({ primaryRoot: repo.root, git,
    service: new VerificationService([backend]), confinement: OFFLINE_REHEARSAL, declaredPlatform: "linux-compatible",
    dependencies: "npm-lockfile", prepareDependencies: true, onVerification: observation => verifications.push(observation), ...options.port });
  return { fake, backend, port, ...viewsOver(repo.root, git, port), streamed, verifications };
}

/** Wraps a port to observe candidate handles or inject a failed release, delegating everything else. */
export class ObservedPort extends PrivateCandidateWorkspacePort {
  readonly handles: WorkspaceHandle[] = [];
  readonly releases: CleanupReport[] = [];
  failRelease?: (handle: WorkspaceHandle) => boolean;
  override async acquire(ownerId: string, signal?: AbortSignal): Promise<WorkspaceHandle> {
    const handle = await super.acquire(ownerId, signal);
    this.handles.push(handle);
    return handle;
  }
  override async release(handle: WorkspaceHandle): Promise<CleanupReport> {
    if (this.failRelease?.(handle) === true) {
      this.releases.push({ complete: false, reason: "injected" });
      return { complete: false, reason: "injected" };
    }
    const report = await super.release(handle);
    this.releases.push(report);
    return report;
  }
  /** Test cleanup for an injected failure: really remove it now. */
  async forceRelease(handle: WorkspaceHandle): Promise<CleanupReport> { return super.release(handle); }
}
export async function observedRig(repo: RehearsalRepo, options: Readonly<{ docker?: FakeDockerOptions; port?: Partial<PrivateCandidatePortOptions> }> = {}):
  Promise<Rig & { readonly port: ObservedPort }> {
  const base = await rig(repo, options);
  const git = await ProcessGitClient.fromPath(process.env, true);
  const port = new ObservedPort({ primaryRoot: repo.root, git,
    service: new VerificationService([base.backend]), confinement: OFFLINE_REHEARSAL, declaredPlatform: "linux-compatible",
    dependencies: "npm-lockfile", prepareDependencies: true, onVerification: observation => base.verifications.push(observation), ...options.port });
  return { ...base, port, ...viewsOver(repo.root, git, port) };
}
export const candidateGone = (handle: WorkspaceHandle): boolean => !existsSync(dirname(handle.path));

// ---------------------------------------------------------------- tasks and proposals

const ACCEPTANCE = ["Every unit test passes.", "The TypeScript type check passes.", "A regression test covers a full discount."];
/**
 * The representative MEDIUM task: fix the bug and add a regression test. Two files (medium), one of them a test the
 * verification plan runs, so the policy requires a fresh Reviewer and Lead adjudication even at medium.
 */
export const MEDIUM_TASK: TaskRequest = { operation: "implement", summary: "Fix quote totals: tax applies to the discounted subtotal. Add a regression test.",
  paths: ["src/quote.ts", "test/quote.test.ts"], scopeKnown: true, expectedMutation: "multiFile", requestedCapabilities: { write: true },
  verification: { required: true, planProvided: true } };
export const MEDIUM_PACKET: DelegationPacket = {
  task: { goal: MEDIUM_TASK.summary, constraints: ["Keep the public API of src/quote.ts."], acceptanceCriteria: ACCEPTANCE },
  scope: { relevantFiles: ["src/quote.ts", "src/money.ts", "test/quote.test.ts"], allowedFiles: ["src/quote.ts", "test/quote.test.ts"],
    forbiddenFiles: ["package.json", "package-lock.json"] },
  architecture: { decisions: ["Money stays integer cents."], invariants: ["Rates are basis points.", "No new dependencies."] },
  verification: { requiredTests: ["typecheck", "unit"] }, openQuestions: [] };
/** The same change at HIGH risk (an architecture-wide change): a correction is available after a confirmed finding. */
export const HIGH_TASK: TaskRequest = { ...MEDIUM_TASK, indicators: { architectureChange: true } };
/** LOW: one file, no Lead. */
export const LOW_TASK: TaskRequest = { operation: "edit", summary: "Fix quote totals: tax applies to the discounted subtotal.",
  paths: ["src/quote.ts"], scopeKnown: true, expectedMutation: "singleFile", requestedCapabilities: { write: true },
  verification: { required: true, planProvided: true } };
export const LOW_PACKET: DelegationPacket = { ...MEDIUM_PACKET, task: { ...MEDIUM_PACKET.task, goal: LOW_TASK.summary },
  scope: { ...MEDIUM_PACKET.scope, relevantFiles: ["src/quote.ts"], allowedFiles: ["src/quote.ts"] } };

let counter = 0;
export function rehearsalRequest(task: TaskRequest = MEDIUM_TASK, patch: Partial<WorkflowRequest> = {}): WorkflowRequest {
  const packet = task.expectedMutation === "singleFile" ? LOW_PACKET : MEDIUM_PACKET;
  return { runId: `b7-run-${++counter}`, task, packet, verification: REHEARSAL_PLAN, ...patch };
}

/** The correct, complete ChangeSet: the fix plus the regression test, against the committed baseline. */
export const FIX = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);
export const FIX_ONLY = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_FIXED]]);
/** A plausible but wrong fix with the regression test: the confined run fails 2 of 11 tests. */
export const WRONG = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);

// ---------------------------------------------------------------- one rehearsal through the real engine

export class RecordingSink implements EventSink {
  readonly events: WorkflowEvent[] = [];
  async append(event: WorkflowEvent): Promise<void> { this.events.push(structuredClone(event)); }
}
export type ObservedRig = Awaited<ReturnType<typeof observedRig>>;
export interface RehearsalContext { readonly repo: RehearsalRepo; readonly result: WorkflowResult; readonly spy: Spy; readonly rig: ObservedRig;
  readonly events: WorkflowEvent[]; readonly after: PrimaryEvidence; readonly hostVerifications: number }
/**
 * One rehearsal through the real WorkflowEngine: scripted fake roles, the real candidate port over real Git, the real
 * verification service and the real Docker backend over the in-memory daemon. The primary-workspace verifier throws:
 * a Writer candidate must never reach it.
 */
export async function rehearse(script: Script, check: (ctx: RehearsalContext) => Promise<void> | void, options: Readonly<{ task?: TaskRequest;
  request?: Partial<WorkflowRequest>; docker?: FakeDockerOptions; port?: Partial<PrivateCandidatePortOptions>;
  roles?: Parameters<typeof scriptedRoles>[1]; repo?: Parameters<typeof withRehearsalRepo>[1];
  before?: (rig: ObservedRig) => void }> = {}): Promise<void> {
  await withRehearsalRepo(async repo => {
    const rig = await observedRig(repo, { ...(options.docker ? { docker: options.docker } : {}), ...(options.port ? { port: options.port } : {}) });
    options.before?.(rig);
    const { roles, spy } = scriptedRoles(script, options.roles);
    const sink = new RecordingSink();
    let hostVerifications = 0;
    const engine = new WorkflowEngine({ roles, workspace: rig.port, views: rig.views, events: sink,
      verifier: { verify: () => { hostVerifications++; throw new Error("a Writer candidate is never verified on the host"); } } });
    const result = await engine.run(rehearsalRequest(options.task ?? MEDIUM_TASK, options.request));
    try { await check({ repo, result, spy, rig, events: sink.events, after: await primaryEvidence(repo.root), hostVerifications }); }
    finally {
      for (const handle of rig.port.handles) if (!candidateGone(handle)) await rig.port.forceRelease(handle);
      for (const view of rig.store.live()) await rig.store.release(view.viewId);
    }
  }, options.repo);
}
export const transitionsOf = (result: WorkflowResult): string[] => result.transitions.map(t => `${t.from}>${t.to}:${t.reason}`);
/**
 * The candidate port alone (no engine, no provider): acquire a fresh candidate, host-apply FIX, verify with the given
 * port options, release. For refusals that are decided by the port before any container exists.
 */
export async function directVerify(port: Partial<PrivateCandidatePortOptions>): Promise<Readonly<{ verdict: VerificationVerdict;
  containers: number; released: CleanupReport }>> {
  return withRehearsalRepo(async repo => {
    const r = await rig(repo, { port });
    const handle = await r.port.acquire("b7-direct.worker");
    let verdict: VerificationVerdict, released: CleanupReport;
    try {
      const applied = await r.port.apply(handle, FIX, { allowedPaths: ["src/quote.ts", "test/quote.test.ts"], forbiddenPaths: [] });
      if (!("applied" in applied)) throw new Error("the fixture ChangeSet must apply");
      verdict = await r.port.verify(handle, REHEARSAL_PLAN);
    } finally { released = await r.port.release(handle); }
    return { verdict, containers: r.fake.commands("create").length, released };
  });
}
export function blocker(id: string, severity: ReviewerFinding["severity"], patch: Partial<ReviewerFinding> = {}): ReviewerFinding {
  return { id, severity, confidence: "HIGH", category: "tests", file: "test/quote.test.ts", title: `${severity}: no regression test for a full discount`,
    evidence: ["The change fixes the taxable amount but no test pins the 100 % discount case."],
    failureScenario: "A later refactor taxes a fully discounted quote again and nothing fails.",
    suggestedFix: "Add a test where a 100 % discount leaves nothing to tax.", ...patch };
}
export const WORKER_SECRET = "WORKER-HIDDEN-RATIONALE-3e9a";
/** A Worker proposing `changes` that also tries every envelope side channel to reach later roles with its rationale. */
export const sneakyWorker = (changes: unknown) => ({ session }: { session: { provider: string } }) => ({ status: "completed", output: changes,
  effectiveProvider: session.provider, effectiveModel: "fusion-test-scripted", artifactRefs: [`note:${WORKER_SECRET}`],
  usage: { rawUsageArtifact: WORKER_SECRET }, rationale: WORKER_SECRET, thinking: [WORKER_SECRET] });
export const testCountsOf = (rig: Rig, index: number) =>
  (rig.verifications[index]!.outcome.verification.result as DockerVerificationExecutionResult).docker.steps.map(step => [step.id, step.testCounts]);
