import type { AdjudicationProbeProfileSet } from "../app/adjudication-probe.js";
import type { ProbeGrant, ProbeProfileSet } from "../app/proposal-probe.js";
import type { ReviewerProbeGrant, ReviewerProbeProfileSet } from "../app/reviewer-probe.js";
import type { RouteProfileSet } from "../app/route-probe.js";

/** The O5.5B9/O5.5B11 Claude Change Author grant: the pinned runtime, a subscription lane, the probed binding exactly. */
const CLAUDE_GRANT: ProbeGrant = Object.freeze({ runtimeVersions: Object.freeze(["2.1.280"]),
  lanes: Object.freeze(["subscription", "subscriptionToken"]),
  binding: Object.freeze({ adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 3,
    options: Object.freeze({ canonicalModel: "claude-haiku-4-5-20251001" }) }),
  requiredEnvironment: Object.freeze(["FUSION_CLAUDE_EXE"]) });

/**
 * O5.5B9: the provider-specific facts of the authorized change-proposal probe. The orchestration in
 * `app/proposal-probe.ts` is provider-neutral; everything that names a provider, a model, a launch flag or a credential
 * variable lives here, next to the registry that builds the adapters.
 *
 * Bindings: the lowest practical effort of each family, one proposal turn, no retry.
 *  - Claude one-shot: the `haiku` alias read back as its canonical identity, effort `low` (the CLI's lowest), at most
 *    three agentic turns inside the one proposal (read the file, answer).
 *  - Muse Exec (the transport that binds a per-session view; MSP cannot): effort `minimal` (the lowest setting already
 *    exercised live with structured output), at most four model steps, malformed-output retry disabled.
 */
export const PROPOSAL_PROBE_PROFILES: ProbeProfileSet = Object.freeze({
  profiles: Object.freeze({
    claude: Object.freeze({
      binding: Object.freeze({ role: "Worker" as const, adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 3,
        options: Object.freeze({ canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 }) }),
      turnPosture: Object.freeze({
        required: Object.freeze([["--tools", "Read,Grep,Glob"], ["--permission-mode", "dontAsk"], ["--permission-prompts", "none"], ["--restricted"],
          ["--safe-mode"], ["--strict-mcp-config"], ["--disable-slash-commands"], ["--no-session-persistence"], ["--include-hook-events"]]),
        widening: Object.freeze(["--mcp-config", "--add-dir", "--allowedTools", "--allowed-tools", "--agents", "--dangerously-skip-permissions",
          "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--permission-prompt-tool", "--json-schema", "--fallback-model"]) }),
    }),
    muse: Object.freeze({
      binding: Object.freeze({ role: "Worker" as const, adapter: "muse-exec", model: "muse-spark-1.3", effort: "minimal",
        options: Object.freeze({ provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 }) }),
      turnPosture: Object.freeze({
        required: Object.freeze([["--disable-write"], ["--disable-shell"], ["--disable-web-tools"], ["--approval-mode", "never"],
          ["--approval-judge", "off"], ["--no-foreign-personal-context"]]),
        widening: Object.freeze(["--yolo", "--trust-workspace", "--disable-approval", "--disable-sandbox", "--enable-shell-tool", "--base-url",
          "--api-key-stdin", "--allow-workspace-switch", "--worktree", "-w", "--permission-profile"]) }),
    }),
  }),
  /**
   * Human authorizations of real proposal turns, by the token the human passes (`--authorization`). Each lists exactly
   * what it permits per provider family and owns its evidence namespace under %TEMP%.
   *  - O5.5B9: one Claude and one Muse turn — both ran (2026-09-24); CONSUMED.
   *  - O5.5B11: exactly one Claude turn on the pinned 2.1.280, same binding as O5.5B9, so the O5.5B10 envelope is the
   *    variable. No Muse grant. It ran (2026-09-24T19:13Z, PASS); CONSUMED.
   */
  authorizations: Object.freeze({
    "O5.5B9": Object.freeze({ milestone: "O5.5B9", evidenceDirectory: "fusion-o5-5b9-probe", state: "consumed" as const,
      grants: Object.freeze({ claude: CLAUDE_GRANT, muse: Object.freeze({ runtimeVersions: Object.freeze(["1.3.0-R3401.1"]),
        lanes: Object.freeze(["subscription"]), binding: Object.freeze({ adapter: "muse-exec", model: "muse-spark-1.3", effort: "minimal",
          options: Object.freeze({ provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0 }) }), requiredEnvironment: Object.freeze([]) }) }) }),
    "O5.5B11": Object.freeze({ milestone: "O5.5B11", evidenceDirectory: "fusion-o5-5b11-probe", state: "consumed" as const,
      grants: Object.freeze({ claude: CLAUDE_GRANT }) }),
  }),
  /**
   * Variables a Claude Code session sets for its own tool processes. The probe refuses to start inside one: on this
   * machine Muse model calls from that process tree lose network access, and a Claude probe would nest Claude.
   */
  nestedSessionKeys: Object.freeze(["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ID", "CLAUDE_CODE_CHILD_SESSION"]),
  /** Credential and override variables that must never reach a provider process (key names only). */
  forbiddenEnv: /^(?:ANTHROPIC_|META_API_KEY$|MODEL_API_KEY$|GITHUB_TOKEN$|GH_TOKEN$|AWS_SECRET|CLAUDE_CODE_EFFORT_LEVEL$|CLAUDE_CODE_USE_|MUSE_ENABLE_|TBH_MANAGED)/u,
});

