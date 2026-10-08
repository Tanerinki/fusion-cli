import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { internalError } from "../../core/errors.js";
import { fusionTemporaryBase, removeOwnedTemporary, withCleanup } from "../../platform/fs/temporary.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import { CLEANUP_ERRORS, ProcessSupervisor, type ProcessOutcome, type RunningProcess } from "../../platform/process/supervisor.js";
import { ClaudeFailure, describeLoadedPlugins, fail, record, string } from "./types.js";

export interface ClaudeProcessLaunch {
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface PluginInventory {
  readonly ids: readonly string[];
  readonly counts: Readonly<{ installed: number; builtin: number }>;
  /**
   * The runtime version the init-only startups reported (every startup of one preflight must report the same one). What
   * a version may be trusted with is decided by `runtime-attestation.ts`, never here.
   */
  readonly runtimeVersion?: string;
}
/**
 * How an init-only startup is checked beyond the posture every startup must show. `canary`: the startup runs in Fusion's
 * canary workspace (`runtime-attestation.ts`), so none of the canary's project agents, skills or commands may be listed.
 * `expectedVersion`: the version an earlier startup of the same preflight reported; a different one is drift.
 */
export interface InitProbeOptions { readonly canary?: boolean; readonly expectedVersion?: string }
/** The marker every canary extension carries in its name. */
export const CLAUDE_CANARY_NAME = "fusion-canary";
export interface QuarantineResult extends PluginInventory {
  /** Init-only startups with the child-only settings that were needed until one reported no loaded plugin. */
  readonly verificationRounds: number;
}

const unsafeStartup = new Set(["hook_started", "hook_progress", "hook_response", "plugin_install",
  "local_command_output", "task_started", "task_progress", "task_notification"]);
const pluginId = (value: unknown): string | null => {
  const id = string(value);
  return id && id.length <= 256 && !/[\x00-\x1f\x7f]/u.test(id) ? id : null;
};
const DISCOVERY_PROMPT = "Fusion init-only plugin discovery. Do not use tools.";
const VERIFICATION_PROMPT = "Fusion init-only plugin verification. Do not use tools.";

/**
 * Why a startup frame is refused, in Fusion-owned labels only (never raw process text, tokens, usernames or paths).
 * Policy keys on ACTIVE capability exposure, not on plugin names: the init frame's `plugins` array is discovery
 * metadata (name/path/source) that proves nothing on its own — a plugin is unsafe only when a surface it would drive
 * is active (a tool, an MCP server, a hook or command event) or when it cannot be identified well enough to disable.
 */
export type StartupRejectionCode =
  | "unsafe_event"        // a hook / task / plugin-install / command-output system event during startup
  | "preinit_frame"       // an unknown system frame (other than init / api_retry / a known-benign one) before init
  | "preinit_malformed"   // a known pre-init frame (e.g. ui_invalidate) whose shape could not be validated
  | "version_format"      // the reported runtime version was missing or malformed
  | "tools_surface"       // the active tool set was not exactly the read-only three
  | "mcp_active"          // an MCP server was active
  | "api_key_source"      // the credential source was not `none`
  | "permission_mode"     // the permission mode was not `dontAsk`
  | "plugins_shape"       // the plugins field was not an array, or was implausibly large
  | "canary_surface"      // a canary project agent / skill / command / hook / connector loaded
  | "plugin_unidentified"; // a discovered plugin could not be identified, so it cannot be disabled
export interface StartupRejection {
  readonly code: StartupRejectionCode;
  readonly event?: string;   // sanitized system-frame subtype
  readonly id?: string;      // sanitized plugin identity (its `source`, else `name`)
  readonly source?: string;  // provenance CLASS (builtin / marketplace / path / unknown), never a raw path
  readonly state?: string;   // sanitized lifecycle / posture label
  readonly fields?: string;  // sanitized top-level FIELD NAMES of a malformed frame (names only, never values)
}
/** A Fusion-owned label distilled from untrusted text: control and non-ASCII characters removed, length-capped. */
function sanitizeLabel(value: unknown, max = 64): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const cleaned = value.replace(/[^\x20-\x7e]/gu, "").trim().slice(0, max);
  return cleaned.length > 0 ? cleaned : undefined;
}
/** The provenance CLASS of a plugin for diagnostics only — never the raw path. Mirrors `describeLoadedPlugins`. */
function pluginSourceClass(item: unknown): string {
  const plugin = record(item), source = string(plugin?.source);
  if (plugin?.path === "builtin" || (source !== null && /@builtin$/iu.test(source))) return "builtin";
  if (source !== null && /^[^@\s]+@[^@\s]+$/u.test(source)) return "marketplace";
  if (typeof plugin?.path === "string") return "path";
  return "unknown";
}
/** The sanitized labels of a discovered plugin for a `plugin_unidentified` rejection: identity and source class only. */
function pluginLabels(item: unknown): Pick<StartupRejection, "id" | "source"> {
  const plugin = record(item);
  const id = sanitizeLabel(plugin?.source ?? plugin?.name);
  return { ...(id ? { id } : {}), source: pluginSourceClass(item) };
}
/** One-line sanitized reason for the probe's posture detail: `plugin state refused: code=…, id=…, source=…, …`. */
export function describeStartupRejection(step: string, reason: StartupRejection): string {
  const parts = [`code=${reason.code}`];
  if (reason.id) parts.push(`id=${reason.id}`);
  if (reason.source) parts.push(`source=${reason.source}`);
  if (reason.state) parts.push(`state=${reason.state}`);
  if (reason.event) parts.push(`event=${reason.event}`);
  if (reason.fields) parts.push(`fields=${reason.fields}`);
  return `plugin state refused during ${step}: ${parts.join(", ")}`;
}
/** The sanitized top-level FIELD NAMES of a frame (names only, sorted, bounded) — for a malformed-frame diagnostic. */
function safeFieldNames(frame: Record<string, unknown>): Pick<StartupRejection, "fields"> {
  const names = Object.keys(frame).map(key => sanitizeLabel(key, 40)).filter((key): key is string => key !== undefined).sort().slice(0, 12);
  return names.length > 0 ? { fields: names.join("|") } : {};
}

