import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { boundedHistory, conversationText, CONVERSATION_LIMITS, proposedBuildTask, type ConversationMessage,
  type ConversationPurpose } from "../core/conversation.js";
import { meetsCapabilities } from "../core/capabilities.js";
import type { AgentRole, CapabilityRequirement, ProviderAdapter, RoleBinding, Session } from "../core/domain.js";
import { postureRequirement, REVIEW_ISOLATION } from "../core/policy/routing.js";
import { FusionFailure } from "../core/errors.js";
import { ReadOnlyWorkspacePort } from "../platform/workflow/ports.js";
import { folderFingerprint, listFolder } from "../platform/workspace/folder-source.js";
import { ProcessGitClient } from "../platform/workspace/git.js";
import { ProviderViewStore, type ProviderView, type ViewExposure } from "../platform/workspace/provider-views.js";
import { prepareProviderInput } from "../platform/workspace/sensitive-input.js";
import type { CommandRequest, ControlPlane } from "./control-plane.js";
import { requireRepository } from "./context.js";
import { inventoryFolder, inventoryRepository, renderInventory, type RepositoryInventory } from "./repository-inventory.js";

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
 *
 * v0.2: the source may also be an ORDINARY FOLDER (no Git), when the caller allows it: the view is a copy of the folder's
 * listed files and the folder's own fingerprint (paths, sizes, modification times) must be unchanged around every turn. In
 * both cases every view passes the sensitive-input policy (`sensitive-input.ts`): credentials and authentication stores are
 * withheld, secret values redacted, before the provider can read anything.
 */
export interface ConversationPartnerInfo {
  /** Index of the binding in the configuration. */
  readonly index: number;
  readonly role: AgentRole;
  readonly provider: string;
  readonly model: string;
  /** v0.2: the provider's product name for status lines (the provider id when the factory names none). */
  readonly displayName: string;
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
/** How the primary source is observed: a fingerprint that must not change during a read-only turn, and its current view. */
interface PrimarySource {
  readonly kind: "git" | "folder";
  fingerprint(signal?: AbortSignal): Promise<string>;
  view(views: ProviderViewStore, owner: string, signal?: AbortSignal): Promise<ProviderView>;
}

/**
 * v0.2.3: what a partner must PROVE (its adapter's own capability evidence) before Fusion hands it exploration work: the
 * read-only posture a fresh reviewer needs, and no shell. The same requirement routing applies to a review.
 */
const READ_ONLY_PARTNER: CapabilityRequirement = Object.freeze({ ...postureRequirement("readOnly"), ...REVIEW_ISOLATION,
  shell: Object.freeze({ available: false }), webToolsDisabled: true });

export const CHAT_INSTRUCTION = "You are the conversation partner inside Fusion, a command-line tool that coordinates several AI models to " +
  "analyze, build and review software in the user's repository. Talk with the user about their repository and what to build next. " +
  "Fusion's own facts about the repository are given below; read files in the current directory when you need details.";
export const CONSULTATION_INSTRUCTION = "You are asked for a second opinion inside Fusion, a command-line tool that coordinates several AI models. " +
  "Answer the user's question independently and concisely; point out where you disagree with the conversation so far.";

export class RepositoryConversation {
  readonly #partners: readonly Partner[];
  readonly #views: ProviderViewStore;
  readonly #primary: PrimarySource;
  readonly #sessions = new Map<number, Session>();
  readonly #history: ConversationMessage[] = [];
  readonly #owner = `chat-${randomBytes(6).toString("hex")}`;
  #view: ProviderView | undefined;
  #viewPrimary: string | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  /** v0.3: serializes building, rebuilding and copying the shared view (concurrent turns never race on it). */
  #viewLock: Promise<void> = Promise.resolve();
  /** v0.3: investigations in flight (each with its own replica and session), aborted and awaited by `close`. */
  readonly #investigations = new Set<Readonly<{ abort: AbortController; settled: Promise<void> }>>();
  #replicas = 0;
  /** The configured default partner (`conversation.partner`), when the configuration names one. */
  readonly defaultPartner: string | undefined;

