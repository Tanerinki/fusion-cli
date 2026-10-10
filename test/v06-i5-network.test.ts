import assert from "node:assert/strict";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { parseArgs, UsageError } from "../src/cli/args.js";
import { networkPolicy } from "../src/core/isolation/network-policy.js";
import {
  allowlistEnforceable, assertScopedPlan, buildInstallPlan, buildUninstallPlan, derivePosture, elevatedCommandLine,
  loopbackExemptFromListing, PROVISION_GROUP, type PostureInputs,
} from "../src/platform/isolation/network-provisioning.js";
import { provisionVerified, type SandboxDoctorReport } from "../src/app/sandbox.js";
import { renderSandboxDoctor } from "../src/cli/render-sandbox.js";

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

// ---------------------------------------------------------------- B1: the reported identity's own network posture
// The canary runs under a FRESH, UN-EXEMPTED identity. `fusion sandbox install` adds a loopback exemption to the
// REPORTED identity, and an exempted identity can reach any 127.0.0.1 service. The canary's proof must never stand for it.

test("v0.6 B1: a fresh un-exempted identity keeps its canary-proven HARD posture", () => {
  const p = derivePosture(inputs({ loopbackExempt: false }));
  assert.deepEqual([p.posture, p.canaryNetworkDenial, p.denyAllNetwork, p.loopbackBroker, p.brokerOnlyLoopback, p.allowlistNetwork],
    ["HARD", "proven", "enforced", "absent", "notApplicable", "DENY_ALL_ENFORCED"]);
  assert.deepEqual(allowlistEnforceable(p, networkPolicy({ mode: "DENY_ALL" })), { ok: true });
});

test("v0.6 B1: a loopback-exempt identity never inherits HARD deny-all from the un-exempted canary; its posture is at most CONFINED", () => {
  const p = derivePosture(inputs({ loopbackExempt: true }));
  assert.equal(p.canaryNetworkDenial, "proven", "the measured capability is kept, as capability");
  assert.equal(p.denyAllNetwork, "notEnforced", "but it is not this identity's deny-all");
  assert.equal(p.posture, "CONFINED");
  assert.equal(p.loopbackBroker, "present");
  assert.equal(p.brokerOnlyLoopback, "NOT_PROVEN");
  assert.equal(p.allowlistNetwork, "NOT_REQUESTED", "never DENY_ALL_ENFORCED for an exempted identity");
  assert.deepEqual(allowlistEnforceable(p, networkPolicy({ mode: "DENY_ALL" })), { ok: false, failure: "HARD_ISOLATION_UNAVAILABLE" });
  // Even a ready allowlist does not make the network HARD or broker-only proven.
  const ready = derivePosture(inputs({ loopbackExempt: true, allowlistRequested: true, brokerVerified: true }));
  assert.deepEqual([ready.allowlistNetwork, ready.posture, ready.denyAllNetwork, ready.brokerOnlyLoopback], ["ALLOWLIST_READY", "CONFINED", "notEnforced", "NOT_PROVEN"]);
});

test("v0.6 B1: an unknown loopback-exemption state is never HARD (never read as absent)", () => {
  const p = derivePosture(inputs({ loopbackExempt: "unknown" }));
  assert.deepEqual([p.posture, p.denyAllNetwork, p.loopbackBroker, p.brokerOnlyLoopback, p.allowlistNetwork],
    ["CONFINED", "unknown", "unknown", "NOT_PROVEN", "NOT_REQUESTED"]);
  // and an unproven canary never becomes deny-all, even for a known un-exempted identity
  const noNet = derivePosture(inputs({ loopbackExempt: false, canary: { filesystem: true, processTree: true, denyAllNetwork: false, complete: false } }));
  assert.deepEqual([noNet.posture, noNet.denyAllNetwork, noNet.canaryNetworkDenial], ["CONFINED", "unknown", "unknown"]);
});

test("v0.6 B1: install → uninstall transitions are reported for the SAME identity; only a definite read verifies a step", () => {
  const before = derivePosture(inputs({ loopbackExempt: false }));
  const installed = derivePosture(inputs({ loopbackExempt: true }));
  const uninstalled = derivePosture(inputs({ loopbackExempt: false }));
  assert.deepEqual([before.posture, installed.posture, uninstalled.posture], ["HARD", "CONFINED", "HARD"]);
  assert.deepEqual([provisionVerified("install", true), provisionVerified("install", false), provisionVerified("install", "unknown")], [true, false, false]);
  assert.deepEqual([provisionVerified("uninstall", false), provisionVerified("uninstall", true), provisionVerified("uninstall", "unknown")], [true, false, false]);
});

test("v0.6 B1: the exemption read matches the EXACT SID token; a failed read is unknown, never absent", () => {
  const listing = `List Loopback Exempted AppContainers\n\n[1] -----------------------------------------------------------------\n    Name: x\n    SID:  ${SID}\n\nOK.\n`;
  assert.equal(loopbackExemptFromListing(0, listing, SID), true);
  assert.equal(loopbackExemptFromListing(0, listing.toLowerCase(), SID), true, "case-insensitive");
  assert.equal(loopbackExemptFromListing(0, listing, `${SID.slice(0, -1)}`), false, "a SID that is a prefix of a listed one is not a match");
  assert.equal(loopbackExemptFromListing(0, listing.replace(SID, `${SID}9`), SID), false, "a longer SID is not a match");
  assert.equal(loopbackExemptFromListing(0, "No exempted AppContainers\n", SID), false);
  assert.equal(loopbackExemptFromListing(1, listing, SID), "unknown");
  assert.equal(loopbackExemptFromListing(null, listing, SID), "unknown");
});

test("v0.6 B1: doctor text and JSON agree for a loopback-exempt identity; no line claims HARD network", () => {
  const report: SandboxDoctorReport = { launcherBuilt: true, packageSid: SID, identity: "fusion.sandbox.default", canaryComplete: true,
    posture: derivePosture(inputs({ loopbackExempt: true })) };
  const json = JSON.parse(JSON.stringify({ command: "sandbox", subcommand: "doctor", exitCode: 0, ...report })) as SandboxDoctorReport;
  assert.deepEqual([json.posture.posture, json.posture.denyAllNetwork, json.posture.brokerOnlyLoopback, json.posture.loopbackBroker],
    ["CONFINED", "notEnforced", "NOT_PROVEN", "present"]);
  const text = renderSandboxDoctor(report);
  assert.match(text, /^overall posture: +CONFINED \(for identity fusion\.sandbox\.default\)$/mu);
  assert.match(text, /^network \(deny-all\): +NOT enforced for this identity \(loopback-exempt: unrelated localhost services are reachable\)$/mu);
  assert.match(text, /^broker-only loopback: +NOT PROVEN$/mu);
  assert.match(text, /^loopback exemption: +present$/mu);
  assert.match(text, /can reach ANY service on 127\.0\.0\.1/u);
  assert.doesNotMatch(text, /HARD \(OS-enforced/u, "no network line claims HARD");
  assert.doesNotMatch(text, /^overall posture: +HARD/mu);
  // and for an un-exempted identity the same renderer reports what IS proven, consistently with its JSON
  const clean = renderSandboxDoctor({ ...report, posture: derivePosture(inputs({ loopbackExempt: false })) });
  assert.match(clean, /^overall posture: +HARD /mu);
  assert.match(clean, /^network \(deny-all\): +HARD \(OS-enforced for this identity\)$/mu);
  assert.match(clean, /^broker-only loopback: +n\/a \(no loopback exemption\)$/mu);
  assert.doesNotMatch(clean, /^warning:/mu);
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
