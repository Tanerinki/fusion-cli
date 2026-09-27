// v0.3 live acceptance — the PRECONDITIONS, decided from the STRUCTURED report of `fusion --json doctor --probe` (never from
// its human-readable text). Pure: it starts nothing and reads nothing. Used by scripts/v03-live-acceptance.mjs; pinned by
// test/v03-live-preconditions.test.ts.
//
// The runner may start a model turn only when BOTH real-provider roles of the live routes are mechanically confirmed:
//
//   Lead (the Claude binding, adapter claude-one-shot)
//     - its auth probe is `authenticated` on a SUBSCRIPTION lane: `subscription` (the interactive login) or
//       `subscriptionToken` (a subscription OAuth token), exactly the lanes Fusion's own read-only policy accepts
//       (src/app/readiness.ts SUBSCRIPTION_LANES) — never `api`, `thirdParty` or `unknown`;
//     - its runtime posture was checked by this probe: `attested` (the canary passed on this exact runtime now) or
//       `recorded` (the validated release, whose canary passed too) — never `refused` or absent.
//   Reviewer (the Muse binding, adapter muse-exec; it also runs the investigations)
//     - its auth probe is `authenticated` on the `subscription` lane (the only lane the Muse profile has);
//     - its read-only posture is established at launch time and it is read-only ELIGIBLE (the validated binding): Muse has
//       no model-free canary, so this is the posture evidence Fusion itself routes on.
//
// Each role must appear exactly once. Anything else refuses, with a plain reason.

/** The subscription lanes per role, and their human names as `fusion doctor` prints them. */
export const LEAD_LANES = Object.freeze(["subscription", "subscriptionToken"]);
export const REVIEWER_LANES = Object.freeze(["subscription"]);
export const LEAD_POSTURES = Object.freeze(["attested", "recorded"]);
const LANE_LABEL = Object.freeze({ subscription: "subscription login", subscriptionToken: "subscription OAuth token" });
const label = lane => LANE_LABEL[lane] ?? String(lane);

/**
 * Reads the stdout of `fusion --json doctor --probe`. Returns the report object, or undefined when it is not one JSON object
 * with a providers array.
 */
export function parseDoctorReport(stdout) {
  try {
    const value = JSON.parse(String(stdout).trim());
    return value !== null && typeof value === "object" && !Array.isArray(value) && Array.isArray(value.providers) ? value : undefined;
  } catch { return undefined; }
}

/**
 * The verdict for one parsed report: `{ confirmed, lines, reasons }` — `lines` describe each required role in doctor's own
 * words (safe labels only), `reasons` say why it is not confirmed (empty when confirmed).
 */
export function evaluatePreconditions(report) {
  const lines = [], reasons = [];
  if (report === undefined) return { confirmed: false, lines, reasons: ["fusion --json doctor --probe did not produce a readable report"] };
  const role = (name, adapter) => {
    const matches = report.providers.filter(p => p !== null && typeof p === "object" && p.role === name);
    if (matches.length === 0) { reasons.push(`no ${name} binding is configured`); return undefined; }
    if (matches.length > 1) { reasons.push(`${matches.length} ${name} bindings are configured; the live acceptance needs exactly one`); return undefined; }
    const binding = matches[0];
    if (binding.adapter !== adapter) { reasons.push(`the ${name} binding uses ${binding.adapter}, not ${adapter} (the default this acceptance is for)`); return undefined; }
    const probe = binding.probe;
    if (probe === undefined || probe === null || typeof probe !== "object") { reasons.push(`the ${name} binding was not probed`); return undefined; }
    if (!("auth" in probe) || probe.auth === null || typeof probe.auth !== "object") {
      reasons.push(`the ${name} probe failed${typeof probe.error === "string" ? `: ${probe.error}` : ""}`); return undefined;
    }
    return binding;
  };

  const lead = role("Lead", "claude-one-shot");
  if (lead !== undefined) {
    const { auth, posture } = lead.probe;
    lines.push(`Lead (${lead.adapter}): auth ${auth.state} (${label(auth.lane)})` +
      `${posture ? `; runtime posture ${posture.version}: ${posture.state}` : "; runtime posture: not checked"}`);
    if (auth.state !== "authenticated") reasons.push(`the Lead's login is ${auth.state}, not authenticated`);
    else if (!LEAD_LANES.includes(auth.lane)) reasons.push(`the Lead authenticated on the ${label(auth.lane)} lane, not a subscription lane (API keys and gateways are refused)`);
    if (posture === undefined || posture === null || typeof posture !== "object") reasons.push("the Lead's runtime posture was not attested by the probe");
    else if (!LEAD_POSTURES.includes(posture.state)) reasons.push(`the Lead's runtime posture is ${posture.state}, not attested`);
  }

  const reviewer = role("Reviewer", "muse-exec");
  if (reviewer !== undefined) {
    const { auth } = reviewer.probe;
    const eligible = reviewer.eligibility?.readOnly?.state;
    lines.push(`Reviewer (${reviewer.adapter}): auth ${auth.state} (${label(auth.lane)}); posture evidence ${reviewer.postureEvidence}; read-only ${eligible ?? "unknown"}`);
    if (auth.state !== "authenticated") reasons.push(`the Reviewer's login is ${auth.state}, not authenticated`);
    else if (!REVIEWER_LANES.includes(auth.lane)) reasons.push(`the Reviewer authenticated on the ${label(auth.lane)} lane, not its subscription login`);
    if (reviewer.postureEvidence !== "launchTime" || eligible !== "eligible")
      reasons.push(`the Reviewer's read-only posture is not proven at launch time: Muse ${reviewer.inspection?.runtimeVersion ?? "(version unknown)"} ` +
        "is not a validated release for this binding (Fusion will not let it investigate or review)");
  }
  return { confirmed: reasons.length === 0, lines, reasons };
}