const VERSION_RE = /^\d{1,4}\.\d{1,4}\.\d{1,6}$/u;
/** The upper bound on a benign `ui_invalidate`'s render-instance list; a longer one is treated as malformed. */
const UI_INVALIDATE_INSTANCE_LIMIT = 256;
/**
 * Whether a pre-init `system/ui_invalidate` frame is the benign render-invalidation notification Claude Code emits.
 *
 * Established from the 2.1.289 runtime itself (static read of the bundle, no launch): the engine versions `ui.render`
 * as a single event and emits `{type:"system", subtype:"ui_invalidate", event:"ui.render", instances?}` whenever that
 * render version moves, so the client re-asks its mounted surface instances to redraw. `instances` (optional) names only
 * the surface / component / instance that drew, as flat primitives. It is one of a family of display-only `ui_*` system
 * messages (ui_log, ui_toast, ui_status, ui_panes, ui_scroll, ui_focus) and carries NO tool, hook, MCP, plugin, command,
 * permission, credential or settings surface — those live in the init frame's own fields and in the hook/command/plugin
 * events already refused as `unsafe_event`. This validator accepts ONLY that exact shape; any deviation is malformed and
 * fails closed, and only `ui_invalidate` is recognised — every other pre-init frame stays an unknown-event refusal.
 */