/**
 * O5.5B12: the frozen FULL-ROUTE live rehearsal plan (`app/route-probe.ts`). PENDING: it defines exactly what a future,
 * separately and explicitly human-approved milestone may run, and refuses before anything exists until that milestone
 * sets it `open`. It is not the live Writer gate and opens nothing.
 *
 * Roles follow the production policy's adapter families (Lead: the one-shot CLI; fresh Reviewer: the exec CLI, as in the
 * default bindings) with the Change Author on the live-proven one-shot profile, so the review is cross-family. Models and
 * efforts are the cheapest whose identity readback is live-observed on the pinned runtime (the Lead binding of the
 * production default, opus/high, has never been observed there). Turn budget = the engine's own bounds: one plan, two
 * Change Author attempts (the second only after a mechanical retry or correction), two review cycles, two adjudications.
 */
const ROUTE_CLAUDE = (maxTurns: number) => Object.freeze({ family: "claude", executable: "claude.exe",
  runtimeVersions: Object.freeze(["2.1.280"]), lanes: Object.freeze(["subscription", "subscriptionToken"]),
  binding: Object.freeze({ adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns,
    options: Object.freeze({ canonicalModel: "claude-haiku-4-5-20251001", timeoutMs: 180_000 }) }),
  // Every model process of the role carries exactly these (O5.5B13): no model, effort or turn-limit substitution.
  turnArgs: Object.freeze([Object.freeze(["--model", "haiku"] as const), Object.freeze(["--effort", "low"] as const),
    Object.freeze(["--max-turns", String(maxTurns)] as const)]),
  requiredEnvironment: Object.freeze(["FUSION_CLAUDE_EXE"]) });
const ROUTE_MUSE_REVIEWER = Object.freeze({ family: "muse", executable: "muse-bin-1.3.0-R3401.1.exe", runtimeVersions: Object.freeze(["1.3.0-R3401.1"]),
  lanes: Object.freeze(["subscription"]), binding: Object.freeze({ adapter: "muse-exec", model: "muse-spark-1.3", effort: "low",
    options: Object.freeze({ provider: "meta", maxModelSteps: 4, malformedOutputRetries: 0, timeoutMs: 180_000 }) }),
  turnArgs: Object.freeze([Object.freeze(["--model", "muse-spark-1.3"] as const), Object.freeze(["--reasoning-effort", "low"] as const),
    Object.freeze(["--max-model-steps", "4"] as const)]),
  requiredEnvironment: Object.freeze([]) });
const ROUTE_ROLES_FROZEN = Object.freeze({ Lead: ROUTE_CLAUDE(6), Worker: ROUTE_CLAUDE(6), Reviewer: ROUTE_MUSE_REVIEWER });
const ROUTE_TURNS_FROZEN = Object.freeze({ leadPlan: 1, changeAuthor: 2, freshReview: 2, leadAdjudication: 2 });
/** One Lead-plan turn and nothing else (O5.5B15, O5.5B17). */
const LEAD_ONLY_TURNS = Object.freeze({ leadPlan: 1, changeAuthor: 0, freshReview: 0, leadAdjudication: 0 });
/**
 * O5.5B23: the EXACT Reviewer binding a Reviewer-only probe (`app/reviewer-probe.ts`) validates — the machine's installed
 * Muse Exec release 1.4.0-R4161.1, which Fusion has NOT validated (it is the release UNDER VALIDATION; it is never added to
 * validated versions here) — with the route Reviewer's binding exactly: muse-spark-1.3, effort low, at most 4 model steps,
 * no malformed-output retry, a subscription lane, the family's read-only controls. The executable is pinned by name,
 * location (the default install directory) and SHA-256 (read from the installed file's bytes on 2026-09-25, never by
 * launching it); every model process must carry exactly the provider, model, effort and step flags below. No
 * authorization exists in O5.5B23: a probe needs a separate, explicit human authorization.
 */
