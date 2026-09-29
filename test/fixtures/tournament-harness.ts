import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunRecorder, summarizeRun, type RunSummary } from "../../src/app/runs.js";
import { runTournament, type TieChoice, type TournamentReport, type TournamentRuntime } from "../../src/app/tournament/run.js";
import type { ChangeSet, VerificationCommand } from "../../src/core/domain.js";
import { canonicalJson } from "../../src/core/delivery/canonical.js";
import { assembleBuildEvidence } from "../../src/core/evidence/build.js";
import { reliabilityPlan, type TaskProfile } from "../../src/core/evidence/policy.js";
import { DiagnosticRedactor } from "../../src/core/policy/redaction.js";
import { inspectTask } from "../../src/core/policy/task-inspector.js";
import type { CandidateId } from "../../src/core/tournament/contracts.js";
import { NO_EXPERIMENTS, type ExperimentSpecs } from "../../src/core/tournament/profile.js";
import { EventStore } from "../../src/platform/events/event-store.js";
import { makeId } from "../../src/platform/events/shared.js";
import type { StoredEvent } from "../../src/platform/events/types.js";
import { changeSet, FAKE_MODEL, FAKE_PROVIDER, scriptedRoles, type Script, type Spy } from "./fake-writer.js";
import { GuestPort, type Program } from "./guest-port.js";
import { MemoryViews } from "./memory-port.js";
import { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG, REHEARSAL_PLAN } from "./rehearsal-project.js";
import { MEDIUM_PACKET, MEDIUM_TASK } from "./writer-rehearsal-harness.js";

/**
 * v0.5 TEST FIXTURE — a tournament over the real v0.4 engine, scripted providers and the in-memory confined guest, recorded by
 * a real RunRecorder (so the summary's binding is exercised). Shared by the orchestration, security and mesh suites.
 */