function benignUiInvalidate(frame: Record<string, unknown>): boolean {
  if (frame.event !== "ui.render") return false;
  const instances = frame.instances;
  if (instances === undefined) return true;
  if (!Array.isArray(instances) || instances.length > UI_INVALIDATE_INSTANCE_LIMIT) return false;
  // Each render instance must be a flat object of primitive values; a nested object or array is an unvalidatable payload.
  return instances.every(entry => {
    const rec = record(entry);
    return rec !== null && Object.values(rec).every(value =>
      value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean");
  });
}
/** A canary surface lists a Fusion-canary item (or is not the empty array it must be). */
const listsCanary = (value: unknown): boolean => !Array.isArray(value) ||
  value.some(entry => typeof entry !== "string" || entry.toLowerCase().includes(CLAUDE_CANARY_NAME));

export type InitFrameVerdict =
  | Readonly<{ kind: "accept"; plugins: readonly unknown[]; version: string }>
  | Readonly<{ kind: "reject"; reason: StartupRejection }>
  | Readonly<{ kind: "drift"; version: string }>;
export type StartupFrameVerdict = InitFrameVerdict | Readonly<{ kind: "ignore" }>;

/**
 * Classifies a system/init frame against the posture every startup must show. Pure: the same frame and options always
 * yield the same verdict. The `plugins` array is DISCOVERY metadata — it is returned for the quarantine to disable, not
 * judged here; active exposure is judged by the tool / MCP / permission / credential fields (and, for the canary, the
 * agent / skill / command / hook / connector fields). A startup that lists a discovered-but-inactive plugin is accepted.
 */
export function classifyInitFrame(frame: Record<string, unknown>, options: InitProbeOptions = {}): InitFrameVerdict {
  const reported = string(frame.claude_code_version);
  if (reported === null || !VERSION_RE.test(reported)) return { kind: "reject", reason: { code: "version_format" } };
  if (options.expectedVersion !== undefined && reported !== options.expectedVersion) return { kind: "drift", version: reported };
  if (options.canary === true && (listsCanary(frame.agents) || listsCanary(frame.skills) || listsCanary(frame.slash_commands) ||
      (frame.hooks !== undefined && !(Array.isArray(frame.hooks) && frame.hooks.length === 0)) ||
      (frame.connectors !== undefined && !(Array.isArray(frame.connectors) && frame.connectors.length === 0))))
    return { kind: "reject", reason: { code: "canary_surface" } };
  if (frame.permissionMode !== "dontAsk")
    return { kind: "reject", reason: { code: "permission_mode", ...(sanitizeLabel(frame.permissionMode) ? { state: sanitizeLabel(frame.permissionMode)! } : {}) } };
  if (frame.apiKeySource !== "none")
    return { kind: "reject", reason: { code: "api_key_source", ...(sanitizeLabel(frame.apiKeySource) ? { state: sanitizeLabel(frame.apiKeySource)! } : {}) } };
  if (!Array.isArray(frame.mcp_servers) || frame.mcp_servers.length !== 0)
    return { kind: "reject", reason: { code: "mcp_active", ...(Array.isArray(frame.mcp_servers) ? { state: `count=${frame.mcp_servers.length}` } : {}) } };
  if (!Array.isArray(frame.tools) || JSON.stringify([...frame.tools].sort()) !== JSON.stringify(["Glob", "Grep", "Read"]))
    return { kind: "reject", reason: { code: "tools_surface" } };
  if (!Array.isArray(frame.plugins) || frame.plugins.length > 256)
    return { kind: "reject", reason: { code: "plugins_shape" } };
  return { kind: "accept", plugins: [...frame.plugins], version: reported };
}
/**
 * Classifies one startup stream frame given whether init has already been seen. Pure, and independent of event order:
 * an unsafe event refuses at any point, only the first init frame is classified, and any later or duplicate frame is
 * ignored. Before init, a well-formed `ui_invalidate` render notification is neutral (it may appear zero, one or many
 * times, in any order among benign startup metadata); a malformed `ui_invalidate` (`preinit_malformed`) and every other
 * non-init, non-`api_retry` system frame (`preinit_frame`) fail closed. This is a single, shape-validated exception for
 * the one event proven benign on this runtime — NOT a permissive pre-init allowlist.
 */
export function classifyStartupFrame(value: unknown, context: Readonly<{ seenInit: boolean; options?: InitProbeOptions }>): StartupFrameVerdict {
  const frame = record(value);
  if (!frame || frame.type !== "system") return { kind: "ignore" };
  const subtype = string(frame.subtype);
  if (subtype !== null && unsafeStartup.has(subtype)) return { kind: "reject", reason: { code: "unsafe_event", ...(sanitizeLabel(subtype) ? { event: sanitizeLabel(subtype)! } : {}) } };
  if (context.seenInit) return { kind: "ignore" };
  if (subtype === "init") return classifyInitFrame(frame, context.options ?? {});
  if (subtype === "api_retry") return { kind: "ignore" };
  // A render-invalidation notification before init carries no capability surface; accept the exact shape, refuse any other.
  if (subtype === "ui_invalidate") return benignUiInvalidate(frame) ? { kind: "ignore" }
    : { kind: "reject", reason: { code: "preinit_malformed", event: "ui_invalidate", ...safeFieldNames(frame) } };
  return { kind: "reject", reason: { code: "preinit_frame", ...(sanitizeLabel(subtype) ? { event: sanitizeLabel(subtype)! } : {}) } };
}

/** The native 2.1.280 command returns an array. Unknown row shapes fail closed. */
export function parsePluginInventory(raw: string): PluginInventory {
  let parsed: unknown;
  try { parsed = parseStrictJson(raw); }
  catch { fail("ProtocolError", "Claude plugin inventory JSON was malformed."); }
  if (!Array.isArray(parsed) || parsed.length > 512)
    fail("ProtocolError", "Claude plugin inventory shape was unsupported.");
  const ids = new Set<string>();
  for (const item of parsed) {
    const row = record(item);
    const id = pluginId(row?.id ?? row?.pluginId);
    if (!row || !id) fail("ProtocolError", "Claude plugin inventory row was unsupported.");
    if (row.required === true || row.requiredByOrg === true || row.isRequired === true)
      fail("CapabilityUnavailable", "A required Claude plugin cannot be quarantined.");
    ids.add(id);
  }
  return { ids: [...ids], counts: { installed: parsed.length, builtin: 0 } };
}

export function claudeReadOnlyArgs(model: string, effort: string, maxTurns: number): string[] {
  return ["-p", "--input-format", "text", "--output-format", "stream-json", "--verbose",
    "--include-hook-events", "--model", model, "--effort", effort,
    "--permission-mode", "dontAsk", "--permission-prompts", "none", "--tools", "Read,Grep,Glob",
    "--restricted", "--safe-mode", "--disable-slash-commands", "--strict-mcp-config",
    "--no-session-persistence", "--max-turns", String(maxTurns)];
}

/** Default preflight deadlines; each is additionally capped by the caller's turn deadline. */
export const CLAUDE_PREFLIGHT_TIMEOUTS = Object.freeze({ authStatusMs: 15_000, pluginListMs: 15_000, initProbeMs: 30_000 });
/**
 * Claude can materialize plugins between consecutive startups (remote feature-flag caches, claude.ai plugin
 * sync, marketplace auto-install). Verification therefore repeats with the reviewer's exact settings until one
 * startup reports no loaded plugin, bounded so a set that keeps changing fails closed.
 */
export const CLAUDE_QUARANTINE_MAX_VERIFICATIONS = 3;

/** Timeout, cancellation and spawn failure keep their own kinds instead of becoming a capability verdict. */
export function failOnLifecycleIssue(outcome: ProcessOutcome, step: string, signal?: AbortSignal): void {
  if (signal?.aborted || outcome.issue?.kind === "Cancelled") fail("Cancelled", "Claude turn was cancelled.");
  if (outcome.issue?.kind === "Timeout") fail("Timeout", `Claude ${step} timed out.`, true);
  // v0.2.5: the platform's error code and whether the process had started (a failed kill is not a failed start).
  if (outcome.issue?.kind === "SpawnFailure") fail("SpawnFailure", `Claude ${step} could not start.`, true,
    `Claude ${step} reported a process error [error_code=${outcome.issue.errorCode ?? "none"} after_spawn=${outcome.issue.afterSpawn === true ? "yes" : "no"}]`);
}

/**
 * The supervisor's AUTHORITATIVE cleanup verdicts as fixed labels (Fusion's own words; never process output, paths or
 * command lines). Any other value is labelled `other` and is never repeated.
 */
const CLEANUP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  [CLEANUP_ERRORS.processSurvived]: "process_survived", [CLEANUP_ERRORS.treeUncaptured]: "tree_uncaptured",
  [CLEANUP_ERRORS.treeUnverified]: "tree_unverified", [CLEANUP_ERRORS.descendantSurvived]: "descendant_survived" });
