import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fusionTemporaryBase, removeOwnedTemporary } from "../../platform/fs/temporary.js";
import type { ProcessSupervisor } from "../../platform/process/supervisor.js";
import { CLAUDE_CANARY_NAME, convergePluginQuarantine, preflightPlugins, withTemporaryPluginSettings,
  type ClaudeProcessLaunch } from "./plugin-quarantine.js";
import { CLAUDE_VALIDATED_EXTENSION_VERSION, ClaudeFailure, fail } from "./types.js";

/**
 * CLAUDE RUNTIME COMPATIBILITY — capability-based, not exact-patch-based.
 *
 * What Fusion must know about a Claude Code runtime before a read-only turn falls into three groups:
 *
 *  1. PROVEN ON EVERY TURN, whatever the version (unchanged): the exact tool set Read, Grep, Glob (so no Write, Edit,
 *     NotebookEdit, shell or web tool exists), permission mode `dontAsk` (no approval escalation), no MCP server, zero
 *     loaded plugins after the quarantine converged, no hook, connector, plugin-install or slash-command activity, the
 *     credential source `none` with a first-party subscription login (no API-key or PAYG lane, no overage), the configured
 *     canonical model, one strict stream whose result uses the known vocabulary, and one runtime version on every startup.
 *  2. THE MEANING OF LAUNCH FLAGS that no init field shows: `--restricted` ignores user, project and local settings;
 *     `--safe-mode` disables CLAUDE.md, skills, hooks, plugins and MCP; `--disable-slash-commands`; `--strict-mcp-config`.
 *     This is the only version-specific knowledge. It is either RECORDED (validated by live probing on
 *     `CLAUDE_VALIDATED_EXTENSION_VERSION`) or ATTESTED on this exact runtime by a mechanical canary: init-only startups,
 *     cancelled before any model call, in a Fusion-owned workspace whose project and local settings, MCP file, agents,
 *     skills and commands would each be visible (or would write a marker file) if the flags did not hold.
 *  3. EVERYTHING ELSE is refused: a runtime outside a release line Fusion has recorded (`2.1.x` from the validated patch
 *     on) is not attested at all — a new release line needs a Fusion update.
 *
 * Residual, stated rather than hidden: whether CLAUDE.md content reaches the model is not observable without a model turn;
 * on an attested runtime it rests on `--safe-mode`, whose other effects (skills, commands, agents, hooks) the canary proves
 * on that runtime. Managed policy hooks stay unverified, as on the validated runtime.
 *
 * Evidence is observed in this Fusion process and kept in memory only; nothing read back from a file can attest a runtime.
 */
export type ClaudeRuntimeSupport =
  | Readonly<{ kind: "validated"; version: string }>
  | Readonly<{ kind: "attestable"; version: string }>
  | Readonly<{ kind: "unsupported"; version: string }>;
const SEMVER = /^(\d{1,4})\.(\d{1,4})\.(\d{1,6})$/u;
/** The recorded release line (major.minor of the validated runtime) and the lowest patch of it Fusion may attest. */
const VALIDATED = SEMVER.exec(CLAUDE_VALIDATED_EXTENSION_VERSION)!;

export function claudeRuntimeSupport(version: string): ClaudeRuntimeSupport {
  if (version === CLAUDE_VALIDATED_EXTENSION_VERSION) return { kind: "validated", version };
  const parsed = SEMVER.exec(version);
  if (parsed !== null && parsed[1] === VALIDATED[1] && parsed[2] === VALIDATED[2] && Number(parsed[3]) > Number(VALIDATED[3]))
    return { kind: "attestable", version };
  return { kind: "unsupported", version };
}

export interface ClaudePostureAttestation {
  readonly version: string;
  /** `recordedValidation`: the validated release. `runtimeCanary`: this runtime passed the canary in this process. */
  readonly method: "recordedValidation" | "runtimeCanary";
  /** What was proven, as labels. */
  readonly checks: readonly string[];
  readonly observedAt: string;
}
export const RECORDED_VALIDATION_CHECKS = Object.freeze(["recorded-live-validation"]);
export const CANARY_CHECKS = Object.freeze(["project-settings-hook-not-run", "local-settings-hook-not-run", "canary-hook-not-reported",
  "project-mcp-not-loaded", "project-agents-not-loaded", "project-skills-not-loaded", "project-commands-not-loaded",
  "permission-mode-dontAsk-despite-settings", "exact-read-only-tools", "zero-plugins-after-quarantine", "one-runtime-version"]);

/** A plain-language refusal for a runtime Fusion has not verified, naming the command that checks it. */
export function unverifiedRuntimeMessage(version: string, reason: string): string {
  return `Fusion has not verified the safety posture of Claude Code ${version} (${reason}), so it did not send anything to the model. ` +
    "Run `fusion doctor --probe` to check this runtime now.";
}
export function unsupportedRuntimeMessage(version: string): string {
  return unverifiedRuntimeMessage(version, `Fusion only checks Claude Code ${VALIDATED[1]}.${VALIDATED[2]}.x releases from ` +
    `${CLAUDE_VALIDATED_EXTENSION_VERSION} on; supporting another release line needs a Fusion update`);
}

// ---------------------------------------------------------------- the canary workspace

