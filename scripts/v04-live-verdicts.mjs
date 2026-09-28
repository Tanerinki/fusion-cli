// v0.4 live acceptance — the VERDICTS of L1–L5, decided mechanically from the transcript segments the runner recorded (the real
// shell's own lines: Route:, Turns:, the evidence snapshot, each hypothesis, each Fusion check, the falsification, the claim or
// diagnosis decision, the change task, the build's Evidence block and Decision, the apply result). Pure: it starts nothing and
// reads nothing. Used by scripts/v04-live-acceptance.mjs; pinned by test/v04-live-verdicts.test.ts.
//
// Every verdict is PASS, FAIL or REVIEW:
//   - PASS: the reliability property the part exists for was observed;
//   - FAIL: the product contradicted it (a false success, a leak of authority, a missing guarantee);
//   - REVIEW: the real models did not give the part a chance to show it (for example, nothing to falsify), so a human looks.

const lines = (segment, pattern) => (segment.match(pattern) ?? []).map(l => l.trim());
const routeLines = segment => lines(segment, /^ {2}Route: .+$/gmu);
const turnLines = segment => lines(segment, /^ {2}Turns: .+$/gmu);
const fusionFailure = segment => /^fusion: .+$/mu.exec(segment)?.[0];
const verdict = (status, detail, evidence = []) => ({ status, detail, lines: evidence });

