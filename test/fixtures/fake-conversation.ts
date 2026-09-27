import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { AdapterFactory, ProviderRegistry } from "../../src/app/providers.js";
import type { ConversationTurnRequest } from "../../src/core/conversation.js";
import type { ConversationTurnResult, ProviderAdapter, RoleBinding, Session } from "../../src/core/domain.js";
import { FusionFailure } from "../../src/core/errors.js";

/**
 * v0.2 — a fake provider registry for conversation turns: one adapter kind per role (lead, explorer, reviewer), scripted
 * replies, and a record of every turn with what its provider could READ — the prompt parts and the full content of its
 * view — so tests can prove what reached a provider and what never did. No process is started.
 */
export type FakeRole = "Lead" | "Explorer" | "Reviewer";
export type FakeReply = string | ((request: ConversationTurnRequest, turn: Readonly<{ role: FakeRole; signal?: AbortSignal }>) => string | Promise<string>);
export interface FakeTurn {
  readonly role: FakeRole;
  readonly request: ConversationTurnRequest;
  readonly workspace: string;
  /** Every file of the view at the time of the turn, relative, `/`-separated. */
  readonly viewFiles: readonly string[];
  /** All view file contents concatenated (what the provider could read). */
  readonly viewText: string;
}
export interface FakeOptions {
  readonly replies?: Partial<Record<FakeRole, FakeReply[]>>;
  /** Roles whose adapter cannot be built (the partner is then unavailable). */
  readonly unavailable?: readonly FakeRole[];
  /** Leave out the explorer binding. */
  readonly withoutExplorer?: boolean;
  /** Called during a turn (after recording), before the reply: may abort, or write somewhere to test the read-only proofs. */
  readonly during?: (turn: FakeTurn, signal?: AbortSignal) => Promise<void>;
}
const DISPLAY: Readonly<Record<FakeRole, string>> = { Lead: "Alpha", Explorer: "Beta", Reviewer: "Beta" };
const PROVIDER: Readonly<Record<FakeRole, string>> = { Lead: "alpha", Explorer: "beta", Reviewer: "beta" };

async function snapshot(root: string): Promise<{ files: string[]; text: string }> {
  const files: string[] = [];
  let text = "";
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    files.push(relative(root, path).split(sep).join("/"));
    text += `\n${await readFile(path, "utf8")}`;
  }
  return { files: files.sort(), text };
}

export function fakeConversationRegistry(options: FakeOptions = {}): { registry: ProviderRegistry; turns: FakeTurn[] } {
  const turns: FakeTurn[] = [];
  const counters = new Map<FakeRole, number>();
  const factory = (role: FakeRole): AdapterFactory => ({ kind: `fake-${role.toLowerCase()}`, displayName: DISPLAY[role],
    inspect: async () => { throw new Error("not used"); }, probe: async () => { throw new Error("not used"); },
    create: async binding => {
      if (options.unavailable?.includes(role))
        throw new FusionFailure({ kind: "CapabilityUnavailable", retryable: false, safeMessage: `the ${role.toLowerCase()} provider is not installed` });
      const provider = PROVIDER[role];
      const roleBinding: RoleBinding = { role: binding.role, provider, transport: `fake-${role.toLowerCase()}`, model: { id: binding.model, effort: binding.effort }, requires: {} };
      const adapter: ProviderAdapter = {
        capabilities: async () => { throw new Error("not used"); }, authStatus: async () => { throw new Error("not used"); },
        createSession: async request => ({ id: `s-${Math.random()}`, runId: request.runId, role: request.role, provider, transport: roleBinding.transport,
          workspaceLeaseId: request.workspaceLeaseId, posture: request.posture, providerSessionRef: "x",
          ...(request.workspace ? { workspaceRoot: request.workspace.root } : {}) }),
        resumeSession: async session => session, runTurn: async () => { throw new Error("not used"); },
        runConversationTurn: async (session: Session, request: ConversationTurnRequest, signal?: AbortSignal): Promise<ConversationTurnResult> => {
          const view = await snapshot(session.workspaceRoot!);
          const turn: FakeTurn = { role, request, workspace: session.workspaceRoot!, viewFiles: view.files, viewText: view.text };
          turns.push(turn);
          await options.during?.(turn, signal);
          if (signal?.aborted) return { status: "failed", effectiveProvider: provider, effectiveModel: binding.model, artifactRefs: [],
            error: { kind: "Cancelled", safeMessage: "The turn was cancelled.", retryable: false } };
          const n = counters.get(role) ?? 0;
          counters.set(role, n + 1);
          const scripted = options.replies?.[role]?.[n];
          const text = typeof scripted === "function" ? await scripted(request, { role, ...(signal ? { signal } : {}) }) : scripted ?? `${role} reply ${n + 1}`;
          return { status: "completed", effectiveProvider: provider, effectiveModel: `${binding.model}-effective`, artifactRefs: [], output: { text, truncated: false } };
        },
        cancel: async () => undefined, usage: async () => null, close: async () => undefined };
      return { binding: roleBinding, adapter };
    } });
  const roles: FakeRole[] = options.withoutExplorer === true ? ["Lead", "Reviewer"] : ["Lead", "Explorer", "Reviewer"];
  return { turns, registry: { factories: new Map(roles.map(role => [`fake-${role.toLowerCase()}`, factory(role)])),
    defaults: { schemaVersion: 1, bindings: [
      ...roles.map(role => ({ role, adapter: `fake-${role.toLowerCase()}`, model: `m-${role.toLowerCase()}`, effort: role === "Lead" ? "high" as const : "low" as const, options: {} })),
      { role: "Worker", adapter: "fake-lead", model: "m-write", effort: "low", options: {} }],
      verification: { commands: [] },
      limits: { runTimeoutMs: 60_000 } } } };
}