export const REDACTOR = new DiagnosticRedactor();
export const BASE_COMMIT = "0".repeat(40);
export const PROFILE: TaskProfile = { taskClass: "bugFix", sensitive: false };
export const RELIABILITY = reliabilityPlan(PROFILE, inspectTask(MEDIUM_TASK).risk);
export const BASELINE = { "src/quote.ts": QUOTE_BUGGY, "test/quote.test.ts": QUOTE_TEST };
export const FIXED_LINE = "basisPoints(subtotal - discount, quote.taxBasisPoints)";
export const ALT_FIXED = QUOTE_FIXED.replace(FIXED_LINE, "basisPoints(subtotal - discount,  quote.taxBasisPoints)");
export const change = (quote: string, withTest = true): ChangeSet =>
  changeSet([["src/quote.ts", QUOTE_BUGGY, quote], ...(withTest ? [["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION] as const] : [])]);
export const FIX = change(QUOTE_FIXED), ALT = change(ALT_FIXED), WRONG = change(QUOTE_WRONG), SMALL = change(QUOTE_FIXED, false);
export const API_BREAK = change(`${QUOTE_FIXED}export const leaked = 1;\n`);

/** The confined guest: the unit run passes exactly when the tax applies to the discounted subtotal. */
export const PROGRAM: Program = (command, tree) => {
  const quote = tree.get("src/quote.ts") ?? "";
  const fixed = quote.includes("basisPoints(subtotal - discount,");
  switch (command.id) {
    case "typecheck": return { exit: 0, stdout: "" };
    case "unit": return { exit: fixed ? 0 : 1, stdout: fixed ? "pass\n" : "fail\n" };
    case "probe-api": return { exit: 0, stdout: `${(quote.match(/export /gu) ?? []).length} exports\n` };
    case "probe-shape": return { exit: 0, stdout: quote.includes(",  quote") ? "wide\n" : "narrow\n" };
    default: return { exit: 2, stdout: "unknown\n" };
  }
};
export const probe = (id: string): VerificationCommand => Object.freeze({ id: `probe-${id}`, executable: "/usr/local/bin/node", args: Object.freeze([`${id}.js`]),
  cwd: ".", timeoutMs: 30_000, mutationPolicy: "readOnly" as const });
export const EXPERIMENTS: ExperimentSpecs = Object.freeze({ ...NO_EXPERIMENTS, probes: Object.freeze([
  Object.freeze({ id: "api", command: probe("api"), expect: Object.freeze({ kind: "baseline" as const }) }),
  Object.freeze({ id: "shape", command: probe("shape"), expect: Object.freeze({ kind: "compare" as const }) })]) });

export interface Harness { readonly report: TournamentReport; readonly summary: RunSummary; readonly summaryEvents: readonly StoredEvent[];
  readonly port: GuestPort; readonly spies: ReadonlyMap<CandidateId, Spy> }
export async function tournament(scripts: Partial<Record<CandidateId, Script>>, options: Readonly<{ candidates?: number; experiments?: ExperimentSpecs;
  /** Replaces the guest's program; `undefined` from it falls back to the default program. */
  program?: (...args: Parameters<Program>) => ReturnType<Program> | undefined;
  chooseTie?: (tie: TieChoice) => Promise<CandidateId | undefined>; port?: (port: GuestPort) => void; timeoutMs?: number;
  signal?: AbortSignal;
  /** Each candidate's provider views under its own root (as the real view store keeps them apart). */
  distinctViews?: boolean;
  /** Paths the host classifies as protected: a change to one fails the protectedUnchanged obligation. */
  protectedPaths?: readonly string[] }> = {}): Promise<Harness> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-v05-tournament-"));
  try {
    const custom = options.program;
    const port = new GuestPort(BASELINE, custom === undefined ? PROGRAM : (command, tree, context) => custom(command, tree, context) ?? PROGRAM(command, tree, context));
    options.port?.(port);
    const recorder = await RunRecorder.start(dir, "build", REDACTOR, { task: MEDIUM_TASK.summary });
    const spies = new Map<CandidateId, Spy>();
    const runtime: TournamentRuntime = {
      workspace: port,
      engine: (id, events) => {
        const { roles, spy } = scriptedRoles(scripts[id] ?? { worker: () => FIX });
        spies.set(id, spy);
        const views = options.distinctViews === true ? new MemoryViews(join(dir, "views", id)) : new MemoryViews();
        return { roles, workspace: port, views, verifier: { verify: () => { throw new Error("host verifier"); } }, events };
      },
      binding: () => ({ provider: FAKE_PROVIDER, model: FAKE_MODEL }),
      evaluate: (result, plannedCommands) => assembleBuildEvidence({ task: MEDIUM_TASK.summary, scope: MEDIUM_PACKET.scope.allowedFiles,
        plan: reliabilityPlan(PROFILE, result.risk!), plannedCommands, result, baseCommit: BASE_COMMIT,
        protectedChanged: (result.changedPaths ?? []).filter(path => options.protectedPaths?.includes(path) === true) }),
    };
    const report = await runTournament({ tournamentId: makeId("t"), candidates: options.candidates ?? 2, source: "policy",
      request: { runId: recorder.runId, task: MEDIUM_TASK, packet: MEDIUM_PACKET, verification: REHEARSAL_PLAN, reproduce: true, timeoutMs: options.timeoutMs ?? 60_000,
        ...(options.signal === undefined ? {} : { signal: options.signal }) },
      contract: { task: MEDIUM_TASK.summary, baseCommit: BASE_COMMIT, scope: MEDIUM_PACKET.scope.allowedFiles, packetJson: canonicalJson(MEDIUM_PACKET) },
      obligations: RELIABILITY.obligations, falsification: "optional", experiments: options.experiments ?? NO_EXPERIMENTS },
    runtime, recorder, options.chooseTie === undefined ? {} : { chooseTie: options.chooseTie });
    await recorder.finish({ state: "COMPLETED", exitCode: 0, code: "completed", message: "done" });
    const summaryEvents: StoredEvent[] = [];
    for await (const item of EventStore.read(recorder.store.directory, recorder.runId)) if ("event" in item) summaryEvents.push(item.event);
    return { report, summary: await summarizeRun(dir, recorder.runId, REDACTOR), summaryEvents, port, spies };
  } finally { await rm(dir, { recursive: true, force: true }); }
}
export const states = (report: TournamentReport) => report.candidates.map(c => [c.id, c.state]);
