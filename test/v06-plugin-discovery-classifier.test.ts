import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import type { DelegationPacket } from "../src/core/domain.js";
import { ClaudeOneShotTransport } from "../src/providers/claude/one-shot-transport.js";
import { classifyInitFrame, classifyStartupFrame, describeStartupRejection,
  type InitFrameVerdict, type StartupFrameVerdict } from "../src/providers/claude/plugin-quarantine.js";
import type { ClaudeLaunchConfig } from "../src/providers/claude/types.js";

// ----------------------------------------------------------------------------------------------------------------
// The pure init-frame classifier. Policy keys on ACTIVE capability exposure (tools, MCP, permission, credential,
// canary surfaces), never on whether a plugin is merely DISCOVERED in the init frame's `plugins` metadata.
// ----------------------------------------------------------------------------------------------------------------
const initFrame = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ type: "system", subtype: "init",
  claude_code_version: "2.1.289", permissionMode: "dontAsk", apiKeySource: "none", tools: ["Read", "Grep", "Glob"],
  mcp_servers: [], agents: [], skills: [], slash_commands: [], plugins: [], ...over });
const builtinEntry = { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" };
const marketEntry = { name: "market-tool", path: "user-cache", source: "market-tool@official" };
const rej = (v: InitFrameVerdict | StartupFrameVerdict): string => v.kind === "reject" ? v.reason.code : v.kind;

test("v0.6 classifier: a zero-plugin startup is accepted", () => {
  const v = classifyInitFrame(initFrame());
  assert.equal(v.kind, "accept");
  if (v.kind === "accept") { assert.deepEqual(v.plugins, []); assert.equal(v.version, "2.1.289"); }
});

test("v0.6 classifier: a discovered-but-inactive plugin (built-in or installed) is accepted, not judged", () => {
  // Discovered bundled/default metadata with zero active surfaces -> acceptable.
  const builtins = classifyInitFrame(initFrame({ plugins: [builtinEntry] }));
  assert.equal(builtins.kind, "accept");
  if (builtins.kind === "accept") assert.deepEqual(builtins.plugins, [builtinEntry]);
  // Discovered installed plugin, still contributing no active surface -> acceptable (the quarantine disables it later).
  const installed = classifyInitFrame(initFrame({ plugins: [builtinEntry, marketEntry] }));
  assert.equal(installed.kind, "accept");
  if (installed.kind === "accept") assert.equal(installed.plugins.length, 2);
});

test("v0.6 classifier: an ACTIVE surface is refused with a precise code", () => {
  // A plugin-provided tool widens the tool set.
  assert.equal(rej(classifyInitFrame(initFrame({ tools: ["Read", "Grep", "Glob", "mcp__plugin__do"] }))), "tools_surface");
  assert.equal(rej(classifyInitFrame(initFrame({ tools: ["Read", "Grep"] }))), "tools_surface");
  // A plugin MCP server is active.
  assert.equal(rej(classifyInitFrame(initFrame({ mcp_servers: [{ name: "x" }] }))), "mcp_active");
  // Credential and permission posture.
  assert.equal(rej(classifyInitFrame(initFrame({ apiKeySource: "ANTHROPIC_API_KEY" }))), "api_key_source");
  assert.equal(rej(classifyInitFrame(initFrame({ permissionMode: "bypassPermissions" }))), "permission_mode");
  // Ambiguous / unsupported shapes fail closed.
  assert.equal(rej(classifyInitFrame(initFrame({ claude_code_version: "not-a-version" }))), "version_format");
  assert.equal(rej(classifyInitFrame(initFrame({ claude_code_version: 289 }))), "version_format");
  assert.equal(rej(classifyInitFrame(initFrame({ plugins: "nope" }))), "plugins_shape");
  assert.equal(rej(classifyInitFrame(initFrame({ plugins: new Array(257).fill(builtinEntry) }))), "plugins_shape");
});

test("v0.6 classifier: the read-only tool set is order-independent", () => {
  assert.equal(classifyInitFrame(initFrame({ tools: ["Grep", "Read", "Glob"] })).kind, "accept");
  assert.equal(classifyInitFrame(initFrame({ tools: ["Glob", "Read", "Grep"] })).kind, "accept");
});

test("v0.6 classifier: a canary surface is refused only in canary mode", () => {
  const leak = { agents: ["claude", "fusion-canary"] };
  assert.equal(classifyInitFrame(initFrame(leak), { canary: true }).kind, "reject");
  assert.equal(rej(classifyInitFrame(initFrame(leak), { canary: true })), "canary_surface");
  // The same frame outside canary mode is a normal (accepted) startup: the canary files are a test-only workspace.
  assert.equal(classifyInitFrame(initFrame(leak)).kind, "accept");
  assert.equal(rej(classifyInitFrame(initFrame({ skills: ["fusion-canary"] }), { canary: true })), "canary_surface");
  assert.equal(rej(classifyInitFrame(initFrame({ hooks: [{ source: "managed" }] }), { canary: true })), "canary_surface");
});

test("v0.6 classifier: a different runtime version than the preceding startup is drift, not a refusal", () => {
  const v = classifyInitFrame(initFrame({ claude_code_version: "2.1.290" }), { expectedVersion: "2.1.289" });
  assert.equal(v.kind, "drift");
  if (v.kind === "drift") assert.equal(v.version, "2.1.290");
  assert.equal(classifyInitFrame(initFrame({ claude_code_version: "2.1.289" }), { expectedVersion: "2.1.289" }).kind, "accept");
});

// ----------------------------------------------------------------------------------------------------------------
// The stream classifier: unsafe activity refuses at any point; init order and duplicate frames do not change it.
// ----------------------------------------------------------------------------------------------------------------
test("v0.6 stream: plugin hook / command / task activity is refused before OR after init", () => {
  for (const subtype of ["hook_started", "hook_progress", "hook_response", "plugin_install", "local_command_output", "task_started", "task_notification"]) {
    assert.equal(rej(classifyStartupFrame({ type: "system", subtype }, { seenInit: false })), "unsafe_event");
    assert.equal(rej(classifyStartupFrame({ type: "system", subtype }, { seenInit: true })), "unsafe_event", `${subtype} after init`);
  }
});

test("v0.6 stream: a non-init system frame before init is refused; api_retry is tolerated", () => {
  assert.equal(rej(classifyStartupFrame({ type: "system", subtype: "commands_changed" }, { seenInit: false })), "preinit_frame");
  assert.equal(classifyStartupFrame({ type: "system", subtype: "api_retry" }, { seenInit: false }).kind, "ignore");
  // Non-system frames are ignored by the init-only classifier (the turn stream handles them).
  assert.equal(classifyStartupFrame({ type: "assistant" }, { seenInit: false }).kind, "ignore");
  assert.equal(classifyStartupFrame("not-an-object", { seenInit: false }).kind, "ignore");
});

test("v0.6 stream: a well-formed ui_invalidate before init is neutral (zero, one or many, any order)", () => {
  const bare = { type: "system", subtype: "ui_invalidate", event: "ui.render" };
  const withInstances = { type: "system", subtype: "ui_invalidate", event: "ui.render",
    instances: [{ surface: "main", component: "tree", instance_id: "r1" }, { surface: "side", component: "list", instance_id: "r2" }] };
  // Accepted before init...
  assert.equal(classifyStartupFrame(bare, { seenInit: false }).kind, "ignore");
  assert.equal(classifyStartupFrame(withInstances, { seenInit: false }).kind, "ignore");
  // ...repeated, and interleaved with api_retry in any order, still neutral; the following init is classified normally.
  assert.equal(classifyStartupFrame(bare, { seenInit: false }).kind, "ignore");
  assert.equal(classifyStartupFrame({ type: "system", subtype: "api_retry" }, { seenInit: false }).kind, "ignore");
  assert.equal(classifyStartupFrame(initFrame(), { seenInit: false }).kind, "accept");
  // After init it is ignored like any other benign later frame.
  assert.equal(classifyStartupFrame(withInstances, { seenInit: true }).kind, "ignore");
});

test("v0.6 stream: a malformed ui_invalidate fails closed with a sanitized field-name diagnostic", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["wrong event literal", { type: "system", subtype: "ui_invalidate", event: "something.else" }],
    ["missing event", { type: "system", subtype: "ui_invalidate", instances: [] }],
    ["instances not an array", { type: "system", subtype: "ui_invalidate", event: "ui.render", instances: "x" }],
    ["instance not an object", { type: "system", subtype: "ui_invalidate", event: "ui.render", instances: ["x"] }],
    ["instance carries a nested payload", { type: "system", subtype: "ui_invalidate", event: "ui.render", instances: [{ surface: "m", payload: { tool: "Bash" } }] }],
  ];
  for (const [label, frame] of cases) {
    const v = classifyStartupFrame(frame, { seenInit: false });
    assert.equal(v.kind, "reject", label);
    if (v.kind === "reject") { assert.equal(v.reason.code, "preinit_malformed", label); assert.equal(v.reason.event, "ui_invalidate", label); }
  }
  // The diagnostic lists only top-level FIELD NAMES, never values (no nested "tool"/"Bash" leak).
  const bad = classifyStartupFrame({ type: "system", subtype: "ui_invalidate", event: "ui.render", instances: [{ surface: "m", payload: { tool: "Bash" } }] }, { seenInit: false });
  const line = bad.kind === "reject" ? describeStartupRejection("plugin discovery", bad.reason) : "";
  assert.match(line, /code=preinit_malformed, event=ui_invalidate, fields=event\|instances\|subtype\|type/u);
  assert.doesNotMatch(line, /Bash|payload=/u);
});

