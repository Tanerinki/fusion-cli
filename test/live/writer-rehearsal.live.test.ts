import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { writerGateReport } from "../../src/app/writer-gate.js";
import { WorkflowEngine } from "../../src/core/workflow/engine.js";
import { evaluateBackendEvidence } from "../../src/platform/verification/backend-evidence.js";
import { createProductionDockerBackend, DOCKER_REQUIRED_EVIDENCE_FACTS,
  type DockerVerificationExecutionResult } from "../../src/platform/verification/docker/backend.js";
import { CliDockerRunner, resolveDockerCli } from "../../src/platform/verification/docker/cli.js";
import { PRODUCTION_DOCKER_IMAGE, PRODUCTION_NODE_VERSION } from "../../src/platform/verification/docker/config.js";
import { acceptVerificationIsolation, acquireVerificationIsolationAcceptance, isGrantedAcceptance } from "../../src/platform/verification/production.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { PrivateCandidateWorkspacePort, type CandidateVerificationObservation } from "../../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../../src/platform/workspace/git.js";
import { scriptedRoles } from "../fixtures/fake-writer.js";
import { FIX, MEDIUM_TASK, primaryEvidence, RecordingSink, rehearsalRequest, viewsOver, WRONG,
  withRehearsalRepo } from "../fixtures/writer-rehearsal-harness.js";

/**
 * OPT-IN live O5.5B7 rehearsal (`FUSION_DOCKER_LIVE=1 npm run test:writer-live`): deterministic FAKE providers, the REAL
 * production Docker backend (pinned image, real CLI, no test seam) with a verification-isolation acceptance granted in
 * this process from the instance's own evidence, and the realistic TypeScript fixture with its real npm dependencies.
 * No Claude, no Muse, no provider API. The only network use is the lane's separate dependency-preparation container
 * talking to the public npm registry. Only Fusion-labelled containers are created, and all are removed.
 */
const LIVE = process.env.FUSION_DOCKER_LIVE === "1";
const hex = (bytes = 12): string => randomBytes(bytes).toString("hex");

async function ownedContainers(): Promise<string[]> {
  const docker = await resolveDockerCli();
  const outcome = await new CliDockerRunner(docker!).run({ args: ["ps", "--all", "--no-trunc", "--filter", "label=fusion.owner=true",
    "--format", "{{.ID}}"], timeoutMs: 30_000 });
  assert.equal(outcome.exitCode, 0);
  return outcome.stdout.split(/\r?\n/u).filter(line => line.trim() !== "");
}

