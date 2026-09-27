import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { internalError } from "../../core/errors.js";
import { fusionTemporaryBase, removeOwnedTemporary, withCleanup } from "../../platform/fs/temporary.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import { ProcessSupervisor, type ProcessOutcome, type RunningProcess } from "../../platform/process/supervisor.js";
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

/** v0.2.5: the supervisor's cleanup notes as fixed labels (Fusion's own words; never process output). */
const CLEANUP_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "taskkill failed; direct child kill used": "taskkill_failed", "taskkill could not start; direct child kill used": "taskkill_unavailable",
  "process-group kill failed; direct child kill used": "process_group_failed", "process tree termination timed out": "termination_timeout",
  "process tree termination failed": "termination_failed", "process did not exit after forced termination": "process_survived" });
const rootExited = (outcome: ProcessOutcome): boolean => outcome.exitCode !== null || outcome.signal !== null;
interface InitAttempt {
  readonly outcome: ProcessOutcome;
  readonly seenInit: boolean;
  readonly rejected: boolean;
  readonly drifted: boolean;
  readonly plugins: readonly unknown[];
  readonly version: string;
}
/**
 * v0.2.5 — the one uncertainty an init-only startup may be repeated for: everything it showed was verified (init seen and
 * accepted, no stream, protocol or observer issue) and the started process itself exited, but Fusion could not confirm the
 * process TREE was terminated cleanly. On Windows `taskkill /T /F` reports failure when a short-lived helper the runtime
 * started exits while the tree is walked, although nothing survives. Such a startup proves nothing and is refused; it is
 * repeated once, and the repeat must be fully clean. Any other doubt — a process that did not exit, anything unverified —
 * fails closed at once.
 */
const cleanupOnly = (attempt: InitAttempt): boolean => attempt.seenInit && !attempt.rejected && !attempt.drifted &&
  attempt.outcome.issue === undefined && attempt.outcome.observerIssues.length === 0 && attempt.outcome.termination !== undefined &&
  attempt.outcome.termination.cleanupError !== undefined && rootExited(attempt.outcome);
