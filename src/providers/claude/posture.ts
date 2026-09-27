import type { CapabilityEvidenceSource, CapabilitySnapshot, CapabilityState } from "../../core/domain.js";
import { claudeReadOnlyArgs } from "./plugin-quarantine.js";
import type { ClaudePostureAttestation } from "./runtime-attestation.js";
import { CLAUDE_CHILD_SWITCHES, CLAUDE_SAFE_TOOLS, CLAUDE_VALIDATED_EXTENSION_VERSION } from "./types.js";

/** Flags that would widen a turn beyond the read-only review posture; any of them voids every launch-time fact. */
const WIDENING_FLAGS = new Set(["--mcp-config", "--add-dir", "--allowedTools", "--allowed-tools", "--agents",
  "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--plugin-dir", "--json-schema", "--bare",
  "--permission-prompt-tool"]);

export interface ClaudeLaunchPosture {
  readonly read: CapabilityState;
  readonly write: CapabilityState;
  readonly shell: CapabilityState;
  readonly webToolsDisabled: CapabilityState;
  readonly approvalEscalationDisabled: CapabilityState;
  readonly personalContextDisabled: CapabilityState;
  readonly extensionsQuarantined: CapabilityState;
}

/**
 * The posture a Claude process is launched into, derived from the exact argv and child environment Fusion passes. A
 * fact holds only when its control is present and the runtime is the version those controls were validated on;
 * otherwise it is unknown, never assumed. The mandatory pre-turn plugin quarantine and the init readback of tools,
 * permission mode, MCP servers, plugins, credential source and version then re-check it before every turn.
 */
export function claudeLaunchPosture(args: readonly string[], env: Readonly<Record<string, string | undefined>>,
  versionVerified: boolean): ClaudeLaunchPosture {
  const has = (flag: string): boolean => args.includes(flag);
  const value = (flag: string): string | undefined => { const at = args.indexOf(flag); return at < 0 ? undefined : args[at + 1]; };
  const valid = versionVerified && !args.some(arg => WIDENING_FLAGS.has(arg));
  const tools = value("--tools")?.split(",").map(tool => tool.trim()).sort();
  const exactTools = JSON.stringify(tools) === JSON.stringify([...CLAUDE_SAFE_TOOLS].sort());
  const holds = (control: boolean, fact: boolean): CapabilityState => valid && control ? fact : "unknown";
  return {
    read: holds(exactTools, true),
    write: holds(exactTools, false),
    // --restricted drops shell and web tools that --tools does not name; the exact allowlist names none.
    shell: holds(exactTools && has("--restricted"), false),
    webToolsDisabled: holds(exactTools && has("--restricted"), true),
    approvalEscalationDisabled: holds(value("--permission-mode") === "dontAsk" && value("--permission-prompts") === "none", true),
    // --safe-mode disables CLAUDE.md; --restricted ignores user, project and local settings; auto memory is switched off.
    personalContextDisabled: holds(has("--safe-mode") && has("--restricted") && env.CLAUDE_CODE_DISABLE_AUTO_MEMORY === "1", true),
    // --safe-mode disables skills, plugins, hooks and MCP; no MCP config is admitted; hook events are monitored.
    extensionsQuarantined: holds(has("--safe-mode") && has("--strict-mcp-config") && has("--disable-slash-commands") &&
      has("--include-hook-events"), true),
  };
}

/**
 * Claude one-shot capabilities. `none`: nothing established (unknown posture). `launchFlag`: the launch-time posture of
 * the exact controls every turn uses, on a runtime whose flags' meaning is known — the recorded validated release, or a
 * runtime this process attested (`attested`, same version). `runtimeReadback`: a session's init readback confirmed it.
 * Model identity and subscription lane are read back before every turn. Anything else stays unknown.
 */
export function claudeCapability(version = "unknown", evidence: "none" | CapabilityEvidenceSource = "none",
  usageReporting: CapabilityState = "unknown", attested?: ClaudePostureAttestation): CapabilitySnapshot {
  // The flags' meaning is known for the recorded release, or for a runtime THIS process attested for exactly this version.
  const known = version === CLAUDE_VALIDATED_EXTENSION_VERSION || (attested !== undefined && attested.version === version);
  const source = evidence !== "none" && known ? evidence : undefined;
  const posture = claudeLaunchPosture(claudeReadOnlyArgs("model", "effort", 1), CLAUDE_CHILD_SWITCHES, source !== undefined);
  const readback: CapabilityState = source !== undefined ? true : "unknown";
  return { provider: "claude", transport: "claude-one-shot", observedAt: new Date().toISOString(), runtimeVersion: version,
    persistentSessions: false, structuredOutput: readback, webToolsDisabled: posture.webToolsDisabled,
    // The web-tool provenance keeps its M-series meaning: readback is not a version-specific flag verification.
    ...(source === undefined ? {} : { webToolsDisabledEvidence: { source, versionVerified: source === "launchFlag" },
      postureEvidence: { source, versionVerified: true } }),
    filesystem: { read: posture.read, write: posture.write }, shell: { available: posture.shell, sandboxed: "unknown" },
    approvalEscalationDisabled: posture.approvalEscalationDisabled, personalContextDisabled: posture.personalContextDisabled,
    extensionsQuarantined: posture.extensionsQuarantined,
    // Fusion's own launch construction: every process of a bound session starts in its session workspace.
    workspaceBinding: true,
    approvalCallback: false, protocolCancellation: false, usageReporting,
    modelIdentityReadback: readback, subscriptionLaneReadback: readback };
}
