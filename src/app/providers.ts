import type { AgentRole, AuthLane, CapabilitySnapshot, ProviderAdapter, RoleBinding } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import type { RoleCandidate } from "../core/policy/routing.js";
import type { BindingConfig, FusionConfig } from "./config.js";

/**
 * Provider-neutral contract between the control plane and adapter modules. Everything provider-specific (option
 * validation, executable discovery, auth probes, adapter construction) lives behind an `AdapterFactory` registered
 * under an adapter kind; the control plane only ever sees these shapes.
 */
export interface ProviderRuntimeContext {
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
}
export type Availability = "available" | "unavailable" | "unknown";
export interface SecurityControl {
  readonly name: string;
  readonly state: Availability;
  readonly detail: string;
}
/** Static inspection: never starts the provider, never runs inference. */
export interface BindingInspection {
  readonly provider: string;
  readonly transport: string;
  readonly executable: Availability;
  readonly runtimeVersion: string;
  /**
   * Billing/provider-override guard, evaluated on environment key names only. `candidateLane` is the credential lane
   * the environment selects when clear: a static candidate, never proof of authentication (only a probe or a turn
   * observes that).
   */
  readonly billing: Readonly<{ state: "clear" | "blocked" | "unknown"; reasons: readonly string[]; candidateLane?: AuthLane }>;
  /** Capabilities knowable without starting the provider; absent when only a probe can tell. */
  readonly capabilities?: CapabilitySnapshot;
  /** Whether the adapter implements structured review/adjudication turns. */
  readonly structuredTurns: boolean;
  readonly controls: readonly SecurityControl[];
  readonly notes: readonly string[];
}
/** Opt-in probe (`fusion doctor --probe`): may start the provider CLI for auth readback; never runs inference. */
export interface BindingProbe {
  readonly auth: Readonly<{ state: "authenticated" | "unauthenticated" | "ambiguous" | "failed"; lane: string; detail: string }>;
  readonly capabilities?: CapabilitySnapshot;
}
export interface AdapterFactory {
  readonly kind: string;
  inspect(binding: BindingConfig, context: ProviderRuntimeContext): Promise<BindingInspection>;
  probe(binding: BindingConfig, context: ProviderRuntimeContext, signal?: AbortSignal): Promise<BindingProbe>;
  /** Builds a run adapter. Called only for read-only roles while real Writer mode is blocked. */
  create(binding: BindingConfig, context: ProviderRuntimeContext): Promise<Readonly<{ binding: RoleBinding; adapter: ProviderAdapter }>>;
}
export interface ProviderRegistry {
  readonly factories: ReadonlyMap<string, AdapterFactory>;
  /** Bindings used when the repository has no configuration file. */
  readonly defaults: FusionConfig;
}

export interface UnavailableBinding {
  readonly index: number;
  readonly role: AgentRole;
  readonly reason: string;
}
/**
 * Run candidates for the given roles, in configuration order. The Worker role is never instantiated: real Writer
 * mode is blocked, so a Worker binding is reported, not built. A binding whose adapter cannot be built is reported
 * as unavailable instead of failing the run; routing then fails closed if no eligible candidate remains.
 */
export async function buildCandidates(config: FusionConfig, registry: ProviderRegistry, context: ProviderRuntimeContext,
  roles: readonly AgentRole[]): Promise<Readonly<{ candidates: RoleCandidate[]; unavailable: UnavailableBinding[] }>> {
  const candidates: RoleCandidate[] = [], unavailable: UnavailableBinding[] = [];
  for (const [index, binding] of config.bindings.entries()) {
    if (!roles.includes(binding.role)) continue;
    if (binding.role === "Worker") { unavailable.push({ index, role: binding.role, reason: "REAL_WRITER_MODE_NOT_READY" }); continue; }
    const factory = registry.factories.get(binding.adapter);
    if (factory === undefined) { unavailable.push({ index, role: binding.role, reason: "unknown adapter kind" }); continue; }
    try { candidates.push(await factory.create(binding, context)); }
    catch (error) {
      unavailable.push({ index, role: binding.role,
        reason: error instanceof FusionFailure ? error.error.safeMessage : "the adapter could not be constructed" });
    }
  }
  return { candidates, unavailable };
}