/**
 * Cleanup AMBIGUITY: nothing is known to survive, but the owned tree could not be proven gone. Only this may be repeated.
 * Positive evidence that something survived (`process_survived`, `descendant_survived`) is never repeated.
 */
const AMBIGUOUS_CLEANUP: ReadonlySet<string> = new Set([CLEANUP_ERRORS.treeUncaptured, CLEANUP_ERRORS.treeUnverified]);
const rootExited = (outcome: ProcessOutcome): boolean => outcome.exitCode !== null || outcome.signal !== null;
interface InitAttempt {
  readonly outcome: ProcessOutcome;
  readonly seenInit: boolean;
  /** The first sanitized rejection the startup produced, or undefined when nothing was refused. */
  readonly rejection?: StartupRejection;
  readonly drifted: boolean;
  readonly plugins: readonly unknown[];
  readonly version: string;
}
/**
 * The one uncertainty an init-only startup may be repeated for: everything it showed was verified (init seen and
 * accepted, no stream, protocol or observer issue), the started process itself exited, and the supervisor could not
 * PROVE its owned process tree gone - the tree could not be captured or its liveness could not be decided (cleanup
 * ambiguity; a taskkill exit code is never part of that judgement). Such a startup proves nothing and is refused; it is
 * repeated once, and the repeat must be fully clean. Positive evidence that something survived - the started process
 * did not exit, or an owned descendant outlived the forced termination - fails closed at once: no second Claude starts
 * while part of the first is known to run. Any other doubt also fails closed at once.
 */
