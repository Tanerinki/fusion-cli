import { randomBytes } from "node:crypto";
import { boundedHistory, conversationText, CONVERSATION_LIMITS, proposedBuildTask, type ConversationMessage,
  type ConversationPurpose } from "../core/conversation.js";
import type { AgentRole, ProviderAdapter, RoleBinding, Session } from "../core/domain.js";
import { FusionFailure } from "../core/errors.js";
import { ReadOnlyWorkspacePort } from "../platform/workflow/ports.js";
import { ProcessGitClient } from "../platform/workspace/git.js";
import { ProviderViewStore, type ProviderView } from "../platform/workspace/provider-views.js";
import type { CommandRequest, ControlPlane } from "./control-plane.js";
import { requireRepository } from "./context.js";
import { inventoryRepository, renderInventory, type RepositoryInventory } from "./repository-inventory.js";

/**
 * v0.1 — a READ-ONLY conversation with the configured providers about one repository (`fusion chat`, `fusion analyze`).
 *
 *  - Every provider session runs in a Fusion-owned view of the working tree (a copy without `.git`, `.fusion` and provider
 *    state; ignored files such as `.env` are never copied), under the provider's read-only launch posture.
 *  - Around every turn the primary checkout's fingerprint must be unchanged, and after it the view must still equal its
 *    identity; otherwise the conversation stops with a SecurityViolation. A conversation never mutates anything.
 *  - Replies are untrusted model text: shown to the human, kept only in the bounded in-memory history, never executed,
 *    never applied, never written into the repository's trusted run evidence.
 *  - Starting a build is never implicit: a reply can only PROPOSE a task, which the human must start explicitly.
 */
export interface ConversationPartnerInfo {
  /** Index of the binding in the configuration. */
  readonly index: number;
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  readonly available: boolean;
  readonly reason?: string;
}
export interface ConversationAnswer {
  readonly partner: Readonly<{ role: AgentRole; provider: string; model: string }>;
  readonly effectiveModel: string;
  readonly text: string;
  readonly truncated: boolean;
  /** A build task the reply proposed (untrusted; the human decides). */
  readonly proposedTask?: string;
}
interface Partner { readonly info: ConversationPartnerInfo; readonly adapter?: ProviderAdapter; readonly binding?: RoleBinding }

export const CHAT_INSTRUCTION = "You are the conversation partner inside Fusion, a command-line tool that coordinates several AI models to " +
  "analyze, build and review software in the user's repository. Talk with the user about their repository and what to build next. " +
  "Fusion's own facts about the repository are given below; read files in the current directory when you need details.";
export const CONSULTATION_INSTRUCTION = "You are asked for a second opinion inside Fusion, a command-line tool that coordinates several AI models. " +
  "Answer the user's question independently and concisely; point out where you disagree with the conversation so far.";

export class RepositoryConversation {
  readonly #partners: readonly Partner[];
  readonly #views: ProviderViewStore;
  readonly #primary: ReadOnlyWorkspacePort;
  readonly #sessions = new Map<number, Session>();
  readonly #history: ConversationMessage[] = [];
  readonly #owner = `chat-${randomBytes(6).toString("hex")}`;
  #view: ProviderView | undefined;
  #viewPrimary: string | undefined;
  #closed = false;

  private constructor(readonly root: string, readonly inventory: RepositoryInventory, partners: readonly Partner[], views: ProviderViewStore,
    primary: ReadOnlyWorkspacePort) {
    this.#partners = partners; this.#views = views; this.#primary = primary;
  }

  /** Resolves the repository, inventories it (read-only, no provider) and builds a read-only adapter per non-Worker binding. */
  static async open(plane: ControlPlane, request: CommandRequest & Readonly<{ deep?: boolean; focus?: string }> = {}): Promise<RepositoryConversation> {
    const runtime = await plane.runtime();
    const { root, git } = requireRepository(runtime);
    const loaded = await plane.config(runtime, request);
    const isolated = await ProcessGitClient.fromPath(plane.deps.env, true);
    const inventory = await inventoryRepository(root, isolated, { deep: request.deep === true,
      ...(request.focus === undefined ? {} : { focus: request.focus }), ...(request.signal ? { signal: request.signal } : {}) });
    const partners: Partner[] = [];
    const context = { ...plane.providerContext(root), sessionWorkspaces: "required" as const };
    for (const [index, binding] of loaded.config.bindings.entries()) {
      const base = { index, role: binding.role, provider: String(binding.options.provider ?? binding.adapter), model: binding.model };
      if (binding.role === "Worker") continue;
      const factory = plane.deps.registry.factories.get(binding.adapter);
      if (factory === undefined) { partners.push({ info: { ...base, available: false, reason: "unknown adapter kind" } }); continue; }
      try {
        const built = await factory.create(binding, context);
        const info = { ...base, provider: built.binding.provider };
        if (built.adapter.runConversationTurn === undefined) partners.push({ info: { ...info, available: false, reason: "this transport cannot hold a conversation" } });
        else partners.push({ info: { ...info, available: true }, adapter: built.adapter, binding: built.binding });
      } catch (error) {
        partners.push({ info: { ...base, available: false,
          reason: error instanceof FusionFailure ? error.error.safeMessage : "the adapter could not be constructed" } });
      }
    }
    const views = new ProviderViewStore({ primaryRoot: root, git: isolated, excludedPaths: plane.deps.registry.workspaceStatePaths ?? [] });
    const primary = new ReadOnlyWorkspacePort(root, git, loaded.config.protection ? { protectedPaths: loaded.config.protection.ignoredPaths } : {});
    return new RepositoryConversation(root, inventory, partners, views, primary);
  }