test("v0.6 stream: an unknown pre-init event still fails closed (not a permissive allowlist)", () => {
  // Sibling ui_* display events are NOT auto-allowed - only the investigated ui_invalidate is.
  for (const subtype of ["ui_log", "ui_toast", "ui_status", "ui_panes", "commands_changed", "elicitation_complete", "vcs_state_changed"]) {
    const v = classifyStartupFrame({ type: "system", subtype }, { seenInit: false });
    assert.equal(rej(v), "preinit_frame", subtype);
    if (v.kind === "reject") assert.equal(v.reason.event, subtype);
  }
});

test("v0.6 stream: valid init orderings and duplicate init frames yield the same verdict", () => {
  // api_retry then init == init: same accept.
  assert.equal(classifyStartupFrame({ type: "system", subtype: "api_retry" }, { seenInit: false }).kind, "ignore");
  const first = classifyStartupFrame(initFrame({ plugins: [builtinEntry] }), { seenInit: false });
  assert.equal(first.kind, "accept");
  // A duplicate init frame, once init has been seen, is ignored (the first one already decided the posture).
  assert.equal(classifyStartupFrame(initFrame({ plugins: [marketEntry] }), { seenInit: true }).kind, "ignore");
  assert.equal(classifyStartupFrame(initFrame({ permissionMode: "bypassPermissions" }), { seenInit: true }).kind, "ignore");
});