const cleanupOnly = (attempt: InitAttempt): boolean => attempt.seenInit && attempt.rejection === undefined && !attempt.drifted &&
  attempt.outcome.issue === undefined && attempt.outcome.observerIssues.length === 0 && attempt.outcome.termination !== undefined &&
  attempt.outcome.termination.cleanupError !== undefined && AMBIGUOUS_CLEANUP.has(attempt.outcome.termination.cleanupError) &&
  rootExited(attempt.outcome);
export const CLAUDE_INIT_PROBE_ATTEMPTS = 2;
/** Why an init-only startup could not be confirmed, in Fusion-owned labels and counts only. */
function unconfirmedDetail(step: string, attempt: InitAttempt, attempts: number): string {
  const o = attempt.outcome;
  const cleanup = o.termination?.cleanupError === undefined ? "none" : CLEANUP_LABELS[o.termination.cleanupError] ?? "other";
  return `Claude ${step} startup was not confirmed [init_seen=${attempt.seenInit ? "yes" : "no"} issue=${o.issue?.kind ?? "none"} ` +
    `observer_issues=${o.observerIssues.length} termination=${o.termination?.method ?? "none"} cleanup=${cleanup} ` +
    `process_exited=${rootExited(o) ? "yes" : "no"} exit_code=${o.exitCode ?? "none"} attempts=${attempts}]`;
}

async function readInventory(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor,
  signal: AbortSignal | undefined, deadlineMs: number): Promise<PluginInventory> {
  const listing = await supervisor.start({ executable: launch.executable,
    args: [...launch.argvPrefix, "plugin", "list", "--json"], cwd: launch.cwd, env: launch.env, purpose: "providerInventory",
    ...(signal ? { signal } : {}), timeoutMs: Math.min(CLAUDE_PREFLIGHT_TIMEOUTS.pluginListMs, deadlineMs),
    maxStdoutBytes: 1024 * 1024, maxStderrBytes: 16 * 1024 }).result;
  failOnLifecycleIssue(listing, "plugin inventory", signal);
  if (listing.issue || listing.exitCode !== 0 || listing.stdoutTruncated || listing.observerIssues.length)
    fail("CapabilityUnavailable", "Claude plugin inventory could not be confirmed.");
  return parsePluginInventory(listing.stdout);
}

/**
 * One reviewer-shaped startup, cancelled at system/init before any turn. Returns the loaded-plugin list.
 * Unsafe startup activity, version drift, or a drifted tool/permission/MCP/auth posture fail closed. A startup whose
 * only doubt is an ambiguous process-tree cleanup (`cleanupOnly`) is repeated once; the repeat must be clean.
 */