test("O5.5B7 LIVE: fake providers through the real engine, the accepted production Docker backend and real dependencies",
  { skip: !LIVE && "set FUSION_DOCKER_LIVE=1 to run", timeout: 30 * 60_000 }, async t => {
    if (!LIVE) return;
    assert.deepEqual(await ownedContainers(), [], "no Fusion-owned container exists before the run");
    await withRehearsalRepo(async repo => {
      // A canary OUTSIDE the candidate (untracked in the primary): the evidence stage proves no container can see it.
      const marker = `fusion-canary-${hex()}.txt`;
      await writeFile(join(repo.root, marker), "synthetic primary marker\n");
      const before = await primaryEvidence(repo.root);

      // 1. The accepted runtime: the production instance, and an acceptance from ITS OWN fresh evidence in this process.
      const backend = createProductionDockerBackend({ baseDirectory: repo.dir, dependencyStoreDirectory: join(repo.dir, "dependency-store") });
      const probe = await backend.probe();
      assert.equal(probe.available, true, probe.reason);
      const probeRoot = join(repo.dir, "acceptance-probe");
      await mkdir(probeRoot);
      await writeFile(join(probeRoot, "package.json"), '{"type":"module"}\n');
      const request = { plan: { commands: [{ id: "version", executable: "/usr/local/bin/node", args: ["--version"], cwd: ".", timeoutMs: 60_000,
        mutationPolicy: "readOnly" as const }] }, workspaceRoot: probeRoot, git: {} as never, env: {}, platformRequirement: "linux-compatible" as const };
      const evidenceStarted = performance.now();
      const lease = await backend.prepare(request);
      await backend.run(lease, request);
      const evidence = await backend.collectEvidence(lease, { absentMarkerNames: [marker] });
      assert.deepEqual(await backend.dispose(lease), { complete: true });
      const evaluation = evaluateBackendEvidence(evidence, DOCKER_REQUIRED_EVIDENCE_FACTS);
      assert.equal(evaluation.complete, true, JSON.stringify({ failed: evaluation.failed, notObserved: evaluation.notObserved }));
      assert.ok(evaluation.passed.includes("noHostMountsObserved") && evaluation.passed.includes("mountTableHostPathAbsentObserved"));
      const acceptance = acceptVerificationIsolation(backend, evidence);
      assert.equal(isGrantedAcceptance(acceptance), true, JSON.stringify(acceptance));
      t.diagnostic(`acceptance ${evaluation.passed.length}/${DOCKER_REQUIRED_EVIDENCE_FACTS.length} facts in ${Math.round(performance.now() - evidenceStarted)} ms; ` +
        `image ${PRODUCTION_DOCKER_IMAGE}; engine ${JSON.stringify(backend.observedEngine?.server)}`);
      // O5.5B8: the production composition's one-call acceptance procedure, on a fresh production instance.
      const helperStarted = performance.now();
      const viaHelper = await acquireVerificationIsolationAcceptance(createProductionDockerBackend({ baseDirectory: repo.dir,
        dependencyStoreDirectory: join(repo.dir, "dependency-store") }), { absentMarkerNames: [marker] });
      assert.equal(isGrantedAcceptance(viaHelper), true, JSON.stringify(viaHelper));
      t.diagnostic(`acquireVerificationIsolationAcceptance granted in ${Math.round(performance.now() - helperStarted)} ms`);

      // 2. The Writer route, twice: attempt 1 is a wrong fix (real failing tests), attempt 2 the real fix; fresh review.
      const git = await ProcessGitClient.fromPath(process.env, true);
      for (let run = 1; run <= 2; run++) {
        const observations: CandidateVerificationObservation[] = [];
        // Accepted mode: the port verifies through exactly the instance the acceptance was granted for; no service is passed.
        const port = new PrivateCandidateWorkspacePort({ primaryRoot: repo.root, git, confinement: acceptance,
          declaredPlatform: "linux-compatible", dependencies: "npm-lockfile", prepareDependencies: true,
          onVerification: observation => observations.push(observation) });
        assert.throws(() => new PrivateCandidateWorkspacePort({ primaryRoot: repo.root, git, confinement: acceptance,
          service: new VerificationService([createProductionDockerBackend()]) }), /no other service may be supplied/u,
        "an acceptance can never be paired with another backend instance, even one with the same id");
        const { roles, spy } = scriptedRoles({ worker: ({ call }) => call === 1 ? WRONG : FIX });
        const sink = new RecordingSink();
        // O5.5B8: every provider session runs in a Fusion-owned view (a Writer run without views never starts).
        const engine = new WorkflowEngine({ roles, workspace: port, views: viewsOver(repo.root, git, port).views, events: sink,
          verifier: { verify: () => { throw new Error("a Writer candidate is never verified on the host"); } } });
        const started = performance.now();
        const result = await engine.run(rehearsalRequest(MEDIUM_TASK));
        const totalMs = Math.round(performance.now() - started);
        assert.equal(result.state, "completed", JSON.stringify(result.error));
        assert.equal(result.delegateAttempts, 2);
        assert.equal(result.risk?.level, "high", "the real failing tests escalated the risk");
        assert.equal(result.reviews.length, 1);
        assert.equal(result.verification?.evidence?.acceptance, "granted", "verified by the accepted production backend, not a rehearsal marker");
        assert.equal(result.verification?.evidence?.backendId, "docker-linux");
        const runs = observations.map(o => o.outcome.verification.result as DockerVerificationExecutionResult);
        assert.equal(runs.length, 2);
        for (const docker of runs.map(r => r.docker)) {
          assert.equal(docker.runtime?.node, PRODUCTION_NODE_VERSION, "exact accepted runtime observed in the guest");
          assert.equal(docker.resultAccepted, true);
        }
        const counts = runs.map(r => r.docker.steps.find(step => step.id === "unit")?.testCounts);
        assert.deepEqual([counts[0]?.tests, counts[0]?.fail, counts[1]?.tests, counts[1]?.pass, counts[1]?.fail], [11, 2, 11, 11, 0],
          "the real test runner executed the real tests: 2 real failures, then 11 of 11");
        assert.equal(runs[1]!.docker.steps.find(step => step.id === "typecheck")?.stdoutTail ?? "", "", "tsc --noEmit: no diagnostics");
        const deps = observations.map(o => o.outcome.verification.dependencyStage);
        assert.equal(deps[0]?.key, deps[1]?.key, "one approved dependency identity for both attempts");
        if (run === 2) assert.deepEqual(deps.map(d => d?.cacheHit), [true, true], "the identity-bound artifact is reused across runs");
        else assert.equal(deps[1]?.cacheHit, true);
        assert.ok(port.timings.length > 0);
        assert.deepEqual(result.cleanup, { candidates: 2, released: 2, complete: true });
        assert.equal(result.providerViews?.complete, true, "every provider view was removed");
        assert.ok(spy.workspaces.every(entry => entry.root !== undefined), "no session ran outside a Fusion view");
        assert.ok(spy.sessions.every(s => s.posture === "readOnly"));
        t.diagnostic(`run ${run}: totalMs=${totalMs} attempts=${result.delegateAttempts} port=${JSON.stringify(port.timings)}`);
        for (const [index, r] of runs.entries())
          t.diagnostic(`run ${run} attempt ${index + 1}: verifyMs=${observations[index]!.durationMs} deps=${JSON.stringify(deps[index])} ` +
            `source=${JSON.stringify(r.docker.source)} artifact=${JSON.stringify(r.docker.dependencies)} limits=${JSON.stringify(r.docker.limits)} ` +
            `timings=${JSON.stringify(r.docker.timings)} counts=${JSON.stringify(r.docker.steps.map(s => [s.id, s.testCounts]))}`);
        assert.ok(port.timings.filter(entry => entry.stage === "release").length === 2);
      }

      // 3. Nothing is left behind, and the primary is exactly as it was.
      assert.deepEqual(await ownedContainers(), [], "no Fusion-owned container remains");
      assert.deepEqual(await primaryEvidence(repo.root), before, "tracked, untracked, ignored files and Git metadata unchanged");
      const gates = writerGateReport({ linuxVerification: acceptance });
      assert.deepEqual([gates.verificationIsolation.linux, gates.realWriterModeReady, gates.liveGateAuthorized], ["accepted", false, false]);
      assert.equal(gates.rows.find(row => row.id === "providerChangeProposal")?.state, "blocked");
      t.diagnostic(`gates ${JSON.stringify(gates.rows.map(row => [row.id, row.state, row.evidenceKind]))}`);
    });
  });
