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
 * L3 — deterministic evidence outranks model judgement, with REAL providers. The user's claim is false by construction of the
 * fixture, and Fusion derives a check from its own words. Two guarantees are kept apart:
 *   - the DETERMINISTIC invariant (models agreeing on a false claim are overruled by Fusion's check) is proven by the black box
 *     with scripted false consensus (scenarios C and G) — it does not depend on a real model making a mistake;
 *   - this live verdict proves the INTEGRATION: in the false claim's check, one snapshot went identically to two investigators and
 *     both real provider turns answered; Fusion ran its own check and it contradicts the claim; the claim ended CONTRADICTED by
 *     Fusion's checks whatever the investigators concluded — a provider that supported the false claim is refused, and models
 *     that rejected it are equally a PASS; and in no claim check of the run did Fusion accept anything its own check contradicted.
 * FAIL otherwise (a false success, no Fusion check against the claim, fewer than two independent turns, a changed checkout, a
 * Fusion failure). There is no REVIEW: the property does not wait for a model to err. `falseConsensus` (two or more investigators
 * unanimously supported the false claim) and the model conclusions refused elsewhere in the run are reported as information.
 */
export function judgeL3(claimSegment, segments, unchanged) {
  const all = [...new Set([claimSegment, ...segments])].filter(s => s.length > 0);
  const evidence = [...claimCheckLines(claimSegment), ...all.filter(s => s !== claimSegment).flatMap(s => contradicting(s).map(c => c.line))];
  const out = (status, detail, falseConsensus) => ({ ...verdict(status, detail, evidence), falseConsensus });
  let accepted = "";
  const refusedElsewhere = [];
  for (const segment of all) {
    const claim = claimLine(segment), refuted = contradicting(segment);
    if (claim !== null && claim[1] === "SUPPORTED" && refuted.some(r => r.hypothesis === undefined))
      accepted ||= "a claim Fusion's own check contradicted was reported SUPPORTED";
    for (const id of new Set(refuted.flatMap(r => r.hypothesis === undefined ? [] : [r.hypothesis]))) {
      if (leadingHypothesis(segment) === id) accepted ||= `hypothesis ${id} leads the diagnosis although Fusion's check contradicted it`;
      else if (segment !== claimSegment && diagnosisStatus(segment, id) === "CONTRADICTED") refusedElsewhere.push(`hypothesis ${id}`);
    }
    if (segment !== claimSegment && claim?.[1] === "CONTRADICTED" && Number(claim[2]) > 0 && refuted.some(r => r.hypothesis === undefined))
      refusedElsewhere.push(`a claim ${claim[2]} investigator(s) supported`);
  }
  const own = claimLine(claimSegment);
  const support = own === null ? 0 : Number(own[2]), against = own === null ? 0 : Number(own[3]);
  const falseConsensus = own !== null && own[1] === "CONTRADICTED" && support >= 2 && against === 0;
  const failure = fusionFailure(claimSegment);
  if (failure !== undefined) return out("FAIL", failure, falseConsensus);
  if (!unchanged) return out("FAIL", "the checkout changed", falseConsensus);
  if (own === null) return out("FAIL", "no claim decision was reported for the false claim", falseConsensus);
  if (own[1] === "SUPPORTED") return out("FAIL", `Fusion accepted a claim its fixture refutes (investigators: ${support} support, ${against} contradict)`, falseConsensus);
  if (accepted !== "") return out("FAIL", accepted, falseConsensus);
  // Real, independent provider turns: one snapshot for two investigators, both answered.
  const snapshot = /^ {2}Evidence snapshot: sha256:[0-9a-f]{12}… given identically to 2 investigators, each in its own view copy and session; none saw another's conclusion$/mu.test(claimSegment);
  const answered = /^ {2}Independent hypotheses: (\d+) of (\d+) answered/mu.exec(claimSegment);
  if (!snapshot || answered === null || answered[1] !== "2" || answered[2] !== "2")
    return out("FAIL", `the false claim's check did not run two independent provider turns (${answered === null ? "no hypotheses" : `${answered[1]} of ${answered[2]} answered`})`, falseConsensus);
  // Fusion's own deterministic check against the claim, and the claim's status taken from it.
  const checks = contradicting(claimSegment).filter(r => r.hypothesis === undefined);
  if (checks.length === 0) return out("FAIL", "Fusion ran no check of its own that contradicts the false claim", falseConsensus);
  if (own[1] !== "CONTRADICTED") return out("FAIL", `the claim ended ${own[1]} although Fusion's own check contradicts it`, falseConsensus);
  const models = support > 0 ? `Fusion refused the ${support} investigator(s) that supported it${falseConsensus ? " (a false consensus)" : ""}`
    : "the investigators rejected it too; the case where they support it is proven deterministically by the black box";
  return out("PASS", `CONTRADICTED by ${checks.length} Fusion check(s), whatever the models concluded (investigators: ${support} support, ${against} contradict): ${models}` +
    `${refusedElsewhere.length > 0 ? `; elsewhere in the run Fusion's checks refused ${refusedElsewhere.join(", ")}` : ""}`, falseConsensus);
}

/**
 * L4 — a real fresh falsifier turn: in the run's claim checks, a fresh reviewer tried to break a conclusion, its report was
 * read, its checks run by Fusion and its result adjudicated (the lead's diagnosis came after it). PASS means that happened and no
 * mechanically established blocker was ignored — NOT that the falsifier agreed: its objections are reported and stay open.
 * FAIL (fail-closed) when any attempted falsification produced no report (a provider failure, a step or input limit, a reply
 * that broke Fusion's structure), when one could not run for Fusion's own reasons (no fresh reviewer, budget, route stop), or
 * when a conclusion a falsifier check contradicted was still reported SUPPORTED. REVIEW only when no claim check of the run had a
 * conclusion to break. Deterministic checks supporting the conclusion never stand in for the falsifier.
 */
export function judgeL4(segments) {
  const ran = segments.filter(s => /^ {2}Fresh falsification \(.+\): verdict (?:holds|broken|unclear) — it tried to break: /mu.test(s) &&
    /→ fresh falsification(?: \([^)]*\))? → lead diagnosis$/mu.test(routeLines(s).at(-1) ?? ""));
  // Attempted but no usable report: a failed turn (with Fusion's category) or a reply that broke Fusion's structure.
  const noReport = segments.flatMap(s => [
    ...[...s.matchAll(/^ {2}Fresh falsification \(.+?\): no report — ([^:]+):/gmu)].map(m => `no report (${m[1]})`),
    ...[...s.matchAll(/^ {2}Fresh falsification \(.+?\): a reply that did not follow Fusion's structure \(([^)]*)\)/gmu)].map(m => `an unusable reply (${m[1]})`)]);
  // Not run for Fusion's own reasons (never for "nothing to break").
  const notRun = segments.flatMap(s => [...s.matchAll(/^ {2}Fresh falsification: not run — (.+)$/gmu)].map(m => m[1])
    .filter(reason => !/^(?:no conclusion to break|already contradicted by Fusion's checks)$/u.test(reason)));
  const evidence = segments.flatMap(s => [...routeLines(s), ...lines(s, /^ {2}Fresh falsification.+$/gmu), ...lines(s, /^ {4}(?:counterexample|missing evidence) \(untrusted\).+$/gmu),
    ...lines(s, /^ {4}k\d+ .+\(proposed by [^)]*falsifier[^)]*\)$/gmu)]);
  // A falsifier check that contradicted a conclusion Fusion then still reported SUPPORTED: a blocker ignored.
  const ignored = segments.some(s => contradicting(s, "falsifier").some(r =>
    r.hypothesis === undefined ? claimLine(s)?.[1] === "SUPPORTED" : leadingHypothesis(s) === r.hypothesis));
  if (ignored) return verdict("FAIL", "a conclusion a falsifier check contradicted was still reported SUPPORTED", evidence);
  if (noReport.length > 0 || notRun.length > 0)
    return verdict("FAIL", `the falsification did not run or failed: ${[...noReport, ...notRun.map(r => `not run (${r})`)].join("; ")}` +
      `${ran.length > 0 ? `; ${ran.length} other falsification(s) ran` : ""}`, evidence);
  if (ran.length > 0) {
    const broke = segments.some(s => contradicting(s, "falsifier").length > 0);
    const counters = ran.reduce((n, s) => n + lines(s, /^ {4}counterexample \(untrusted\).+$/gmu).length, 0);
    const missing = ran.reduce((n, s) => n + lines(s, /^ {4}missing evidence \(untrusted\).+$/gmu).length, 0);
    return verdict("PASS", `a fresh falsification ran in ${ran.length} claim check(s) and was adjudicated${broke ? "; one of its checks broke a conclusion" : ""}` +
      `${counters + missing > 0 ? `; its objections (${counters} counterexample(s), ${missing} missing-evidence) stay open, untrusted` : ""}`, evidence);
  }
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