test("v0.6 diagnostics: a rejection renders a single-line sanitized reason, no secrets or control characters", () => {
  const line = describeStartupRejection("plugin discovery", { code: "plugin_unidentified", id: "rogue@unlisted", source: "marketplace" });
  assert.equal(line, "plugin state refused during plugin discovery: code=plugin_unidentified, id=rogue@unlisted, source=marketplace");
  assert.doesNotMatch(line, /\n/u);
  const active = describeStartupRejection("plugin verification", { code: "mcp_active", state: "count=1" });
  assert.match(active, /code=mcp_active, state=count=1$/u);
});

// ----------------------------------------------------------------------------------------------------------------
// Integration through the real transport: discovered-vs-loaded is no longer conflated.
// ----------------------------------------------------------------------------------------------------------------
const fixtureBinary = { executable: process.execPath, argvPrefix: [resolve(process.cwd(), "test/fixtures/claude-fake.mjs")] } as const;
const packet: DelegationPacket = { task: { goal: "line 1\n& | $() ü ☃", constraints: [], acceptanceCriteria: [] },
  scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] },
  architecture: { decisions: [], invariants: [] }, verification: { requiredTests: [] }, openQuestions: [] };

async function runScenario(scenario: string) {
  const stateDir = await mkdtemp(join(tmpdir(), "fusion-claude-discovery-"));
  const config: ClaudeLaunchConfig = { executablePath: "unused", workspace: process.cwd(),
    model: { id: "alias", effort: "low", maxTurns: 3 }, expectedCanonicalModel: "claude-canonical-fixture",
    posture: "readOnly", timeoutMs: 5_000, sourceEnvironment: { FUSION_FAKE_SCENARIO: scenario,
      FUSION_FAKE_STATE_DIR: stateDir, SystemRoot: process.env.SystemRoot,
      USERPROFILE: resolve(process.cwd(), "test/fixtures/empty-claude-home") } };
  const transport = new ClaudeOneShotTransport(config, undefined, fixtureBinary);
  try { return { result: await transport.run({ packet, requiredCapabilities: {} }), evidence: transport.runtimeEvidence }; }
  finally { await rm(stateDir, { recursive: true, force: true }); }
}

