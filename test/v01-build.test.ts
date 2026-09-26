import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { parseConfig } from "../src/app/config.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { buildWriterCandidates, type ProviderRegistry } from "../src/app/providers.js";
import { REHEARSAL_PLAN, ROUTE_TASK } from "../src/app/route-fixture.js";
import { createRouteFixture, ROUTE_ROLES, type RouteRole } from "../src/app/route-probe.js";
import { providerViewPort, WRITER_ROLES, type ProductionWriterOptions, type WriterComposition } from "../src/app/writer-composition.js";
import { runCli } from "../src/cli/run.js";
import type { ChangeSet } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { WorkflowResult } from "../src/core/workflow/types.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fixtures/fake-docker.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { adjudication, cleanReview, plan, PREFIX, proposal, reviewWith, routeEnv, routeRegistry, testRouteAuthorization, testRouteBindings,
  type RoleScripts } from "./fixtures/route-harness.js";
import { FAKE_DEPENDENCY_TREE, QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, QUOTE_WRONG } from "./fixtures/rehearsal-project.js";
import { FIX, gitAvailable, rehearsalOracle } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 2 — `fusion build` as a product, offline.
 *
 * The production build branch runs with the REAL CLI, the REAL workflow engine and the REAL Claude and Muse adapters on
 * their deterministic fake binaries (production registry path, `buildWriterCandidates`), host-controlled private candidates
 * and confined verification on a fake Docker daemon. A fake backend can never hold a GRANTED acceptance (only the acceptance
 * authority mints one, for a real Docker backend — a guarded invariant), so these runs are offline rehearsals: the whole
 * route runs, and the result is honestly never delivered. The delivery step itself (`prepareBuildDelivery`, the function
 * the build calls) is then proven on a result verified under a granted acceptance, through approve and apply.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const TASK = ROUTE_TASK.summary;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const WRONG = changeSet([["src/quote.ts", QUOTE_BUGGY, QUOTE_WRONG], ["test/quote.test.ts", QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION]]);

/** The production composition shape over a fake Docker backend: an offline rehearsal (or a refused acceptance). */
function testCompose(dir: string, acceptance: "offlineRehearsal" | "refused"): (options: ProductionWriterOptions) => Promise<WriterComposition> {
  return async options => {
    const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry, { workspace: options.root, env: options.env }, WRITER_ROLES);
    const git = await ProcessGitClient.fromPath(process.env, true);
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: new FakeDocker({ attach: rehearsalOracle(), depsTree: FAKE_DEPENDENCY_TREE }),
      resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), dependencyStoreDirectory: join(dir, "dependency-store") });
    const verification = options.config.verification;
    const workspace = new PrivateCandidateWorkspacePort({ primaryRoot: options.root, git, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform: verification.platformRequirement, dependencies: verification.dependencies ?? "none",
      prepareDependencies: true, ...(options.config.protection ? { protectedPaths: options.config.protection.ignoredPaths } : {}) });
    return { roles: candidates, unavailable, workspace, views: providerViewPort(options.root, git, options.registry, workspace),
      plan: { commands: [...(verification.confinedCommands ?? [])] },
      verification: { acceptance, reasons: acceptance === "refused" ? ["test: no acceptance"] : [] } };
  };
}

interface Built { code: number; stdout: string; stderr: string; prompts: Record<RouteRole, string[]>; questions: string[] }
interface Rig { i: Installs; dir: string; root: string; env: NodeJS.ProcessEnv; registry: ProviderRegistry;
  cli(argv: string[], answers: Array<string | null>): Promise<Built> }
