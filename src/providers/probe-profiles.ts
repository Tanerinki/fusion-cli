import type { ProbeGrant, ProbeProfileSet } from "../app/proposal-probe.js";

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
          "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--permission-prompt-tool", "--json-schema"]) }),
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
