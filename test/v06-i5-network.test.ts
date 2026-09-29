import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { parseArgs, UsageError } from "../src/cli/args.js";
import { networkPolicy } from "../src/core/isolation/network-policy.js";
import {
  allowlistEnforceable, assertScopedPlan, buildInstallPlan, buildUninstallPlan, derivePosture, elevatedCommandLine,
  PROVISION_GROUP, type PostureInputs,
} from "../src/platform/isolation/network-provisioning.js";

const SID = "S-1-15-2-111-222-333-444-555-666-777";
const fails = (fn: () => unknown): void => assert.throws(fn, (e: unknown) => e instanceof FusionFailure);

// ---------------------------------------------------------------- plan construction

test("v0.6 I5: the install plan is package-SID-scoped, elevated, idempotent (named group); uninstall removes exactly it", () => {
  const plan = buildInstallPlan(SID);
  assert.equal(plan.packageSid, SID);
  assert.equal(plan.scopedToSandboxOnly, true);
  assert.ok(plan.ops.every(op => op.elevated), "every op needs elevation");
  assert.ok(plan.ops.some(op => op.kind === "loopbackExemptAdd" && op.args.includes(`-p=${SID}`)));
  assert.ok(plan.ops.some(op => op.kind === "firewallDenyEgress" && op.args.join(" ").includes(`package=${SID}`) && op.args.join(" ").includes(PROVISION_GROUP)));
  assertScopedPlan(plan); // does not throw
  const un = buildUninstallPlan(SID);
  assert.ok(un.ops.some(op => op.kind === "loopbackExemptRemove" && op.args.includes(`-p=${SID}`)));
  assert.ok(un.ops.some(op => op.kind === "firewallRemoveGroup"));
});

test("v0.6 I5: a malformed SID is refused; the elevated command is exactly the SID-scoped operations", () => {
  fails(() => buildInstallPlan("not-a-sid"));
  fails(() => buildInstallPlan("S-1-5-32-544")); // not an AppContainer package SID
  const cmd = elevatedCommandLine(buildInstallPlan(SID));
  assert.match(cmd, /CheckNetIsolation LoopbackExempt -a -p=S-1-15-2-/u);
  assert.match(cmd, /netsh advfirewall firewall add rule/u);
  assert.ok(cmd.includes(SID) && !cmd.includes("remoteip=any\nnetsh"));
});

test("v0.6 I5 ADVERSARIAL: a plan op not scoped to the sandbox SID/group is refused (never touches other apps' policy)", () => {
  const plan = buildInstallPlan(SID);
  // Forge a machine-wide loopback op (drop the -p= scope) and an inbound-allow op.
  const machineWide = { ...plan, ops: [{ ...plan.ops[0]!, args: ["LoopbackExempt", "-a"] }] };
  assert.throws(() => assertScopedPlan(machineWide as never), (e: unknown) => e instanceof FusionFailure && e.error.kind === "SecurityViolation");
  const inboundAllow = { ...plan, ops: [{ ...plan.ops[1]!, args: ["advfirewall", "firewall", "add", "rule", `name=${PROVISION_GROUP}`, "dir=in", "action=allow", `package=${SID}`] }] };
  assert.throws(() => assertScopedPlan(inboundAllow as never), (e: unknown) => e instanceof FusionFailure);
});

// ---------------------------------------------------------------- posture model (the seven distinctions)

const inputs = (over: Partial<PostureInputs> = {}): PostureInputs => ({
  canary: { filesystem: true, processTree: true, denyAllNetwork: true, complete: true },
  environmentMinimized: true, loopbackExempt: false, allowlistRequested: false, brokerVerified: false, ...over });

