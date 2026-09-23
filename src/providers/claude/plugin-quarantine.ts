import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { internalError } from "../../core/errors.js";
import { removeOwnedTemporary, withCleanup } from "../../platform/fs/temporary.js";
import { parseStrictJson } from "../../platform/process/strict-json.js";
import { ProcessSupervisor, type ProcessOutcome, type RunningProcess } from "../../platform/process/supervisor.js";
import { CLAUDE_VALIDATED_EXTENSION_VERSION, ClaudeFailure, fail, record, string } from "./types.js";

export interface ClaudeProcessLaunch {
  readonly executable: string;
  readonly argvPrefix: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface PluginInventory {
  readonly ids: readonly string[];
  readonly counts: Readonly<{ installed: number; builtin: number }>;
}

const unsafeStartup = new Set(["hook_started", "hook_progress", "hook_response", "plugin_install",
  "local_command_output", "task_started", "task_progress", "task_notification"]);
const pluginId = (value: unknown): string | null => {
  const id = string(value);
  return id && id.length <= 256 && !/[\x00-\x1f\x7f]/u.test(id) ? id : null;
};

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

/** Timeout, cancellation and spawn failure keep their own kinds instead of becoming a capability verdict. */
export function failOnLifecycleIssue(outcome: ProcessOutcome, step: string, signal?: AbortSignal): void {
  if (signal?.aborted || outcome.issue?.kind === "Cancelled") fail("Cancelled", "Claude turn was cancelled.");
  if (outcome.issue?.kind === "Timeout") fail("Timeout", `Claude ${step} timed out.`, true);
  if (outcome.issue?.kind === "SpawnFailure") fail("SpawnFailure", `Claude ${step} could not start.`, true);
}

/** Read-only inventory followed by an init-only discovery for built-ins omitted by plugin list. */
export async function preflightPlugins(launch: ClaudeProcessLaunch, supervisor: ProcessSupervisor,
  model: string, effort: string, signal?: AbortSignal, deadlineMs = Number.MAX_SAFE_INTEGER): Promise<PluginInventory> {
  const listed = supervisor.start({ executable: launch.executable,
    args: [...launch.argvPrefix, "plugin", "list", "--json"], cwd: launch.cwd, env: launch.env,
    ...(signal ? { signal } : {}), timeoutMs: Math.min(CLAUDE_PREFLIGHT_TIMEOUTS.pluginListMs, deadlineMs),
    maxStdoutBytes: 1024 * 1024, maxStderrBytes: 16 * 1024 });
  const listing = await listed.result;
  failOnLifecycleIssue(listing, "plugin inventory", signal);
  if (listing.issue || listing.exitCode !== 0 || listing.stdoutTruncated || listing.observerIssues.length)
    fail("CapabilityUnavailable", "Claude plugin inventory could not be confirmed.");
  const inventory = parsePluginInventory(listing.stdout);
  let probe: RunningProcess | undefined;
  let seenInit = false;
  let rejected = false;
  let unsupportedVersion = false;
  let builtin = 0;
  const ids = new Set(inventory.ids);
  probe = supervisor.start({ executable: launch.executable,
    args: [...launch.argvPrefix, ...claudeReadOnlyArgs(model, effort, 1)], cwd: launch.cwd, env: launch.env,
    stdin: "Fusion init-only plugin discovery. Do not use tools.",
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
        if (frame.claude_code_version !== CLAUDE_VALIDATED_EXTENSION_VERSION) {
          unsupportedVersion = true; void probe?.cancel("protocolError"); return;
        }
        if (!Array.isArray(frame.plugins) || frame.permissionMode !== "dontAsk" || frame.apiKeySource !== "none" ||
            !Array.isArray(frame.mcp_servers) || frame.mcp_servers.length !== 0 ||
            !Array.isArray(frame.tools) || JSON.stringify([...frame.tools].sort()) !== JSON.stringify(["Glob", "Grep", "Read"])) {
          rejected = true; void probe?.cancel("protocolError"); return;
        }
        for (const item of frame.plugins) {
          const plugin = record(item);
          const name = pluginId(plugin?.name);
          // Built-ins have no plugin-list row. 2.1.280 accepts name@builtin in enabledPlugins.
          if (!name || typeof plugin?.source !== "string" || !plugin.source.toLowerCase().includes("builtin")) {
            rejected = true; break;
          }
          ids.add(`${name}@builtin`);
          builtin++;
        }
        void probe?.cancel("protocolError");
      } else if (!seenInit && frame?.type === "system" && subtype !== "api_retry") {
        rejected = true; void probe?.cancel("protocolError");
      }
    } });
  const outcome = await probe.result;
  failOnLifecycleIssue(outcome, "plugin discovery", signal);
  if (unsupportedVersion) fail("CapabilityUnavailable", "Claude plugin isolation is unvalidated for this runtime version.");
  if (rejected) fail("SecurityViolation", "Claude plugin discovery observed unsafe or unsupported startup activity.");
  if (!seenInit || outcome.issue || outcome.observerIssues.length || !outcome.termination ||
      outcome.termination.cleanupError)
    fail("CapabilityUnavailable", "Claude built-in plugin discovery could not be confirmed.");
  return { ids: [...ids], counts: { installed: inventory.counts.installed, builtin } };
}

/** The primary outcome always wins; a cleanup failure after success is a typed failure, never silent. */
export async function withTemporaryPluginSettings<T>(ids: readonly string[], run: (path: string) => Promise<T>): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "fusion-claude-plugins-"));
  const path = join(directory, "settings.json");
  return withCleanup(async () => {
    const enabledPlugins = Object.fromEntries(ids.map(id => [id, false]));
    await writeFile(path, JSON.stringify({ enabledPlugins }), { encoding: "utf8", flag: "wx", mode: 0o600 });
    return run(path);
  }, () => removeOwnedTemporary(directory), error => {
    throw new ClaudeFailure(internalError("Temporary Claude plugin settings could not be removed.", error));
  });
}