/** The recorded lines of a claim check worth pasting back (no model text: Fusion's labels, counts and its own checks). */
export function claimCheckLines(segment) {
  return [...routeLines(segment), ...turnLines(segment),
    ...lines(segment, /^ {2}(?:Evidence snapshot|Independent hypotheses|Fresh falsification|Claim|Diagnosis)[: ].*$/gmu),
    ...lines(segment, /^ {4}k\d+ .+$/gmu), ...lines(segment, /^ {4}\(h\d: attempt .+$/gmu)];
}

/** L1 — a simple question stays one lead turn: no snapshot, no hypotheses, no falsification, no committee. */
export function judgeL1(segment) {
  const failure = fusionFailure(segment);
  if (failure !== undefined) return verdict("FAIL", failure, routeLines(segment));
  const simple = /^ {2}Route: lead only · 1 model turn/mu.test(segment);
  const committee = /Evidence snapshot|Independent hypotheses|Fresh falsification|Explorer investigations|Second opinion/u.test(segment);
  return simple && !committee ? verdict("PASS", "one lead turn, no investigator, no reviewer", routeLines(segment))
    : verdict("FAIL", committee ? "a committee ran for a simple question" : "the route was not `lead only · 1 model turn`", routeLines(segment));
}

/**
 * L2 — independent hypotheses: ONE snapshot handed identically to two investigators, both answering in isolation, BEFORE any
 * comparison (the route shows the snapshot, the hypotheses, then Fusion's checks and the lead's diagnosis). The checkout unchanged.
 */
export function judgeL2(segment, unchanged) {
  const failure = fusionFailure(segment);
  if (failure !== undefined) return verdict("FAIL", failure, claimCheckLines(segment));
  const route = routeLines(segment).at(-1) ?? "";
  const reasons = [];
  if (!/^Route: evidence snapshot → 2 independent hypotheses/u.test(route)) reasons.push("the route did not start with one snapshot and two independent hypotheses");
  if (!/→ lead diagnosis$/u.test(route)) reasons.push("the lead's diagnosis did not come after the hypotheses");
  if (!/^ {2}Evidence snapshot: sha256:[0-9a-f]{12}… given identically to 2 investigators, each in its own view copy and session; none saw another's conclusion$/mu.test(segment))
    reasons.push("no identical snapshot for two isolated investigators");
  const answered = /^ {2}Independent hypotheses: (\d+) of (\d+) answered/mu.exec(segment);
  if (answered === null || answered[1] !== "2" || answered[2] !== "2")
    reasons.push(`${answered === null ? "no" : `${answered[1]} of ${answered[2]}`} independent hypotheses answered (two are needed to compare)`);
  if (!unchanged) reasons.push("the checkout changed");
  return reasons.length > 0 ? verdict("FAIL", reasons.join("; "), claimCheckLines(segment))
    : verdict("PASS", "one snapshot, two isolated hypotheses answered, compared only afterwards; checkout unchanged", claimCheckLines(segment));
}

// The parts of a claim check the L3 and L4 verdicts read: Fusion's claim or diagnosis line and its own check lines.
const claimLine = segment => /^ {2}Claim: (SUPPORTED|CONTRADICTED|UNVERIFIED|STALE) — .*\(investigators: (\d+) support, (\d+) contradict\)/mu.exec(segment);
const leadingHypothesis = segment => /^ {2}Diagnosis: (h\d+) SUPPORTED by Fusion's checks/mu.exec(segment)?.[1];
const diagnosisStatus = (segment, id) => {
  const line = /^ {2}Diagnosis: .+$/mu.exec(segment)?.[0] ?? "";
  return new RegExp(`\\b${id} (SUPPORTED|CONTRADICTED|UNVERIFIED|STALE)\\b`, "u").exec(line)?.[1];
};
/** Fusion's checks that contradicted a target: `the claim` or `hypothesis hN`, optionally only those a given proposer made. */
const contradicting = (segment, proposer) => lines(segment, /^ {4}k\d+ .+ → CONTRADICTS (?:the claim|hypothesis h\d+) \(proposed by [^)]*\)$/gmu)
  .filter(line => proposer === undefined || new RegExp(`\\(proposed by [^)]*\\b${proposer}\\b[^)]*\\)$`, "u").test(line))
  .map(line => ({ line, target: /→ CONTRADICTS (the claim|hypothesis (h\d+))/u.exec(line) }))
  .map(({ line, target }) => ({ line, hypothesis: target?.[2] }));

/**
 * L3 — contradiction, as the v0.4 specification defines it: "models propose an incorrect diagnosis but deterministic evidence
 * blocks it". Judged over EVERY claim check of the run (`segments`: the diagnosis of L2, the user's false claim, the finding's
 * check in L5); `claimSegment` is the user's false claim, which Fusion must never accept.
 *   - a model's incorrect conclusion blocked: investigators supported a claim Fusion's check CONTRADICTED, or a hypothesis whose
 *     own prediction a Fusion check contradicted ended CONTRADICTED (not leading the diagnosis);
 *   - PASS: at least one was observed, and Fusion accepted none of them;
 *   - FAIL: Fusion accepted what its own check contradicted, or the false claim, or the checkout changed;
 *   - REVIEW: no model proposed an incorrect conclusion in this run — the property was not exercised live. Fusion contradicting
 *     the user's claim while the models also rejected it is NOT this property (the first real run's L3 was exactly that).
 * `falseConsensus` is informational, not a gate: two or more investigators unanimously supported a claim Fusion's check refuted.
 */
export function judgeL3(claimSegment, segments, unchanged) {
  const all = [...new Set([claimSegment, ...segments])].filter(s => s.length > 0);
  const evidence = all.flatMap(s => [...lines(s, /^ {2}(?:Claim|Diagnosis): .+$/gmu), ...contradicting(s).map(c => c.line)]);
  const failure = fusionFailure(claimSegment);
  const out = (status, detail, falseConsensus) => ({ ...verdict(status, detail, evidence), falseConsensus });
  let falseConsensus = false, accepted = "";
  const blocked = [];
  for (const segment of all) {
    const claim = claimLine(segment), refuted = contradicting(segment);
    const support = claim === null ? 0 : Number(claim[2]), against = claim === null ? 0 : Number(claim[3]);
    if (claim !== null && refuted.some(r => r.hypothesis === undefined)) {
      if (claim[1] === "SUPPORTED") accepted ||= "a claim Fusion's own check contradicted was reported SUPPORTED";
      else if (claim[1] === "CONTRADICTED" && support > 0) {
        blocked.push(`a claim ${support} investigator(s) supported`);
        if (support >= 2 && against === 0) falseConsensus = true;
      }
    }
    for (const id of new Set(refuted.flatMap(r => r.hypothesis === undefined ? [] : [r.hypothesis]))) {
      if (leadingHypothesis(segment) === id) accepted ||= `hypothesis ${id} leads the diagnosis although Fusion's check contradicted it`;
      else if (diagnosisStatus(segment, id) === "CONTRADICTED") blocked.push(`hypothesis ${id} (its own prediction failed Fusion's check)`);
    }
  }
  if (failure !== undefined) return out("FAIL", failure, falseConsensus);
  if (!unchanged) return out("FAIL", "the checkout changed", falseConsensus);
  const own = claimLine(claimSegment);
  if (own === null) return out("FAIL", "no claim decision was reported for the false claim", falseConsensus);
  if (own[1] === "SUPPORTED") return out("FAIL", `Fusion accepted a claim its fixture refutes (investigators: ${own[2]} support, ${own[3]} contradict)`, falseConsensus);
  if (accepted !== "") return out("FAIL", accepted, falseConsensus);
  if (blocked.length > 0) return out("PASS", `${blocked.length} model conclusion(s) refused because Fusion's own checks contradicted them: ${blocked.join("; ")}` +
    `${falseConsensus ? " (a false consensus Fusion refused)" : ""}`, falseConsensus);
  return out("REVIEW", `no model proposed an incorrect conclusion in this run (the false claim ended ${own[1]}; investigators: ${own[2]} support, ${own[3]} contradict), ` +
    "so \"models propose an incorrect diagnosis but deterministic evidence blocks it\" was not exercised live", falseConsensus);
}

/**
 * L4 — the falsifier: in some claim check, a fresh reviewer tried to break the conclusion and its result was adjudicated (the
 * lead's diagnosis came after it). PASS means the stage ran and no mechanically established blocker was ignored — NOT that the
 * falsifier agreed: its objections are reported and stay open. FAIL when it failed, no fresh reviewer existed, or Fusion kept a
 * conclusion a falsifier check contradicted; REVIEW when every claim check had nothing to break.
 */
export function judgeL4(segments) {
  const ran = segments.filter(s => /^ {2}Fresh falsification \(.+\): verdict (?:holds|broken|unclear) — it tried to break: /mu.test(s) &&
    /→ fresh falsification(?: \([^)]*\))? → lead diagnosis$/mu.test(routeLines(s).at(-1) ?? ""));
  const failed = segments.filter(s => /^ {2}Fresh falsification \(.+\): no report — /mu.test(s) || /no fresh reviewer with a proven read-only posture/u.test(s));
  const evidence = segments.flatMap(s => [...routeLines(s), ...lines(s, /^ {2}Fresh falsification.+$/gmu), ...lines(s, /^ {4}(?:counterexample|missing evidence) \(untrusted\).+$/gmu),
    ...lines(s, /^ {4}k\d+ .+\(proposed by [^)]*falsifier[^)]*\)$/gmu)]);
  // A falsifier check that contradicted a conclusion Fusion then still reported SUPPORTED: a blocker ignored.
  const ignored = segments.some(s => contradicting(s, "falsifier").some(r =>
    r.hypothesis === undefined ? claimLine(s)?.[1] === "SUPPORTED" : leadingHypothesis(s) === r.hypothesis));
  if (ignored) return verdict("FAIL", "a conclusion a falsifier check contradicted was still reported SUPPORTED", evidence);
  if (ran.length > 0) {
    const broke = segments.some(s => contradicting(s, "falsifier").length > 0);
    const counters = ran.reduce((n, s) => n + lines(s, /^ {4}counterexample \(untrusted\).+$/gmu).length, 0);
    const missing = ran.reduce((n, s) => n + lines(s, /^ {4}missing evidence \(untrusted\).+$/gmu).length, 0);
    return verdict("PASS", `a fresh falsification ran in ${ran.length} claim check(s) and was adjudicated${broke ? "; one of its checks broke a conclusion" : ""}` +
      `${counters + missing > 0 ? `; its objections (${counters} counterexample(s), ${missing} missing-evidence) stay open, untrusted` : ""}`, evidence);
  }
  if (failed.length > 0) return verdict("FAIL", "the falsification did not run or failed", evidence);
  return verdict("REVIEW", "no claim check had a conclusion to break, so the falsifier was not exercised", evidence);
}

