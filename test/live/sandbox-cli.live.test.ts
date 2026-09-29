import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxDoctor, sandboxInstall } from "../../src/app/sandbox.js";

/**
 * OPT-IN Windows real-OS proof of `fusion sandbox doctor`/`install` (non-elevated). doctor reports the canary-proven
 * HARD posture and derives the real package SID; install (non-elevated) presents the exact SID-scoped elevated command
 * and never elevates itself. Needs the launcher built (`native/fusion-sandbox/build.ps1`). Skips otherwise.
 *   $env:FUSION_APPCONTAINER_LIVE = '1'; npm run build; node --test dist/test/live/sandbox-cli.live.test.js
 */
const LIVE = process.env.FUSION_APPCONTAINER_LIVE === "1";

test("v0.6 LIVE sandbox doctor: canary-proven HARD posture, deny-all network, real package SID; install presents the SID-scoped command", { skip: !LIVE && "set FUSION_APPCONTAINER_LIVE=1 to run" }, async () => {
  if (!LIVE) return;
  const report = await sandboxDoctor({ identity: "fusion.sandbox.livetest" });
  assert.equal(report.launcherBuilt, true, "build native/fusion-sandbox first");
  assert.equal(report.posture.filesystem, "HARD");
  assert.equal(report.posture.processTree, "HARD");
  assert.equal(report.posture.denyAllNetwork, "enforced");
  assert.equal(report.posture.posture, "HARD");
  assert.match(report.packageSid ?? "", /^S-1-15-2-/u);
  // Without provisioning, the allowlist is not provisioned — never a silent unrestricted claim.
  assert.equal(report.posture.allowlistNetwork, "DENY_ALL_ENFORCED");

  const install = await sandboxInstall({ identity: "fusion.sandbox.livetest", allowlist: [{ host: "api.anthropic.com", port: 443 }] });
  // On an unelevated dev box this stops at the gate; if run elevated it applies. Either way it is SID-scoped and honest.
  assert.equal(install.packageSid, report.packageSid);
  assert.ok(install.plan !== null);
  assert.ok(install.elevatedCommand!.includes(report.packageSid!));
  if (!install.applied) assert.equal(install.needsElevation, true);
});