  private constructor(readonly root: string, readonly inventory: RepositoryInventory, partners: readonly Partner[], views: ProviderViewStore,
    primary: PrimarySource, defaultPartner: string | undefined) {
    this.#partners = partners; this.#views = views; this.#primary = primary; this.defaultPartner = defaultPartner;
  }
  /** v0.2: a Git repository or an ordinary folder. */
  get source(): "git" | "folder" { return this.#primary.kind; }
  /** v0.2: what the current view shares, redacts and withholds (after the first turn built it). */
  get exposure(): ViewExposure | undefined { return this.#view?.exposure; }

  /**
   * Resolves the repository (or, with `allowFolder`, an ordinary folder), inventories it (read-only, no provider) and builds a
   * read-only adapter per non-Worker binding.
   */
  static async open(plane: ControlPlane, request: CommandRequest & Readonly<{ deep?: boolean; focus?: string; allowFolder?: boolean }> = {}):
    Promise<RepositoryConversation> {
    const runtime = await plane.runtime();
    const folderMode = !runtime.repository.detected && request.allowFolder === true;
    const { root, git } = folderMode ? { root: await realpath(resolve(plane.deps.cwd)), git: undefined } : requireRepository(runtime);
    const loaded = await plane.config(runtime, request);
    const isolated = await ProcessGitClient.fromPath(plane.deps.env, true);
    const inventoryOptions = { deep: request.deep === true, ...(request.focus === undefined ? {} : { focus: request.focus }),
      ...(request.signal ? { signal: request.signal } : {}) };
    const inventory = folderMode ? await inventoryFolder(root, await listFolder(root, request.signal), inventoryOptions)
      : await inventoryRepository(root, isolated, inventoryOptions);
    const partners: Partner[] = [];
    const context = { ...plane.providerContext(root), sessionWorkspaces: "required" as const };
    for (const [index, binding] of loaded.config.bindings.entries()) {
      if (binding.role === "Worker") continue;
      const factory = plane.deps.registry.factories.get(binding.adapter);
      const provider = String(binding.options.provider ?? binding.adapter);
      const base = { index, role: binding.role, provider, model: binding.model, displayName: factory?.displayName ?? provider };
      if (factory === undefined) { partners.push({ info: { ...base, available: false, reason: "unknown adapter kind" } }); continue; }
      try {
        const built = await factory.create(binding, context);
        const info = { ...base, provider: built.binding.provider, displayName: factory.displayName ?? built.binding.provider };
        if (built.adapter.runConversationTurn === undefined) partners.push({ info: { ...info, available: false, reason: "this transport cannot hold a conversation" } });
        else partners.push({ info: { ...info, available: true }, adapter: built.adapter, binding: built.binding });
      } catch (error) {
        partners.push({ info: { ...base, available: false,
          reason: error instanceof FusionFailure ? error.error.safeMessage : "the adapter could not be constructed" } });
      }
    }
    const views = new ProviderViewStore({ primaryRoot: root, git: isolated, excludedPaths: plane.deps.registry.workspaceStatePaths ?? [] });
    let primary: PrimarySource;
    if (git === undefined) {
      primary = { kind: "folder", fingerprint: signal => folderFingerprint(root, signal),
        view: async (store, owner, signal) => store.folder(owner, (await listFolder(root, signal)).entries.map(entry => entry.path), prepareProviderInput, signal) };
    } else {
      const port = new ReadOnlyWorkspacePort(root, git, loaded.config.protection ? { protectedPaths: loaded.config.protection.ignoredPaths } : {});
      primary = { kind: "git", fingerprint: signal => port.fingerprint(undefined, signal),
        view: (store, owner, signal) => store.workingTree(owner, signal, prepareProviderInput) };
    }
    return new RepositoryConversation(root, inventory, partners, views, primary, loaded.config.conversation?.partner);
  }

  get partners(): readonly ConversationPartnerInfo[] { return this.#partners.map(partner => partner.info); }
  /**
   * v0.2.3: whether the available partner with this role proves its read-only posture NOW (its adapter's capability
   * evidence; an unknown fact never counts). Exploration only hands work to such a partner.
   */
  async postureProven(role: string): Promise<boolean> {
    const partner = this.#partners.find(p => p.info.available && p.info.role.toLowerCase() === role.toLowerCase());
    if (partner?.adapter === undefined) return false;
    try { return meetsCapabilities(await partner.adapter.capabilities(), READ_ONLY_PARTNER); } catch { return false; }
  }
  get history(): readonly ConversationMessage[] { return [...this.#history]; }
  clearHistory(): void { this.#history.length = 0; }

  /**
   * The partner a name selects: a role (`lead`, `reviewer`, …) or a provider id; without a name the configured
   * `conversation.partner`, else the first available Lead.
   */
  partner(requested?: string): Partner {
    const name = requested ?? this.defaultPartner;
    const available = this.#partners.filter(partner => partner.info.available);
    if (available.length === 0)
      throw new FusionFailure({ kind: "CapabilityUnavailable", retryable: false,
        safeMessage: `No configured provider can hold a conversation (${this.#partners.map(p => `${p.info.role}: ${p.info.reason ?? "unavailable"}`).join("; ") || "no bindings"}).` });
    if (name === undefined) return available.find(partner => partner.info.role === "Lead") ?? available[0]!;
    const key = name.trim().toLowerCase();
    const match = available.find(partner => partner.info.role.toLowerCase() === key) ?? available.find(partner => partner.info.provider.toLowerCase() === key);
    if (match === undefined)
      throw new FusionFailure({ kind: "InvalidInput", retryable: false,
        safeMessage: `No available conversation partner is called "${name.slice(0, 40)}"${requested === undefined ? " (conversation.partner in fusion.config.json)" : ""}. Available: ${available.map(p => `${p.info.role.toLowerCase()} (${p.info.provider})`).join(", ")}.` });
    return match;
  }

  /**
   * One read-only turn. The primary checkout is fingerprinted before and after; the view is rebuilt when the primary
   * changed since it was built (so the provider reads the current work) and must equal its identity after the turn.
   */
  async ask(message: string, options: Readonly<{ partner?: string; purpose?: ConversationPurpose; instruction?: string; context?: string;
    remember?: boolean; isolated?: boolean; signal?: AbortSignal }> = {}): Promise<ConversationAnswer> {
    if (this.#closed) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The conversation is closed." });
    const text = conversationText(message, CONVERSATION_LIMITS.maxMessageChars, "message");
    const partner = this.partner(options.partner);
    const before = await this.#primary.fingerprint(options.signal);
    const view = await this.#locked(() => this.#currentView(before, options.signal));
    const session = await this.#session(partner, view);
    const purpose = options.purpose ?? (options.partner !== undefined && partner.info.role !== "Lead" ? "consultation" : "chat");
    const result = await partner.adapter!.runConversationTurn!(session, { kind: "conversation", purpose,
      instruction: options.instruction ?? (purpose === "consultation" ? CONSULTATION_INSTRUCTION : CHAT_INSTRUCTION),
      context: (options.context ?? renderInventory(this.inventory, "summary")).slice(0, CONVERSATION_LIMITS.maxContextChars),
      // v0.2: an isolated turn (an Explorer packet, a fresh critique) sees no transcript, only what Fusion hands it.
      history: options.isolated === true ? [] : boundedHistory(this.#history), message: text }, options.signal);
    // Read-only proof, whatever the provider reported: the view is unchanged and the primary is unchanged.
    if (await this.#views.fingerprint(view.viewId) !== view.identity) {
      await this.close();
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: "The provider changed its read-only view of the repository; the conversation was stopped." });
    }
    if (await this.#primary.fingerprint(options.signal) !== before) {
      await this.close();
      throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
        safeMessage: this.#primary.kind === "folder"
          ? "The folder changed during a read-only conversation turn; the conversation was stopped. Check the folder."
          : "The repository changed during a read-only conversation turn; the conversation was stopped. Inspect the working tree." });
    }
    if (result.status !== "completed") throw new FusionFailure(result.error);
    if (options.remember !== false) this.#history.push({ role: "user", text }, { role: "assistant", text: result.output.text });
    const task = proposedBuildTask(result.output.text);
    return Object.freeze({ partner: { role: partner.info.role, provider: partner.info.provider, model: partner.info.model },
      effectiveModel: result.effectiveModel, text: result.output.text, truncated: result.output.truncated, ...(task ? { proposedTask: task } : {}) });
  }

  /**
   * v0.3 — ONE ISOLATED INVESTIGATION TURN, safe to run in parallel with others: a fresh REPLICA of the current view and a
   * fresh SESSION of the partner, both owned by this turn alone and torn down when it settles (the session first, so its
   * process has ended before its workspace is removed). No history, no other turn's session or workspace. Exactly as for
   * `ask`, the replica must still equal its identity after the turn and the primary must be unchanged; otherwise the
   * conversation is closed and the turn fails with a SecurityViolation. `close()` aborts every running investigation and
   * waits for it to settle before the conversation's own views are removed.
   */
  async investigate(message: string, options: Readonly<{ partner: string; instruction: string; context: string; purpose?: ConversationPurpose;
    signal?: AbortSignal }>): Promise<ConversationAnswer> {
    if (this.#closed) throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "The conversation is closed." });
    const text = conversationText(message, CONVERSATION_LIMITS.maxMessageChars, "message");
    const partner = this.partner(options.partner);
    const abort = new AbortController();
    const relay = (): void => abort.abort();
    options.signal?.addEventListener("abort", relay, { once: true });
    if (options.signal?.aborted) abort.abort();
    let settle!: () => void;
    const entry = Object.freeze({ abort, settled: new Promise<void>(resolve => { settle = resolve; }) });
    this.#investigations.add(entry);
    let replica: ProviderView | undefined, session: Session | undefined;
    try {
      const before = await this.#primary.fingerprint(abort.signal);
      replica = await this.#locked(async () => this.#views.replica(`${this.#owner}-i${++this.#replicas}`,
        (await this.#currentView(before, abort.signal)).viewId, abort.signal));
      const binding = partner.binding!;
      session = await partner.adapter!.createSession({ runId: this.#owner, role: binding.role, workspaceLeaseId: replica.viewId, posture: "readOnly",
        model: binding.model, workspace: { id: replica.viewId, root: replica.path } });
      if (session.posture !== "readOnly" || session.workspaceRoot !== replica.path)
        throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: "The provider session is not bound read-only to its view." });
      const result = await partner.adapter!.runConversationTurn!(session, { kind: "conversation", purpose: options.purpose ?? "investigation",
        instruction: options.instruction, context: options.context.slice(0, CONVERSATION_LIMITS.maxContextChars), history: [], message: text }, abort.signal);
      if (await this.#views.fingerprint(replica.viewId) !== replica.identity) {
        void this.close();
        throw new FusionFailure({ kind: "SecurityViolation", retryable: false,
          safeMessage: "The provider changed its read-only view of the repository; the conversation was stopped." });
      }
      if (await this.#primary.fingerprint(abort.signal) !== before) {
        void this.close();
        throw new FusionFailure({ kind: "SecurityViolation", retryable: false, safeMessage: this.#primary.kind === "folder"
          ? "The folder changed during a read-only conversation turn; the conversation was stopped. Check the folder."
          : "The repository changed during a read-only conversation turn; the conversation was stopped. Inspect the working tree." });
      }
      if (result.status !== "completed") throw new FusionFailure(result.error);
      // A reply that arrives after the turn was stopped (its time budget, the user, a sibling's security stop) is discarded.
      if (abort.signal.aborted) throw new FusionFailure({ kind: "Cancelled", retryable: false, safeMessage: "The investigation was stopped." });
      return Object.freeze({ partner: { role: partner.info.role, provider: partner.info.provider, model: partner.info.model },
        effectiveModel: result.effectiveModel, text: result.output.text, truncated: result.output.truncated });
    } finally {
      options.signal?.removeEventListener("abort", relay);
      if (session !== undefined) await partner.adapter!.close(session).catch(() => undefined);
      if (replica !== undefined) await this.#views.release(replica.viewId).catch(() => undefined);
      this.#investigations.delete(entry);
      settle();
    }
  }
  /** v0.3: views (and their replicas) that exist right now — for teardown checks. */
  get liveViews(): number { return this.#views.live().length; }

  /**
   * v0.2: which of these relative paths the providers could read in the current view (regular files only; anything with
   * `..`, an absolute path or a link is never counted). Used for the coverage summary: a path a reply cites is evidence
   * only when it was actually shared.
   */
  async sharedFiles(paths: readonly string[]): Promise<string[]> {
    const view = this.#view;
    if (view === undefined) return [];
    const shared: string[] = [];
    for (const path of new Set(paths)) {
      const segments = path.split("/");
      if (path.length === 0 || path.length > 512 || /^[\\/]|^[A-Za-z]:|\\/u.test(path) || segments.some(s => s === "" || s === "." || s === "..")) continue;
      const info = await lstat(join(view.path, ...segments)).catch(() => undefined);
      if (info?.isFile() === true) shared.push(path);
    }
    return shared.sort();
  }

  async #currentView(primaryFingerprint: string, signal?: AbortSignal): Promise<ProviderView> {
    if (this.#view !== undefined && this.#viewPrimary === primaryFingerprint) return this.#view;
    await this.#releaseView();
    this.#view = await this.#primary.view(this.#views, this.#owner, signal);
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
    if (this.#closed) { await this.#closing; return; }
    this.#closed = true;
    this.#closing = (async () => {
      // v0.3: every investigation still running is aborted, and its own cleanup (session, then replica) awaited.
      for (const running of this.#investigations) running.abort.abort();
      await Promise.race([Promise.allSettled([...this.#investigations].map(running => running.settled)),
        new Promise<void>(resolve => setTimeout(resolve, 60_000).unref())]);
      await this.#locked(() => this.#releaseView());
    })();
    await this.#closing;
  }
  /** Runs `work` alone on the shared view. */
  async #locked<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.#viewLock;
    let release!: () => void;
    this.#viewLock = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}
