import { join } from "node:path";
import { isContainedPath } from "../platform/events/shared.js";
import { defaultDeliveryStoreBase } from "../platform/delivery/state-root.js";
import type { CommandRequest, ControlPlane } from "./control-plane.js";
import { CONFIG_FILE } from "./config.js";

/**
 * v0.1 — `fusion config`: the EFFECTIVE configuration, read-only. Which provider and model each role uses, the default
 * conversation partner, the verifier profile (what confined verification supports here), and where Fusion keeps its run
 * evidence and delivery state. No option in any configuration disables a safety control; this report says so.
 */
export const ROLE_LABELS: Readonly<Record<string, string>> = Object.freeze({ Lead: "Lead (plans, adjudicates, chat)",
  Worker: "Change Author (proposes changes)", Reviewer: "Reviewer (fresh review)", Explorer: "Explorer (read-only answers)", Auditor: "Auditor" });
/** The verification platforms a confined backend exists for in this release. */
export const SUPPORTED_PLATFORMS = Object.freeze(["linux-compatible", "platform-neutral"] as const);
export const SAFETY_STATEMENT = "No setting, flag or variable disables a safety control: every Writer build needs your typed confirmation, " +
  "every delivery your typed manifest digest, and every apply its checkout binding, precheck and single-use claim. Fusion never commits, pushes or merges.";

export interface ConfigReport {
  readonly source: "file" | "defaults";
  readonly path?: string;
  readonly repository?: string;
  readonly roles: readonly Readonly<{ role: string; label: string; adapter: string; model: string; effort: string; maxTurns?: number; provider?: string }>[];
  readonly conversationPartner: Readonly<{ configured?: string; effective: string }>;
  readonly verification: Readonly<{ platformRequirement: string; dependencies: string; confinedCommands: readonly string[]; readOnlyCommands: readonly string[];
    writerBuilds: "supported" | "unsupported"; reason?: string }>;
  readonly runEvidence?: string;
  readonly deliveryStore: Readonly<{ base?: string; outsideRepository: boolean; error?: string }>;
  readonly safety: string;
}

const commandText = (command: Readonly<{ id: string; executable: string; args: readonly string[] }>): string =>
  `${command.id}: ${[command.executable, ...command.args].join(" ")}`;

export async function configReport(plane: ControlPlane, request: CommandRequest = {}): Promise<ConfigReport> {
  const runtime = await plane.runtime();
  const loaded = await plane.config(runtime, request);
  const root = runtime.repository.detected ? runtime.repository.root : undefined;
  const config = loaded.config, verification = config.verification;
  const platform = String(verification.platformRequirement ?? "unknown");
  const confined = verification.confinedCommands ?? [];
  const reason = confined.length === 0 ? "no verification.confinedCommands: a Writer build is refused before any model turn"
    : !(SUPPORTED_PLATFORMS as readonly string[]).includes(platform)
    ? `platform ${platform} has no confined backend in this release (supported: ${SUPPORTED_PLATFORMS.join(", ")})` : undefined;
  let deliveryStore: ConfigReport["deliveryStore"];
  try {
    const base = plane.deps.deliveryStoreRoot ?? defaultDeliveryStoreBase(plane.deps.env);
    deliveryStore = { base, outsideRepository: root === undefined || !(isContainedPath(root, base) || isContainedPath(base, root)) };
  } catch (error) {
    deliveryStore = { outsideRepository: true, error: error instanceof Error ? error.message.slice(0, 200) : "unavailable" };
  }
  const lead = config.bindings.find(binding => binding.role === "Lead");
  return Object.freeze({ source: loaded.source, ...(loaded.path === undefined ? {} : { path: loaded.path }), ...(root === undefined ? {} : { repository: root }),
    roles: config.bindings.map(binding => ({ role: binding.role, label: ROLE_LABELS[binding.role] ?? binding.role, adapter: binding.adapter,
      model: binding.model, effort: binding.effort, ...(binding.maxTurns === undefined ? {} : { maxTurns: binding.maxTurns }),
      ...(typeof binding.options.provider === "string" ? { provider: binding.options.provider } : {}) })),
    conversationPartner: { ...(config.conversation ? { configured: config.conversation.partner } : {}),
      effective: config.conversation?.partner ?? (lead ? "lead" : "the first available partner") },
    verification: { platformRequirement: platform, dependencies: verification.dependencies ?? "none", confinedCommands: confined.map(commandText),
      readOnlyCommands: verification.commands.map(commandText), writerBuilds: reason === undefined ? "supported" as const : "unsupported" as const,
      ...(reason === undefined ? {} : { reason }) },
    ...(root === undefined ? {} : { runEvidence: join(root, ".fusion", "runs") }), deliveryStore, safety: SAFETY_STATEMENT });
}

/** Where `fusion config` looks for the project file. */
export const CONFIG_LOOKUP = `${CONFIG_FILE} at the repository root, or --config <file>`;