test("v0.6 discovery: an installed plugin DISCOVERED at init is quarantined, not refused for being present", async () => {
  const { result, evidence } = await runScenario("discovered-installed");
  assert.equal(result.status, "completed", result.status === "failed" ? `${result.error.safeMessage} ${result.error.failureDetail ?? ""}` : undefined);
  assert.equal(evidence?.pluginIsolation?.runtimeLoadedPlugins, 0, "the reviewer's own init still proves no loaded plugin");
  assert.equal(evidence?.pluginIsolation?.installedCount, 1, "the installed plugin is accounted for by the inventory");
  assert.equal(evidence?.pluginIsolation?.builtinCount, 0);
  assert.equal(evidence?.extensionInventory.plugins, 0);
});

test("v0.6 discovery: a discovered plugin with no inventory provenance fails closed with a sanitized reason", async () => {
  const { result, evidence } = await runScenario("discovered-unlisted");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "SecurityViolation");
    assert.match(result.error.safeMessage, /plugin discovery observed unsafe or unsupported startup activity/u);
    // The sanitized detail names the code, identity and provenance class - never the raw path or a secret.
    assert.match(result.error.failureDetail ?? "", /code=plugin_unidentified/u);
    assert.match(result.error.failureDetail ?? "", /source=marketplace/u);
    assert.doesNotMatch(result.error.failureDetail ?? "", /private-path/u);
  }
  assert.equal(evidence, undefined, "no runtime evidence is recorded for a refused launch");
});

test("v0.6 discovery: a pre-init ui_invalidate race (the Worker's case) does not block attestation", async () => {
  const { result, evidence } = await runScenario("probe-ui-invalidate");
  assert.equal(result.status, "completed", result.status === "failed" ? `${result.error.safeMessage} ${result.error.failureDetail ?? ""}` : undefined);
  assert.equal(evidence?.pluginIsolation?.runtimeLoadedPlugins, 0);
});

test("v0.6 discovery: a malformed pre-init ui_invalidate still fails closed", async () => {
  const { result, evidence } = await runScenario("probe-ui-invalidate-bad");
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.error.kind, "SecurityViolation");
    assert.match(result.error.failureDetail ?? "", /code=preinit_malformed, event=ui_invalidate/u);
  }
  assert.equal(evidence, undefined);
});