async function withRig<T>(name: string, scripts: RoleScripts, options: Readonly<{ acceptance?: "offlineRehearsal" | "refused"; confinedPlan?: boolean }>,
  work: (rig: Rig) => Promise<T>): Promise<T> {
  return withInstalls(async i => {
    const dir = join(i.dir, name);
    await mkdir(dir, { recursive: true });
    const root = await createRouteFixture(dir, await ProcessGitClient.fromPath(process.env, true));
    const scriptDir = join(dir, "scripts");
    await mkdir(scriptDir);
    const paths = Object.fromEntries(ROUTE_ROLES.map(role => [role, join(scriptDir, `${role}.json`)])) as Record<RouteRole, string>;
    for (const role of ROUTE_ROLES) await writeFile(paths[role], JSON.stringify(scripts[role] ?? []));
    const bindings = testRouteBindings(i, testRouteAuthorization(i));
    const config = parseConfig({ schemaVersion: 1, bindings: ROUTE_ROLES.map(role => bindings[role]),
      verification: { commands: [], platformRequirement: "linux-compatible", dependencies: "npm-lockfile",
        ...(options.confinedPlan === false ? {} : { confinedCommands: REHEARSAL_PLAN.commands }) },
      limits: { runTimeoutMs: 10 * 60_000 }, protection: { ignoredPaths: ["secrets.local"] } });
    const registry: ProviderRegistry = { ...routeRegistry(i, paths), defaults: config };
    const env = routeEnv({ LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg") });
    const rig: Rig = { i, dir, root, env, registry, async cli(argv, answers) {
      let stdout = "", stderr = "";
      const queue = [...answers], questions: string[] = [];
      const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: answers.length > 0,
        ...(answers.length > 0 ? { prompt: async (question: string) => { questions.push(question); return queue.length > 0 ? queue.shift()! : null; } } : {}) },
        { env, cwd: root, registry, writerComposition: testCompose(dir, options.acceptance ?? "offlineRehearsal") });
      const prompts = Object.fromEntries(await Promise.all(ROUTE_ROLES.map(async role => {
        let text = "";
        try { text = await readFile(`${paths[role]}.prompts.jsonl`, "utf8"); } catch { /* no model turn */ }
        return [role, text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { prompt: string }).prompt)];
      }))) as Record<RouteRole, string[]>;
      return { code, stdout, stderr, prompts, questions };
    } };
    return work(rig);
  });
}
const BUILD = ["build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", "--", TASK];
const modelTurns = (built: Built) => ROUTE_ROLES.reduce((sum, role) => sum + built.prompts[role].length, 0);
/** The build report's line with this prefix (the last one: the confirmed plan before it has lines of its own). */
const line = (built: Built, prefix: string) => built.stdout.split("\n").filter(entry => entry.startsWith(prefix)).at(-1);

test("v0.1 build: confirmed by the human, the real route runs (plan, Change Author, confined verification, fresh review); an offline rehearsal is never delivered",
  { skip }, async () => withRig("pass", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assert.match(built.questions[0]!, /Type "build" to start/u);
    assert.match(built.stdout, /^Build plan$/mu);
    const planned = /^Risk: (\w+)/mu.exec(built.stdout)?.[1], ran = /^risk: (\w+)/mu.exec(built.stdout)?.[1];
    assert.equal(planned, ran, "the plan the human confirmed carries the risk the run used");
    assert.equal(line(built, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
    assert.equal(line(built, "Verification: "), "Verification: PASS (docker-linux, 2 command(s))");
    assert.equal(line(built, "Review: "), "Review: PASS (1 cycle(s), 0 finding(s), 0 outstanding)");
    assert.equal(line(built, "Delivery: "), undefined, "an offline rehearsal prepares no delivery");
    assert.deepEqual([built.prompts.Lead.length, built.prompts.Worker.length, built.prompts.Reviewer.length], [1, 1, 1]);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "a build never touches the working tree");
  }));

test("v0.1 build: a failed confined verification is retried with a fresh candidate; a confirmed finding is corrected and re-reviewed", { skip }, async () => {
  await withRig("retry", { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(WRONG), proposal(FIX)],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assert.equal(built.prompts.Worker.length, 2, "one retry after the failed verification");
    assert.equal(line(built, "Verification: "), "Verification: PASS (docker-linux, 2 command(s))");
  });
  await withRig("correction", { Lead: [{ prefix: PREFIX.plan, output: plan() }, { prefix: PREFIX.adjudication, output: adjudication(["r1-F1", "CONFIRMED", "fix"]) }],
    Worker: [proposal(FIX), proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: reviewWith({ id: "F1", severity: "HIGH" }) },
      { prefix: PREFIX.review, output: cleanReview }] }, {}, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 0, `${built.stdout}\n${built.stderr}`);
    assert.deepEqual([built.prompts.Lead.length, built.prompts.Worker.length, built.prompts.Reviewer.length], [2, 2, 2]);
    assert.equal(line(built, "Review: "), "Review: PASS (2 cycle(s), 1 finding(s), 0 outstanding)");
  });
});