  get partners(): readonly ConversationPartnerInfo[] { return this.#partners.map(partner => partner.info); }
  get history(): readonly ConversationMessage[] { return [...this.#history]; }
  clearHistory(): void { this.#history.length = 0; }

  /** The partner a name selects: a role (`lead`, `reviewer`, …) or a provider id; the first available Lead by default. */
  partner(name?: string): Partner {
    const available = this.#partners.filter(partner => partner.info.available);
    if (available.length === 0)
      throw new FusionFailure({ kind: "CapabilityUnavailable", retryable: false,
        safeMessage: `No configured provider can hold a conversation (${this.#partners.map(p => `${p.info.role}: ${p.info.reason ?? "unavailable"}`).join("; ") || "no bindings"}).` });
    if (name === undefined) return available.find(partner => partner.info.role === "Lead") ?? available[0]!;
    const key = name.trim().toLowerCase();
    const match = available.find(partner => partner.info.role.toLowerCase() === key) ?? available.find(partner => partner.info.provider.toLowerCase() === key);
    if (match === undefined)
      throw new FusionFailure({ kind: "InvalidInput", retryable: false,
        safeMessage: `No available conversation partner is called "${name.slice(0, 40)}". Available: ${available.map(p => `${p.info.role.toLowerCase()} (${p.info.provider})`).join(", ")}.` });
    return match;
  }

  /**
   * One read-only turn. The primary checkout is fingerprinted before and after; the view is rebuilt when the primary
   * changed since it was built (so the provider reads the current work) and must equal its identity after the turn.
   */
  async ask(message: string, options: Readonly<{ partner?: string; purpose?: ConversationPurpose; instruction?: string; context?: string;
    remember?: boolean; signal?: AbortSignal }> = {}): Promise<ConversationAnswer> {
    if (this.#closed) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The conversation is closed." });
    const text = conversationText(message, CONVERSATION_LIMITS.maxMessageChars, "message");
    const partner = this.partner(options.partner);
    const before = await this.#primary.fingerprint(undefined, options.signal);
    const view = await this.#currentView(before, options.signal);
    const session = await this.#session(partner, view);
    const purpose = options.purpose ?? (options.partner !== undefined && partner.info.role !== "Lead" ? "consultation" : "chat");
    const result = await partner.adapter!.runConversationTurn!(session, { kind: "conversation", purpose,
      instruction: options.instruction ?? (purpose === "consultation" ? CONSULTATION_INSTRUCTION : CHAT_INSTRUCTION),
      context: (options.context ?? renderInventory(this.inventory, "summary")).slice(0, CONVERSATION_LIMITS.maxContextChars),
      history: boundedHistory(this.#history), message: text }, options.signal);
    // Read-only proof, whatever the provider reported: the view is unchanged and the primary is unchanged.
    if (await this.#views.fingerprint(view.viewId) !== view.identity) {
      await this.close();
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: "The provider changed its read-only view of the repository; the conversation was stopped." });
    }
    if (await this.#primary.fingerprint(undefined, options.signal) !== before) {
      await this.close();
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: "The repository changed during a read-only conversation turn; the conversation was stopped. Inspect the working tree." });
    }
    if (result.status !== "completed") throw new FusionFailure(result.error);
    if (options.remember !== false) this.#history.push({ role: "user", text }, { role: "assistant", text: result.output.text });
    const task = proposedBuildTask(result.output.text);
    return Object.freeze({ partner: { role: partner.info.role, provider: partner.info.provider, model: partner.info.model },
      effectiveModel: result.effectiveModel, text: result.output.text, truncated: result.output.truncated, ...(task ? { proposedTask: task } : {}) });
  }

  async #currentView(primaryFingerprint: string, signal?: AbortSignal): Promise<ProviderView> {
    if (this.#view !== undefined && this.#viewPrimary === primaryFingerprint) return this.#view;
    await this.#releaseView();
    this.#view = await this.#views.workingTree(this.#owner, signal);
    this.#viewPrimary = primaryFingerprint;
    return this.#view;
  }
  async #session(partner: Partner, view: ProviderView): Promise<Session> {
    const existing = this.#sessions.get(partner.info.index);
    if (existing !== undefined && existing.workspaceRoot === view.path) return existing;
    if (existing !== undefined) { await partner.adapter!.close(existing).catch(() => undefined); this.#sessions.delete(partner.info.index); }
    const binding = partner.binding!;
    const session = await partner.adapter!.createSession({ runId: this.#owner, role: binding.role, workspaceLeaseId: view.viewId, posture: "readOnly",
      model: binding.model, workspace: { id: view.viewId, root: view.path } });
    if (session.posture !== "readOnly" || session.workspaceRoot !== view.path)
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: "The provider session is not bound read-only to its view." });
    this.#sessions.set(partner.info.index, session);
    return session;
  }
  async #releaseView(): Promise<void> {
    for (const [index, session] of this.#sessions) {
      const partner = this.#partners.find(p => p.info.index === index);
      await partner?.adapter?.close(session).catch(() => undefined);
    }
    this.#sessions.clear();
    if (this.#view !== undefined) { await this.#views.release(this.#view.viewId).catch(() => undefined); this.#view = undefined; }
  }
  /** Closes every session and removes the view. Idempotent. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#releaseView();
  }
}