export const MUSE_1_4_REVIEWER: ReviewerProbeGrant = Object.freeze({ family: "muse", executable: "muse-bin-1.4.0-R4161.1.exe",
  executableDirectory: "%LOCALAPPDATA%/Programs/muse", executableSha256: "b33b493069a2593e97cc63f9a4063feb64269bf7f07a233f5db2db681ad5d950",
  runtimeVersions: Object.freeze(["1.4.0-R4161.1"]), lanes: Object.freeze(["subscription"]), binding: ROUTE_MUSE_REVIEWER.binding,
  turnArgs: Object.freeze([Object.freeze(["--provider", "meta"] as const), Object.freeze(["--model", "muse-spark-1.3"] as const),
    Object.freeze(["--reasoning-effort", "low"] as const), Object.freeze(["--max-model-steps", "4"] as const)]),
  requiredEnvironment: Object.freeze([]) });
/**
 * O5.5B25: the route roles of the first full-route rehearsal after O5.5B24 — the Lead (plan and adjudication) and the
 * Change Author on the route's established Claude binding, and the fresh Reviewer EXACTLY as O5.5B24 validated it
 * (`MUSE_1_4_REVIEWER`: Muse Exec 1.4.0-R4161.1, binary pinned by location and SHA-256, muse-spark-1.3, low, 4 steps, no
 * retry).
 */