test("v0.1 build: no confirmation, a declined confirmation, no confined plan or no verification acceptance — refused before any model turn", { skip }, async () => {
  const scripts: RoleScripts = { Lead: [{ prefix: PREFIX.plan, output: plan() }], Worker: [proposal(FIX)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] };
  await withRig("gates", scripts, {}, async rig => {
    const unattended = await rig.cli(BUILD, []);
    assert.equal(unattended.code, 11, unattended.stdout);
    assert.match(unattended.stdout, /a human must confirm at an interactive terminal/u);
    const declined = await rig.cli(BUILD, ["no"]);
    assert.equal(declined.code, 11);
    assert.match(declined.stdout, /Build not started: it was not confirmed/u);
    const json = await rig.cli(["--json", ...BUILD], []);
    assert.equal(JSON.parse(json.stdout).exitCode, 11);
    assert.equal(modelTurns(unattended) + modelTurns(declined) + modelTurns(json), 0);
  });
  await withRig("no-plan", scripts, { confinedPlan: false }, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 11, built.stdout);
    assert.match(built.stdout, /No confined verification plan is configured/u);
    assert.equal(modelTurns(built), 0);
  });
  await withRig("no-acceptance", scripts, { acceptance: "refused" }, async rig => {
    const built = await rig.cli(BUILD, ["build"]);
    assert.equal(built.code, 11, built.stdout);
    assert.match(built.stdout, /Confined verification is not available: test: no acceptance/u);
    assert.equal(modelTurns(built), 0);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY);
  });
});

/** A completed run with `changes`, verified under the given acceptance (only a real accepted backend produces `granted`). */
function verifiedResult(changes: ChangeSet, acceptance: "granted" | "offlineRehearsal"): WorkflowResult {
  return { state: "completed", transitions: [], delegateAttempts: 1, reviews: [], changeSet: changes,
    applied: changes.operations.map(op => op.kind === "delete"
      ? { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: null, bytes: 0 }
      : { kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }),
    verification: { passed: true, commandsRun: 2, evidence: { backendId: "docker-linux", confinement: "osSandbox", platformRequirement: "linux-compatible",
      acceptance, commands: [{ id: "typecheck", status: "passed", exitCode: 0 }, { id: "unit", status: "passed", exitCode: 0 }] } } };
}

test("v0.1 build delivery: a result verified under a granted acceptance becomes a delivery the human approves and applies; a rehearsal never", { skip }, async () =>
  withRig("delivery", {}, {}, async rig => {
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const base = (await (await ProcessGitClient.fromPath(process.env, true)).run(["rev-parse", "HEAD"], { cwd: rig.root })).stdout.trim();
    const eventLog = join(rig.dir, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    // An offline rehearsal's result is refused by the real preparation path: nothing is stored.
    await assert.rejects(prepareBuildDelivery(plane, { runId: "r-rehearsal", task: TASK, result: verifiedResult(FIX, "offlineRehearsal"), baseCommit: base,
      eventLogPath: eventLog }), (error: unknown) => error instanceof FusionFailure && error.error.kind === "SecurityViolation");
    const delivery = await prepareBuildDelivery(plane, { runId: "r-granted", task: TASK, result: verifiedResult(FIX, "granted"), baseCommit: base, eventLogPath: eventLog });
    assert.match(delivery.deliveryId, /^d-[0-9a-f]{24}$/u);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_BUGGY, "preparing applies nothing");
    const inspect = await rig.cli(["inspect-delivery", delivery.deliveryId], []);
    assert.equal(inspect.code, 0, inspect.stderr);
    assert.match(inspect.stdout, new RegExp(`^Manifest: sha256:${delivery.manifestSha256}$`, "mu"));
    assert.equal((await rig.cli(["approve-delivery", delivery.deliveryId], [delivery.manifestSha256])).code, 0);
    const applied = await rig.cli(["apply", delivery.deliveryId], []);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(rig.root, "src", "quote.ts"), "utf8"), QUOTE_FIXED);
    assert.equal(await readFile(join(rig.root, "test", "quote.test.ts"), "utf8"), QUOTE_TEST_WITH_REGRESSION);
  }));