test("v0.6 I5: doctor distinguishes HARD FS/process/env, DENY_ALL, ALLOWLIST states, loopback/broker, and missing provisioning", () => {
  const denyAll = derivePosture(inputs());
  assert.equal(denyAll.posture, "HARD");
  assert.equal(denyAll.filesystem, "HARD");
  assert.equal(denyAll.processTree, "HARD");
  assert.equal(denyAll.environmentMinimization, "HARD");
  assert.equal(denyAll.denyAllNetwork, "enforced");
  assert.equal(denyAll.allowlistNetwork, "DENY_ALL_ENFORCED");

  assert.equal(derivePosture(inputs({ allowlistRequested: true })).allowlistNetwork, "NOT_PROVISIONED");
  assert.equal(derivePosture(inputs({ allowlistRequested: true, loopbackExempt: true, brokerVerified: false })).allowlistNetwork, "BROKEN");
  assert.equal(derivePosture(inputs({ allowlistRequested: true, loopbackExempt: true, brokerVerified: true })).allowlistNetwork, "ALLOWLIST_READY");
});

test("v0.6 I5: posture is never HARD merely because rules exist — a loopback exemption without a passing canary is UNAVAILABLE", () => {
  const noCanary = derivePosture(inputs({ canary: null, loopbackExempt: true, allowlistRequested: true, brokerVerified: true }));
  assert.equal(noCanary.posture, "UNAVAILABLE");
  assert.equal(noCanary.filesystem, "unknown");
  assert.equal(noCanary.processTree, "unknown");
  // a failed filesystem canary is never HARD
  assert.equal(derivePosture(inputs({ canary: { filesystem: false, processTree: true, denyAllNetwork: true, complete: false } })).posture, "UNAVAILABLE");
});

test("v0.6 I5: fail-closed — an unenforceable allowlist is NETWORK_POLICY_UNAVAILABLE, never an unrestricted fallback", () => {
  const ready = derivePosture(inputs({ allowlistRequested: true, loopbackExempt: true, brokerVerified: true }));
  const allowlist = networkPolicy({ mode: "ALLOWLIST", allowed: [{ host: "api.example", port: 443 }] });
  assert.deepEqual(allowlistEnforceable(ready, allowlist), { ok: true });
  const broken = derivePosture(inputs({ allowlistRequested: true, loopbackExempt: true, brokerVerified: false }));
  assert.deepEqual(allowlistEnforceable(broken, allowlist), { ok: false, failure: "NETWORK_POLICY_UNAVAILABLE" });
  const notProvisioned = derivePosture(inputs({ allowlistRequested: true }));
  assert.deepEqual(allowlistEnforceable(notProvisioned, allowlist), { ok: false, failure: "NETWORK_POLICY_UNAVAILABLE" });
  // DENY_ALL requires deny-all actually enforced.
  const noDeny = derivePosture(inputs({ canary: { filesystem: true, processTree: true, denyAllNetwork: false, complete: true } }));
  assert.deepEqual(allowlistEnforceable(noDeny, networkPolicy({ mode: "DENY_ALL" })), { ok: false, failure: "HARD_ISOLATION_UNAVAILABLE" });
});

// ---------------------------------------------------------------- CLI arg parsing

test("v0.6 I5: `fusion sandbox` requires a valid subcommand; --allow only for install", () => {
  assert.equal(parseArgs(["sandbox", "doctor"]).positionals[0], "doctor");
  assert.deepEqual(parseArgs(["sandbox", "install", "--allow", "api.x:443", "--allow", "b.y:443"]).allow, ["api.x:443", "b.y:443"]);
  assert.equal(parseArgs(["sandbox", "install", "--identity", "fusion.sandbox.c1"]).identity, "fusion.sandbox.c1");
  assert.throws(() => parseArgs(["sandbox", "frobnicate"]), (e: unknown) => e instanceof UsageError);
  assert.throws(() => parseArgs(["sandbox"]), (e: unknown) => e instanceof UsageError); // needs a subcommand
  assert.throws(() => parseArgs(["sandbox", "doctor", "--allow", "api.x:443"]), (e: unknown) => e instanceof UsageError); // --allow not for doctor
});