async function initOnlyPlugins(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor, model: string, effort: string,
  step: "plugin discovery" | "plugin verification", signal: AbortSignal | undefined, deadlineMs: number,
  settingsPath?: string, options: InitProbeOptions = {}): Promise<Readonly<{ plugins: readonly unknown[]; version: string }>> {
  for (let attempts = 1; ; attempts++) {
    const attempt = await initOnlyAttempt(launch, supervisor, model, effort, step, signal, deadlineMs, settingsPath, options);
    failOnLifecycleIssue(attempt.outcome, step, signal);
    if (attempt.drifted) fail("SecurityViolation", `Claude ${step} reported a different runtime version than the startup before it.`);
    if (attempt.rejection) fail("SecurityViolation", `Claude ${step} observed unsafe or unsupported startup activity.`,
      false, describeStartupRejection(step, attempt.rejection));
    const o = attempt.outcome;
    if (!attempt.seenInit || o.issue || o.observerIssues.length || !o.termination || o.termination.cleanupError) {
      if (cleanupOnly(attempt) && attempts < CLAUDE_INIT_PROBE_ATTEMPTS) continue;
      fail("CapabilityUnavailable", step === "plugin discovery" ?
        "Claude built-in plugin discovery could not be confirmed." : "Claude plugin quarantine verification could not be confirmed.",
        false, unconfirmedDetail(step, attempt, attempts));
    }
    return { plugins: attempt.plugins, version: attempt.version };
  }
}
async function initOnlyAttempt(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor, model: string, effort: string,
  step: "plugin discovery" | "plugin verification", signal: AbortSignal | undefined, deadlineMs: number,
  settingsPath?: string, options: InitProbeOptions = {}): Promise<InitAttempt> {
  let probe: RunningProcess | undefined;
  let seenInit = false;
  let rejection: StartupRejection | undefined;
  let drifted = false;
  let plugins: readonly unknown[] = [];
  let version = "";
  probe = supervisor.start({ executable: launch.executable,
    args: [...launch.argvPrefix, ...claudeReadOnlyArgs(model, effort, 1), ...(settingsPath ? ["--settings", settingsPath] : [])],
    cwd: launch.cwd, env: launch.env, stdin: step === "plugin discovery" ? DISCOVERY_PROMPT : VERIFICATION_PROMPT,
    purpose: "providerInitProbe",
    ...(signal ? { signal } : {}), timeoutMs: Math.min(CLAUDE_PREFLIGHT_TIMEOUTS.initProbeMs, deadlineMs),
    maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024,
    onJsonl: value => {
      const verdict = classifyStartupFrame(value, { seenInit, options });
      switch (verdict.kind) {
        case "ignore": return;
        case "reject": rejection ??= verdict.reason; void probe?.cancel("protocolError"); return;
        case "drift": drifted = true; version = verdict.version; void probe?.cancel("protocolError"); return;
        case "accept": seenInit = true; plugins = verdict.plugins; version = verdict.version; void probe?.cancel("protocolError"); return;
      }
    } });
  const outcome = await probe.result;
  return { outcome, seenInit, ...(rejection ? { rejection } : {}), drifted, plugins, version };
}

/** Built-ins are identified by runtime source; 2.1.280 accepts `name@builtin` in child-only enabledPlugins. */
function builtinId(item: unknown): string | null {
  const plugin = record(item);
  const name = pluginId(plugin?.name);
  return name && typeof plugin?.source === "string" && plugin.source.toLowerCase().includes("builtin") ? `${name}@builtin` : null;
}

/**
 * Read-only inventory followed by an init-only discovery, enumerating every plugin the runtime lists so the quarantine
 * can disable it. The init frame's `plugins` field is DISCOVERY metadata, not proof that a plugin is loaded or active —
 * a plugin merely present, contributing no active surface (the init frame already proved the exact read-only tools, no
 * MCP server, `dontAsk` and credential source `none`), is not refused for being present. Each discovered plugin is
 * identified exactly as `convergePluginQuarantine` identifies a late one: a built-in by runtime source, or an
 * installed/account-synced plugin the inventory lists; only a plugin that cannot be identified — so cannot be placed in
 * the disable set — fails closed. The zero-loaded guarantee is still proven later, by the quarantine convergence.
 */