const ROUTE_ROLES_B25 = Object.freeze({ Lead: ROUTE_CLAUDE(6), Worker: ROUTE_CLAUDE(6), Reviewer: MUSE_1_4_REVIEWER });
/** The fixture both plans were approved for (`routeFixtureIdentity()`, the O5.5B7 "quotes" project as of O5.5B12). */
const ROUTE_FIXTURE_SHA256 = "59c19d1f876f944410d0e3bee5a7d390770380993a563a978231e5355b938326";
export const ROUTE_REHEARSAL_PROFILES: RouteProfileSet = Object.freeze({
  families: PROPOSAL_PROBE_PROFILES,
  authorizations: Object.freeze({
    // The O5.5B12 plan itself stays PENDING forever: the human approved its content under the O5.5B13 identity below.
    "O5.5B12-LIVE": Object.freeze({ milestone: "O5.5B12", evidenceDirectory: "fusion-o5-5b12-route", state: "pending" as const,
      roles: ROUTE_ROLES_FROZEN, turns: ROUTE_TURNS_FROZEN, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B13: the human explicitly authorized ONE full-route live rehearsal with exactly the O5.5B12 plan — at most 7
     * model turns (Lead plan 1; Change Author 2, the second only after a mechanical retry or correction; fresh Reviewer
     * 2; Lead adjudication 2), Claude Code 2.1.280 haiku/low and Muse 1.3.0-R3401.1 muse-spark-1.3/low, subscription
     * lanes only, the pinned fixture. It ran once (2026-09-25T00:04Z): PROVIDER_FAILED at leadPlan #1, one model turn,
     * nothing after the Lead (docs/o5-5b13-full-route-live-proof.md). CONSUMED; another run needs a new authorization.
     */
    "O5.5B13-LIVE": Object.freeze({ milestone: "O5.5B13", evidenceDirectory: "fusion-o5-5b13-route", state: "consumed" as const,
      roles: ROUTE_ROLES_FROZEN, turns: ROUTE_TURNS_FROZEN, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B15: the human explicitly authorized exactly ONE real Claude Lead-plan turn to diagnose the O5.5B13 failure with
     * the O5.5B14 terminal diagnostic — Claude Code 2.1.280 haiku/low, `--max-turns 6`, the same pinned fixture and
     * bindings, subscription lanes, normal terminal only. Every other turn class has budget 0: no Change Author, Reviewer
     * or adjudication turn, and a role with no authorized turn may not even open a session. It ran once
     * (2026-09-25T09:32Z): the Lead turn ended RESULT_ERROR_MAX_TURNS (error_max_turns, 7 turns counted against the limit
     * of 6), nothing after the Lead (docs/o5-5b15-lead-live-probe.md). CONSUMED; another run needs a new authorization.
     */
    "O5.5B15-LEAD": Object.freeze({ milestone: "O5.5B15", evidenceDirectory: "fusion-o5-5b15-lead", state: "consumed" as const,
      roles: ROUTE_ROLES_FROZEN, turns: LEAD_ONLY_TURNS, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B17: the human explicitly authorized exactly ONE real Claude Lead-plan turn to retest the Lead after O5.5B16
     * changed only its plan prompt — an A/B retest of O5.5B15: the same grants (Claude Code 2.1.280 haiku/low,
     * `--max-turns 6`), fixture, lanes, one-turn budget and diagnostics; only its milestone and namespace differ. Every
     * other turn class has budget 0 and no later role may open a session. It ran once (2026-09-25T10:50Z): the model
     * turn succeeded (RESULT_OK, 6 turns) but its single fenced JSON reply was refused by the raw-only Lead envelope
     * (MALFORMED_OUTPUT; docs/o5-5b17-lead-live-retest.md). CONSUMED; another run needs a new authorization.
     */
    "O5.5B17-LEAD": Object.freeze({ milestone: "O5.5B17", evidenceDirectory: "fusion-o5-5b17-lead", state: "consumed" as const,
      roles: ROUTE_ROLES_FROZEN, turns: LEAD_ONLY_TURNS, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B19: the human explicitly authorized exactly ONE real Claude Lead-plan turn to retest the Lead CONTRACT end to
     * end after O5.5B16 (planning prompt) and O5.5B18 (the narrow single-fence Lead envelope): the O5.5B17 shape exactly —
     * the same grants (Claude Code 2.1.280 haiku/low, `--max-turns 6`), fixture, lanes, one-turn budget and diagnostics;
     * only milestone and namespace differ. No later role may open a session. The human's one attempt (2026-09-25T12:38Z)
     * stopped in PREFLIGHT: VERSION_BLOCKED on the inactive Reviewer's Muse 1.4.0-R4161.1 — no claim, no provider model turn
     * (docs/o5-5b19-lead-contract-live-retest.md). RETIRED: never runnable; the retest continues as O5.5B21-LEAD.
     */
    "O5.5B19-LEAD": Object.freeze({ milestone: "O5.5B19", evidenceDirectory: "fusion-o5-5b19-lead", state: "retired" as const,
      roles: ROUTE_ROLES_FROZEN, turns: LEAD_ONLY_TURNS, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B21: the Lead CONTRACT retest O5.5B19 could not start, after O5.5B20 made preflight check only the roles an
     * authorization lets start. The O5.5B19 shape exactly — Claude Code 2.1.280 haiku/low, `--max-turns 6`, the pinned
     * fixture, subscription lanes, the O5.5B16 planning prompt and the O5.5B18 Lead envelope, one Lead turn and nothing
     * else; only milestone and namespace differ. The inactive Reviewer (Muse, now 1.4.0-R4161.1 on this machine) is not
     * inspected or routed. It ran once (2026-09-25T13:29Z): the Lead contract PASSED (RESULT_OK, one fenced JSON reply
     * accepted, ResultPacket accepted), then the zero budget refused the Worker (docs/o5-5b21-lead-contract-live-retest.md).
     * CONSUMED; another run needs a new authorization.
     */
    "O5.5B21-LEAD": Object.freeze({ milestone: "O5.5B21", evidenceDirectory: "fusion-o5-5b21-lead", state: "consumed" as const,
      roles: ROUTE_ROLES_FROZEN, turns: LEAD_ONLY_TURNS, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B25: the first new full-route live rehearsal after the real Lead contract PASS (O5.5B21), the Claude Change
     * Author PASS history (O5.5B9, O5.5B11), the Muse 1.4 fresh Reviewer PASS (O5.5B24), the single-fence adjudication
     * envelope (O5.5B22) and active-role preflight and routing (O5.5B20): the production route on the pinned fixture —
     * Lead plan and adjudication and Change Author on Claude Code 2.1.280 haiku/low (`--max-turns 6`), the fresh Reviewer
     * exactly the O5.5B24-validated Muse 1.4 binding and binary. Budget: the engine's own bounds (Lead plan 1; Change
     * Author 2, the second only after a mechanical retry or correction; fresh review 2; adjudication 2, only when a review
     * has findings); a turn the engine's state does not call for is never spent. Every role can start, so every role is
     * preflighted, the Reviewer's binary included. It ran once (2026-09-25T18:47Z): MALFORMED_OUTPUT at changeAuthor #1 —
     * the Lead plan passed; the Change Author's model turn succeeded but its reply had text before its one schema-matching
     * fenced ChangeSet (EXTRA_TEXT); no Reviewer or adjudication ran (docs/o5-5b25-full-route-live-rehearsal.md). CONSUMED.
     */
    "O5.5B25-LIVE": Object.freeze({ milestone: "O5.5B25", evidenceDirectory: "fusion-o5-5b25-route", state: "consumed" as const,
      roles: ROUTE_ROLES_B25, turns: ROUTE_TURNS_FROZEN, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
    /**
     * O5.5B27: the full-route rehearsal after O5.5B26 — exactly the O5.5B25 plan (the same role grants and bindings,
     * budgets 1/2/2/2, fixture, lanes, Docker-confined verification, state-required turns only); the one behavioural
     * difference is in the code: the Claude Change Author's reply rule is the O5.5B26 output discipline. It ran once
     * (2026-09-25T20:25Z): PASS — the first full-route pass: Lead plan, two Change Author turns (the second after a failed
     * confined verification), host application, confined verification, a clean fresh review; no adjudication
     * (docs/o5-5b27-full-route-live-pass.md). CONSUMED.
     */
    "O5.5B27-LIVE": Object.freeze({ milestone: "O5.5B27", evidenceDirectory: "fusion-o5-5b27-route", state: "consumed" as const,
      roles: ROUTE_ROLES_B25, turns: ROUTE_TURNS_FROZEN, fixtureSha256: ROUTE_FIXTURE_SHA256 }),
  }),
});

/** One fresh review and nothing else (O5.5B24): the only budget a Reviewer-only probe accepts. */
const REVIEWER_ONLY_TURNS_FROZEN = Object.freeze({ leadPlan: 0, changeAuthor: 0, freshReview: 1, leadAdjudication: 0 });
/** The Fusion-authored candidate change the Reviewer reviews (`reviewCandidateIdentity()`, O5.5B23). */
const REVIEW_CANDIDATE_SHA256 = "a8e6622d5a41356aac23fce1327d3873cc7ce19d7bebcca8a210ab4245824952";
/** O5.5B23: Reviewer-only probe authorizations, by the token the human passes. */
export const REVIEWER_PROBE_PROFILES: ReviewerProbeProfileSet = Object.freeze({
  families: PROPOSAL_PROBE_PROFILES,
  authorizations: Object.freeze({
    /**
     * O5.5B24: the PLAN for exactly ONE real Muse Reviewer turn on the installed, UNVALIDATED release 1.4.0-R4161.1 — the
     * exact O5.5B23 binding (`MUSE_1_4_REVIEWER`: muse-spark-1.3, effort low, 4 model steps, no retry, the executable pinned
     * by location and SHA-256), budget one fresh review and nothing else (no Lead, Change Author or adjudication turn),
     * the pinned route fixture and Fusion-authored candidate, subscription lane, run once by the human from a normal
     * terminal. The human explicitly authorized opening it exactly as prepared and ran it once (2026-09-25T15:41Z): PASS —
     * one Reviewer turn, RAW_VALID_JSON under raw-only, contract accepted (0 findings), integrity and cleanup complete;
     * independently validated (74 checks; docs/o5-5b24-muse14-reviewer-live.md). CONSUMED; another run needs a new
     * authorization. 1.4.0-R4161.1 is now validated for exactly this Reviewer binding and binary only (provider profiles).
     */
    "O5.5B24-REVIEWER": Object.freeze({ milestone: "O5.5B24", evidenceDirectory: "fusion-o5-5b24-reviewer", state: "consumed" as const,
      reviewer: MUSE_1_4_REVIEWER, turns: REVIEWER_ONLY_TURNS_FROZEN, fixtureSha256: ROUTE_FIXTURE_SHA256,
      candidateSha256: REVIEW_CANDIDATE_SHA256 }),
  }),
});

/**
 * O5.5B28: the EXACT Lead binding a Lead-adjudication probe (`app/adjudication-probe.ts`) exercises — the route Lead's grant
 * object itself (the Lead that plans and, when a review has findings, adjudicates in O5.5B25/O5.5B27): Claude Code 2.1.280
 * (the side-by-side install named by FUSION_CLAUDE_EXE), `haiku` read back as claude-haiku-4-5-20251001, effort low,
 * `--max-turns 6`, the subscription lanes, the family's read-only controls; every model process must carry exactly the
 * model, effort and turn-limit flags. Its adjudication reply is read under the transport's recorded envelope (O5.5B22:
 * raw JSON or exactly one json/bare fence) and checked by the production adjudication contract.
 */
export const ROUTE_LEAD_ADJUDICATOR = ROUTE_ROLES_B25.Lead;
/** O5.5B28: Lead-adjudication probe authorizations, by the token the human passes. None exists in O5.5B28. */
export const ADJUDICATION_PROBE_PROFILES: AdjudicationProbeProfileSet = Object.freeze({
  families: PROPOSAL_PROBE_PROFILES,
  authorizations: Object.freeze({}),
});