/**
 * L5 — a verified mutation: the finding was checked, "fix it" carried the check's evidence, the build proved its obligations
 * (the invalid state reproduced by Fusion's own check on the unchanged baseline, then corrected), Decision VERIFIED, the human
 * approved, the delivery applied, and the fixture's own verification passed.
 */
export function judgeL5(segments, fixtureOk) {
  const [analysis = "", verification = "", change = ""] = segments;
  const all = segments.join("\n");
  const failure = fusionFailure(all);
  const parts = {
    checked: /^Checking whether this holds \(read-only\): /mu.test(verification) && /^ {2}Claim: /mu.test(verification),
    handoff: /^\(Fusion's (?:investigation|verification) of this finding cited: .+\)$/mu.test(change) || /^\(Fusion's checks of this finding: .+\)$/mu.test(change),
    reproduced: /^ {2}(?:invalid state shown|reproduced defect) \.+ PASS /mu.test(change),
    resolved: /^ {2}(?:corrected state shown|defect resolved) \.+ PASS /mu.test(change),
    verified: /^Decision: VERIFIED/mu.test(change),
    applied: /^Result: applied/mu.test(change),
    fixture: fixtureOk === true,
  };
  const evidence = [...routeLines(analysis), ...claimCheckLines(verification), ...lines(change, /^(?:Scope \(.+|Verification: .+|Review: .+|Decision: .+|Result: .+)$/gmu),
    ...lines(change, /^ {2}[a-z][a-z ]+ \.+ .+$/gmu), ...lines(change, /^\(Fusion's .+\)$/gmu)];
  const detail = Object.entries(parts).map(([k, ok]) => `${k}=${ok ? "yes" : "NO"}`).join(" ");
  if (failure !== undefined) return verdict("FAIL", `${failure} (${detail})`, evidence);
  return verdict(Object.values(parts).every(Boolean) ? "PASS" : "FAIL", detail, evidence);
}

/** The overall verdict: FAIL if any part failed or a sentinel leaked, else REVIEW if any part needs a look, else PASS. */
export function overall(results, sentinelsSeen) {
  if (sentinelsSeen.length > 0 || results.some(r => r.status === "FAIL" || r.status === "NOT RUN")) return "FAIL";
  return results.some(r => r.status === "REVIEW") ? "REVIEW" : "PASS";
}
