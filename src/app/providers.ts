import type { AgentRole, AuthLane, CapabilitySnapshot, ProviderAdapter, RoleBinding } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import type { RoleCandidate } from "../core/policy/routing.js";
import type { LaunchObserver } from "../platform/process/supervisor.js";
import type { BindingConfig, FusionConfig } from "./config.js";

/**
 * Provider-neutral contract between the control plane and adapter modules. Everything provider-specific (option
 * validation, executable discovery, auth probes, adapter construction) lives behind an `AdapterFactory` registered
 * under an adapter kind; the control plane only ever sees these shapes.
 */
export interface ProviderRuntimeContext {
  /** The user's primary checkout: a default for probes, and a root no session workspace may overlap. */
  readonly workspace: string;
  readonly env: NodeJS.ProcessEnv;
  /**
   * `required`: every session of an adapter built for this context must run in a Fusion-owned session workspace (a
   * provider view); a session without one is refused, never started in `workspace`.
   */
  readonly sessionWorkspaces?: "required";
  /**
   * Observes every provider process an adapter built for this context starts (argv, working directory, environment key
   * names; never stdin or values). Evidence only: it changes no launch.
   */
  readonly launchObserver?: LaunchObserver;
  /**
   * O5.5B23: the one runtime release an AUTHORIZED VALIDATION PROBE runs under validation (its transport and exact
   * version). Only that probe sets it — never configuration, never a command. A factory that supports it launches that
   * release with exactly its verified release's controls and reports those controls' facts as claimed but unverified;
   * validated-version data is never changed by it. Absent: the release is judged exactly as always.
   */
  readonly runtimeUnderValidation?: Readonly<{ transport: string; version: string }>;
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
   * O5.5B23: the absolute path of the executable the binding resolves to right now (when available), so an authorized
   * probe can pin its exact identity. Inspection only reads it; it never starts it.
   */
  readonly executablePath?: string;
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
  /**
   * The recorded authorized live change-proposal probe of this transport for exactly the installed version (static data;
   * absent when none covers it). Evidence for diagnostics only: it opens no gate.
   */
  readonly liveChangeProposal?: Readonly<{ milestone: string; runtimeVersion: string; model: string; effort: string; outcome: string; probedAt: string;
    document: string }>;
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
  /** v0.2: the product name people know this provider by, for friendly status lines (never used for policy). */
  readonly displayName?: string;
  inspect(binding: BindingConfig, context: ProviderRuntimeContext): Promise<BindingInspection>;
  probe(binding: BindingConfig, context: ProviderRuntimeContext, signal?: AbortSignal): Promise<BindingProbe>;
  /** Builds a run adapter for a read-only role. A Worker binding is always refused here. */
  create(binding: BindingConfig, context: ProviderRuntimeContext): Promise<Readonly<{ binding: RoleBinding; adapter: ProviderAdapter }>>;
  /**
   * Builds a Worker binding as a READ-ONLY Change Author: the same read-only launch posture as a Reviewer, the
   * structured change-proposal turn, and sessions only ever in a Fusion-owned view. Only the production Writer
   * composition calls it, and only behind the live Writer gate for any actual run. Absent: the adapter kind cannot
   * serve as a Change Author.
   */
  createChangeAuthor?(binding: BindingConfig, context: ProviderRuntimeContext): Promise<Readonly<{ binding: RoleBinding; adapter: ProviderAdapter }>>;
}
export interface ProviderRegistry {
  readonly factories: ReadonlyMap<string, AdapterFactory>;
  /** Bindings used when the repository has no configuration file. */
  readonly defaults: FusionConfig;
  /** Top-level provider state/configuration names never copied into a provider view (from the provider profiles). */
  readonly workspaceStatePaths?: readonly string[];
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

/**
 * Run candidates for the Writer workflow: read-only roles through `create`, the Worker through `createChangeAuthor`
 * (read-only Change Author). Every adapter is built for `sessionWorkspaces: "required"`. Building candidates grants
 * nothing: an actual Writer run is still refused by the live Writer gate before this is ever reached.
 */
export async function buildWriterCandidates(config: FusionConfig, registry: ProviderRegistry, context: ProviderRuntimeContext,
  roles: readonly AgentRole[]): Promise<Readonly<{ candidates: RoleCandidate[]; unavailable: UnavailableBinding[] }>> {
  const bound: ProviderRuntimeContext = { ...context, sessionWorkspaces: "required" };
  const candidates: RoleCandidate[] = [], unavailable: UnavailableBinding[] = [];
  for (const [index, binding] of config.bindings.entries()) {
    if (!roles.includes(binding.role)) continue;
    const factory = registry.factories.get(binding.adapter);
    if (factory === undefined) { unavailable.push({ index, role: binding.role, reason: "unknown adapter kind" }); continue; }
    if (binding.role === "Worker" && factory.createChangeAuthor === undefined) {
      unavailable.push({ index, role: binding.role, reason: "the adapter kind cannot serve as a read-only Change Author" }); continue;
    }
    try { candidates.push(binding.role === "Worker" ? await factory.createChangeAuthor!(binding, bound) : await factory.create(binding, bound)); }
    catch (error) {
      unavailable.push({ index, role: binding.role,
        reason: error instanceof FusionFailure ? error.error.safeMessage : "the adapter could not be constructed" });
    }
  }
  return { candidates, unavailable };
}
