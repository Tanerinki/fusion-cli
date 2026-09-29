import assert from "node:assert/strict";
import { test } from "node:test";
import { CONFINEMENT_FACTS } from "../../src/platform/verification/confinement-proof.js";
import { locateLauncher, probeAppContainerBackend, runConfinementCanary } from "../../src/platform/isolation/appcontainer-backend.js";
import { decidePosture, postureOfProbe } from "../../src/core/isolation/posture.js";

/**
 * OPT-IN Windows real-OS proof that the AppContainer backend ENFORCES its boundary. Not part of `npm test`. Build the
 * launcher first, then:
 *   powershell -File native/fusion-sandbox/build.ps1
 *   $env:FUSION_APPCONTAINER_LIVE = '1'; npm run build; node --test dist/test/live/appcontainer.live.test.js
 *
 * This is the OS-COVERED evidence for the v0.6 sandbox-escape matrix: a fake adapter is never sufficient for HARD. It uses
 * disposable canaries only and never real secrets. It skips (does not fail) when the flag is unset or the launcher is
 * absent, so it is safe to leave in the tree.
 */
const LIVE = process.env.FUSION_APPCONTAINER_LIVE === "1";

test("v0.6 LIVE appcontainer: every confinement fact is OS-enforced and the posture is HARD", { skip: !LIVE && "set FUSION_APPCONTAINER_LIVE=1 to run" }, async () => {
  if (!LIVE) return;
  const launcher = await locateLauncher();
  assert.ok(launcher !== null, "the launcher must be built (native/fusion-sandbox/build.ps1) before the live test");
  const canary = await runConfinementCanary(launcher!);
  assert.ok(canary.evaluation !== null, "the canary produced a proof");
  assert.deepEqual([...canary.evaluation!.failed], [], "no confinement fact failed under the real OS");
  assert.deepEqual([...canary.evaluation!.notObserved], [], "every fact was actually observed");
  assert.deepEqual([...canary.evaluation!.identityMismatches], [], "the proof binds the pinned launcher, backend and window");
  assert.equal(canary.evaluation!.passed.length, CONFINEMENT_FACTS.length, "all ten facts passed");

  const probe = await probeAppContainerBackend();
  assert.equal(probe.available, true);
  assert.deepEqual(probe.dimensions, { filesystem: "enforced", network: "enforced", processTree: "enforced" });
  assert.equal(postureOfProbe(probe), "HARD");
  assert.equal(decidePosture("hard", probe).satisfied, true);
});