export async function preflightPlugins(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor,
  model: string, effort: string, signal?: AbortSignal, deadlineMs = Number.MAX_SAFE_INTEGER, options: InitProbeOptions = {}): Promise<PluginInventory> {
  const inventory = await readInventory(launch, supervisor, signal, deadlineMs);
  const discovered = await initOnlyPlugins(launch, supervisor, model, effort, "plugin discovery", signal, deadlineMs, undefined, options);
  const loaded = discovered.plugins;
  const ids = new Set(inventory.ids);
  let builtin = 0;
  for (const item of loaded) {
    let id = builtinId(item);
    if (id !== null) builtin++;
    else {
      // Not a runtime built-in: identify it by the installed inventory so quarantine can disable it. A discovered
      // plugin that the inventory does not account for cannot be placed in the disable set, so it fails closed.
      const source = pluginId(record(item)?.source);
      if (source === null || !inventory.ids.includes(source))
        fail("SecurityViolation", "Claude plugin discovery observed unsafe or unsupported startup activity.", false,
          describeStartupRejection("plugin discovery", { code: "plugin_unidentified", ...pluginLabels(item) }));
      id = source;
    }
    ids.add(id);
  }
  return { ids: [...ids], counts: { installed: inventory.counts.installed, builtin }, runtimeVersion: discovered.version };
}

/**
 * Proves the child-only settings on the startup immediately preceding the reviewer. A plugin that appears
 * now is added to the disable set only when its provenance is established: a built-in by runtime source, or
 * an installed/account-synced plugin that the refreshed inventory lists. Anything unidentified, anything that
 * stays loaded after being disabled, or a set that keeps changing fails closed. Nothing is ever accepted as
 * loaded; the reviewer's own system/init must still report no plugins.
 */
export async function convergePluginQuarantine(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor,
  model: string, effort: string, initial: PluginInventory, settingsPath: string,
  rewrite: (ids: readonly string[]) => Promise<void>, signal?: AbortSignal,
  deadlineMs = Number.MAX_SAFE_INTEGER, options: InitProbeOptions = {}): Promise<QuarantineResult> {
  const ids = new Set(initial.ids);
  let builtin = initial.counts.builtin;
  let installed = initial.counts.installed;
  const expectedVersion = options.expectedVersion ?? initial.runtimeVersion;
  for (let round = 1; round <= CLAUDE_QUARANTINE_MAX_VERIFICATIONS; round++) {
    const { plugins: loaded, version } = await initOnlyPlugins(launch, supervisor, model, effort, "plugin verification", signal, deadlineMs, settingsPath,
      { ...options, ...(expectedVersion === undefined ? {} : { expectedVersion }) });
    if (loaded.length === 0) return { ids: [...ids], counts: { installed, builtin }, verificationRounds: round, runtimeVersion: version };
    const shape = describeLoadedPlugins(loaded);
    let refreshed: PluginInventory | undefined;
    for (const item of loaded) {
      let id = builtinId(item);
      if (id === null) {
        const source = pluginId(record(item)?.source);
        refreshed ??= await readInventory(launch, supervisor, signal, deadlineMs);
        if (!source || !refreshed.ids.includes(source))
          fail("SecurityViolation", `Claude loaded a plugin absent from its installed inventory (${shape}).`);
        installed = Math.max(installed, refreshed.counts.installed);
        id = source;
      } else if (!ids.has(id)) builtin++;
      if (ids.has(id)) fail("SecurityViolation", `A disabled Claude plugin stayed loaded; quarantine cannot be proven (${shape}).`);
      ids.add(id);
    }
    await rewrite([...ids]);
  }
  fail("SecurityViolation", "Claude plugin quarantine did not converge before the reviewer launch.");
}

/** Child-only settings. The primary outcome always wins; a cleanup failure after success is typed, never silent. */
export async function withTemporaryPluginSettings<T>(ids: readonly string[],
  run: (path: string, rewrite: (ids: readonly string[]) => Promise<void>) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(fusionTemporaryBase(), "fusion-claude-plugins-"));
  const path = join(directory, "settings.json");
  const serialize = (list: readonly string[]): string =>
    JSON.stringify({ enabledPlugins: Object.fromEntries(list.map(id => [id, false])) });
  return withCleanup(async () => {
    await writeFile(path, serialize(ids), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return run(path, async next => { await writeFile(path, serialize(next), { encoding: "utf8", flag: "w", mode: 0o600 }); });
  }, () => removeOwnedTemporary(directory), error => {
    throw new ClaudeFailure(internalError("Temporary Claude plugin settings could not be removed.", error));
  });
}
