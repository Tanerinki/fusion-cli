import { FusionFailure } from "../core/errors.js";
import { ProcessGitClient } from "../platform/workspace/git.js";
import type { CommandRequest, ControlPlane } from "./control-plane.js";
import { requireRepository } from "./context.js";
import { RepositoryConversation, type ConversationAnswer } from "./conversation.js";
import { inventoryRepository, renderInventory, type RepositoryInventory } from "./repository-inventory.js";

/**
 * v0.1 — `fusion analyze [path] [--deep] [--focus <topic>]`: a serious, read-only repository analysis.
 *
 *   1. Fusion's own deterministic inventory (no provider): stack, package managers, manifests and scripts, entrypoints,
 *      tests, CI, containers, configuration, Git state and history, the largest files, focus matches.
 *   2. One read-only analysis turn by the configured conversation partner (the Lead by default) in a Fusion-owned view,
 *      given that inventory as context: it inspects the prioritized paths and traces the important flows itself.
 *
 * `--deep` raises the inventory bounds and asks for a deeper trace — never more rights. `--inventory-only` stops after
 * step 1 (no provider at all). Nothing is written anywhere; the model's analysis is untrusted text, shown, not stored.
 */
export interface AnalyzeOptions extends CommandRequest {
  readonly deep: boolean;
  readonly focus?: string;
  readonly inventoryOnly: boolean;
  /** A role or provider id; the Lead by default. */
  readonly partner?: string;
}
export interface AnalyzeReport {
  readonly inventory: RepositoryInventory;
  readonly analysis: ConversationAnswer | null;
}
const FOCUS = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/u;

export const ANALYSIS_INSTRUCTION = "You are Fusion's repository analyst. Produce a serious, evidence-based analysis of the repository in the " +
  "current directory. Start from Fusion's inventory below, then prioritize: inspect the entrypoints, the most important modules and the " +
  "focus paths, and trace the main request and data flows where practical. Do not read every file. Structure your answer with these " +
  "headings: Overview; Stack and tooling; Entry points and modules; Architecture and data flow; Tests and CI; Hotspots and risks; " +
  "Missing tests and inconsistencies; Recommended next steps. Cite repository paths for every claim and say when something is an " +
  "inference rather than something you read.";

export function analysisMessage(options: Readonly<{ deep: boolean; focus?: string }>): string {
  const focus = options.focus === undefined ? "" : ` Focus on ${options.focus}: go deeper there than elsewhere, and name concrete files and functions.`;
  return `Analyze this repository.${focus}${options.deep ? " This is a deep analysis: trace more flows and inspect more files than usual, still prioritizing." : ""}`;
}

export async function analyze(plane: ControlPlane, options: AnalyzeOptions): Promise<AnalyzeReport> {
  if (options.focus !== undefined && !FOCUS.test(options.focus))
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "--focus takes one word (for example auth, security or architecture)." });
  if (options.inventoryOnly) {
    const runtime = await plane.runtime();
    const { root } = requireRepository(runtime);
    const inventory = await inventoryRepository(root, await ProcessGitClient.fromPath(plane.deps.env, true), { deep: options.deep,
      ...(options.focus === undefined ? {} : { focus: options.focus }), ...(options.signal ? { signal: options.signal } : {}) });
    return { inventory, analysis: null };
  }
  const conversation = await RepositoryConversation.open(plane, { ...options });
  try {
    const analysis = await conversation.ask(analysisMessage(options), { purpose: "analysis", instruction: ANALYSIS_INSTRUCTION,
      context: renderInventory(conversation.inventory, "full"), remember: false,
      ...(options.partner === undefined ? {} : { partner: options.partner }), ...(options.signal ? { signal: options.signal } : {}) });
    return { inventory: conversation.inventory, analysis };
  } finally { await conversation.close(); }
}
