import type { ProbeGrant, ProbeProfileSet } from "../app/proposal-probe.js";
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
  }),
});