export const CLAUDE_INIT_PROBE_ATTEMPTS = 2;
/** Why an init-only startup could not be confirmed, in Fusion-owned labels and counts only. */
function unconfirmedDetail(step: string, attempt: InitAttempt, attempts: number): string {
  const o = attempt.outcome;
  const cleanup = o.termination?.cleanupError === undefined ? "none" : CLEANUP_LABELS[o.termination.cleanupError] ?? "other";
  return `Claude ${step} startup was not confirmed [init_seen=${attempt.seenInit ? "yes" : "no"} issue=${o.issue?.kind ?? "none"} ` +
    `observer_issues=${o.observerIssues.length} termination=${o.termination?.method ?? "none"} cleanup=${cleanup} ` +
    `root_exited=${rootExited(o) ? "yes" : "no"} exit_code=${o.exitCode ?? "none"} attempts=${attempts}]`;
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
 * only doubt is the process-tree cleanup (`cleanupOnly`) is repeated once; the repeat must be clean.
 */
async function initOnlyPlugins(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor, model: string, effort: string,
  step: "plugin discovery" | "plugin verification", signal: AbortSignal | undefined, deadlineMs: number,
  settingsPath?: string, options: InitProbeOptions = {}): Promise<Readonly<{ plugins: readonly unknown[]; version: string }>> {
  for (let attempts = 1; ; attempts++) {
    const attempt = await initOnlyAttempt(launch, supervisor, model, effort, step, signal, deadlineMs, settingsPath, options);
    failOnLifecycleIssue(attempt.outcome, step, signal);
    if (attempt.drifted) fail("SecurityViolation", `Claude ${step} reported a different runtime version than the startup before it.`);
    if (attempt.rejected) fail("SecurityViolation", `Claude ${step} observed unsafe or unsupported startup activity.`);
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
  let rejected = false;
  let drifted = false;
  let plugins: readonly unknown[] = [];
  let version = "";
  const listsCanary = (value: unknown): boolean => !Array.isArray(value) ||
    value.some(entry => typeof entry !== "string" || entry.toLowerCase().includes(CLAUDE_CANARY_NAME));
  probe = supervisor.start({ executable: launch.executable,
    args: [...launch.argvPrefix, ...claudeReadOnlyArgs(model, effort, 1), ...(settingsPath ? ["--settings", settingsPath] : [])],
    cwd: launch.cwd, env: launch.env, stdin: step === "plugin discovery" ? DISCOVERY_PROMPT : VERIFICATION_PROMPT,
    purpose: "providerInitProbe",
    ...(signal ? { signal } : {}), timeoutMs: Math.min(CLAUDE_PREFLIGHT_TIMEOUTS.initProbeMs, deadlineMs),
    maxStdoutBytes: 512 * 1024, maxStderrBytes: 64 * 1024,
    onJsonl: value => {
      const frame = record(value);
      const subtype = string(frame?.subtype);
      if (frame?.type === "system" && subtype && unsafeStartup.has(subtype)) {
        rejected = true; void probe?.cancel("protocolError"); return;
      }
      if (!seenInit && frame?.type === "system" && subtype === "init") {
        seenInit = true;
        const reported = string(frame.claude_code_version);
        if (reported === null || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/u.test(reported)) {
          rejected = true; void probe?.cancel("protocolError"); return;
        }
        version = reported;
        if (options.expectedVersion !== undefined && reported !== options.expectedVersion) {
          drifted = true; void probe?.cancel("protocolError"); return;
        }
        // Canary workspace: none of its project agents, skills or commands may be loaded, and no hook or connector.
        if (options.canary === true && (listsCanary(frame.agents) || listsCanary(frame.skills) || listsCanary(frame.slash_commands) ||
            (frame.hooks !== undefined && !(Array.isArray(frame.hooks) && frame.hooks.length === 0)) ||
            (frame.connectors !== undefined && !(Array.isArray(frame.connectors) && frame.connectors.length === 0)))) {
          rejected = true; void probe?.cancel("protocolError"); return;
        }
        if (!Array.isArray(frame.plugins) || frame.plugins.length > 256 || frame.permissionMode !== "dontAsk" ||
            frame.apiKeySource !== "none" || !Array.isArray(frame.mcp_servers) || frame.mcp_servers.length !== 0 ||
            !Array.isArray(frame.tools) || JSON.stringify([...frame.tools].sort()) !== JSON.stringify(["Glob", "Grep", "Read"])) {
          rejected = true; void probe?.cancel("protocolError"); return;
        }
        plugins = [...frame.plugins];
        void probe?.cancel("protocolError");
      } else if (!seenInit && frame?.type === "system" && subtype !== "api_retry") {
        rejected = true; void probe?.cancel("protocolError");
      }
    } });
  const outcome = await probe.result;
  return { outcome, seenInit, rejected, drifted, plugins, version };
}

/** Built-ins are identified by runtime source; 2.1.280 accepts `name@builtin` in child-only enabledPlugins. */
function builtinId(item: unknown): string | null {
  const plugin = record(item);
  const name = pluginId(plugin?.name);
  return name && typeof plugin?.source === "string" && plugin.source.toLowerCase().includes("builtin") ? `${name}@builtin` : null;
}

/** Read-only inventory followed by an init-only discovery for built-ins omitted by plugin list. */
export async function preflightPlugins(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor,
  model: string, effort: string, signal?: AbortSignal, deadlineMs = Number.MAX_SAFE_INTEGER, options: InitProbeOptions = {}): Promise<PluginInventory> {
  const inventory = await readInventory(launch, supervisor, signal, deadlineMs);
  const discovered = await initOnlyPlugins(launch, supervisor, model, effort, "plugin discovery", signal, deadlineMs, undefined, options);
  const loaded = discovered.plugins;
  const ids = new Set(inventory.ids);
  let builtin = 0;
  for (const item of loaded) {
    const id = builtinId(item);
    if (!id) fail("SecurityViolation", "Claude plugin discovery observed unsafe or unsupported startup activity.");
    ids.add(id);
    builtin++;
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