const HOOK_MARKERS = Object.freeze(["fusion-canary-hook-project", "fusion-canary-hook-local"]);
/** Harmless in any shell: each hook would only create an empty marker file in the canary workspace. */
const hook = (marker: string) => ({ SessionStart: [{ hooks: [{ type: "command", command: `echo canary> ${marker}` }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: `echo canary> ${marker}` }] }] });
/**
 * The canary: project settings that would widen permissions, run hooks and enable an MCP server; local settings with
 * their own hook; an MCP file; a project agent, skill and command; a CLAUDE.md. Under Fusion's flags none of it may load.
 * The MCP command does not exist, so even a broken quarantine starts nothing.
 */
export const CANARY_FILES: Readonly<Record<string, string>> = Object.freeze({
  ".claude/settings.json": JSON.stringify({ permissions: { defaultMode: "bypassPermissions", allow: ["Bash", "Write", "Edit", "WebFetch"] },
    enableAllProjectMcpServers: true, hooks: hook(HOOK_MARKERS[0]!) }, null, 2),
  ".claude/settings.local.json": JSON.stringify({ permissions: { allow: ["NotebookEdit", "WebSearch"] }, hooks: hook(HOOK_MARKERS[1]!) }, null, 2),
  ".mcp.json": JSON.stringify({ mcpServers: { [CLAUDE_CANARY_NAME]: { command: `${CLAUDE_CANARY_NAME}-mcp-server-that-does-not-exist` } } }, null, 2),
  [`.claude/agents/${CLAUDE_CANARY_NAME}.md`]: `---\nname: ${CLAUDE_CANARY_NAME}\ndescription: Fusion canary agent.\n---\nCanary.\n`,
  [`.claude/skills/${CLAUDE_CANARY_NAME}/SKILL.md`]: `---\nname: ${CLAUDE_CANARY_NAME}\ndescription: Fusion canary skill.\n---\nCanary.\n`,
  [`.claude/commands/${CLAUDE_CANARY_NAME}.md`]: "Fusion canary command.\n",
  "CLAUDE.md": "Fusion canary project memory.\n",
});

/**
 * Attests the launch-flag posture of the runtime `launch` starts, in a fresh canary workspace: the same inventory,
 * discovery and quarantine-verification startups as a real turn (init-only, cancelled before any model call), each also
 * checked against the canary, then the hook markers. Returns the attestation, or fails closed with a plain reason.
 * `expectedVersion`: the version the caller's own startups reported; the canary must see the same runtime.
 */
export async function attestClaudePosture(launch: Omit<ClaudeProcessLaunch, "cwd">, supervisor: ProcessSupervisor, model: string, effort: string,
  options: Readonly<{ expectedVersion?: string; signal?: AbortSignal; deadlineMs?: number }> = {}): Promise<ClaudePostureAttestation> {
  const deadlineMs = options.deadlineMs ?? Number.MAX_SAFE_INTEGER;
  const directory = await mkdtemp(join(fusionTemporaryBase(), "fusion-claude-attest-"));
  try {
    for (const [path, content] of Object.entries(CANARY_FILES)) {
      const full = join(directory, ...path.split("/"));
      await mkdir(join(full, ".."), { recursive: true });
      await writeFile(full, content, { flag: "wx" });
    }
    const at: ClaudeProcessLaunch = { ...launch, cwd: directory };
    let version: string;
    try {
      const inventory = await preflightPlugins(at, supervisor, model, effort, options.signal, deadlineMs, { canary: true,
        ...(options.expectedVersion === undefined ? {} : { expectedVersion: options.expectedVersion }) });
      version = inventory.runtimeVersion ?? "";
      if (claudeRuntimeSupport(version).kind === "unsupported") fail("CapabilityUnavailable", unsupportedRuntimeMessage(version || "unknown"));
      await withTemporaryPluginSettings(inventory.ids, (settingsPath, rewrite) => convergePluginQuarantine(at, supervisor, model, effort,
        inventory, settingsPath, rewrite, options.signal, deadlineMs, { canary: true, expectedVersion: version }));
    } catch (error) {
      if (!(error instanceof ClaudeFailure) || ["Cancelled", "Timeout", "SpawnFailure"].includes(error.error.kind)) throw error;
      if (error.error.safeMessage.startsWith("Fusion has not verified")) throw error;
      fail("CapabilityUnavailable", unverifiedRuntimeMessage(options.expectedVersion ?? "this runtime",
        `its canary check failed: ${error.error.safeMessage}`), false, error.error.failureDetail);
    }
    const left = (await readdir(directory)).filter(name => HOOK_MARKERS.includes(name));
    if (left.length > 0)
      fail("CapabilityUnavailable", unverifiedRuntimeMessage(version, "its canary check failed: a project or local settings hook ran, " +
        "so Claude's settings quarantine does not hold on this runtime"));
    return Object.freeze({ version, method: "runtimeCanary" as const, checks: CANARY_CHECKS, observedAt: new Date().toISOString() });
  } finally {
    await removeOwnedTemporary(directory).catch(() => undefined);
  }
}
/** The attestation of a validated release: its flag semantics were recorded by live validation. */
export function recordedAttestation(version: string): ClaudePostureAttestation {
  return Object.freeze({ version, method: "recordedValidation" as const, checks: RECORDED_VALIDATION_CHECKS, observedAt: new Date().toISOString() });
}
