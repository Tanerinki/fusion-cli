// v0.5 live acceptance — the verdicts, decided MECHANICALLY from Fusion's own bound run records (scripts/v05-live-records.mjs)
// and Fusion's own output lines; never from model text. Used by scripts/v05-live-acceptance.mjs; pinned by
// test/v05-live-verdicts.test.ts. No verdict here depends on a real model making a mistake.
//
// Each verdict is PASS, FAIL or REVIEW (the run could not show the part — e.g. you declined a question, or both candidates
// converged so no difference was there to see — which needs a look, never counted as a pass).
const verdict = (status, detail, evidence = []) => ({ status, detail, lines: evidence });
const all = parts => Object.entries(parts).map(([k, ok]) => `${k}=${ok ? "yes" : "NO"}`).join(" ");

/** L1 — a simple change stays single-path: its plan shows no tournament. */
export function judgeL1(planSegment) {
  const plan = /^Build plan$/mu.test(planSegment), tournament = /^Candidates: /mu.test(planSegment);
  const evidence = [...planSegment.matchAll(/^(?:Risk|Workflow|Candidates): .+$/gmu)].map(m => m[0]);
  if (tournament) return verdict("FAIL", "the simple change's plan runs a tournament", evidence);
  return plan ? verdict("PASS", "the plan shows one candidate (no tournament)", evidence)
    : verdict("REVIEW", "no build plan was shown for the simple change", evidence);
}

/** L2 — a real tournament: frozen common snapshot, two independent real candidate proposals in separate contexts, the primary unchanged. */
export function judgeL2(facts) {
  const t = facts.tournament;
  const parts = {
    routed: facts.route?.route === "tournament" && facts.route.candidates >= 2,
    frozen: t?.started !== null && t?.started !== undefined && /^[0-9a-f]{64}$/u.test(t.started.profileSha256 ?? "") && /^[0-9a-f]{64}$/u.test(t.started.snapshotSha256 ?? ""),
    proposals: (t?.candidates ?? []).filter(c => c.proposals > 0).length >= 2,
    separateContexts: (t?.candidates ?? []).filter(c => c.modelTurns > 0).length >= 2,
    primaryUnchanged: t?.primaryUnchanged === true,
  };
  const evidence = t ? [`route ${facts.route?.route} · ${facts.route?.candidates} candidates (${facts.route?.source})`,
    `profile ${t.started?.profileSha256?.slice(0, 12) ?? "none"} · snapshot ${t.started?.snapshotSha256?.slice(0, 12) ?? "none"} · reproduced ${t.started?.reproduced}`,
    ...t.candidates.map(c => `${c.id}: ${c.proposals} proposal(s), ${c.modelTurns} model turn(s) in its own context`)] : [];
  if (!parts.routed) return verdict("FAIL", `the fix was not run as a tournament (${all(parts)})`, evidence);
  return verdict(Object.values(parts).every(Boolean) ? "PASS" : "FAIL", all(parts), evidence);
}

/** L3 — both candidates materialized in isolated Fusion-owned workspaces and faced the same frozen common verification mesh. */
export function judgeL3(facts) {
  const candidates = facts.tournament?.candidates ?? [];
  const materialized = candidates.filter(c => c.applied);
  const checks = new Set(materialized.map(c => JSON.stringify(c.checks)));
  const experiments = new Set(materialized.filter(c => c.nodes.length > 0).map(c => JSON.stringify(c.nodes.map(n => n.id))));
  const parts = {
    materialized: materialized.length >= 2,
    sameChecks: materialized.length >= 2 && checks.size === 1 && JSON.parse([...checks][0] ?? "[]").length > 0,
    sameExperiments: experiments.size <= 1,
    oneProfile: new Set(candidates.filter(c => c.profileSha256 !== null).map(c => c.profileSha256)).size === 1,
  };
  const evidence = candidates.map(c => `${c.id}: ${c.applied ? "materialized" : "not materialized"}; checks ${c.checks.join(", ") || "none"}; ` +
    `experiments ${c.nodes.map(n => `${n.id}=${n.result}`).join(", ") || "none"}`);
  if (materialized.length < 2 && candidates.some(c => c.failure !== null))
    return verdict("REVIEW", `a candidate's author failed before materialization (${all(parts)})`, evidence);
  return verdict(Object.values(parts).every(Boolean) ? "PASS" : "FAIL", all(parts), evidence);
}

/** L4 — Fusion's deterministic experiment separates KNOWN fixture candidates in the real confined backend (no model involved). */
export function judgeL4(discrimination) {
  const d = discrimination;
  const evidence = d ? [`acceptance ${d.acceptance}`, `known good candidate: ${d.good}`, `known behaviour-changing candidate: ${d.bad}`] : [];
  if (d === undefined || d === null) return verdict("FAIL", "the discrimination check did not run", evidence);
  if (d.acceptance !== "granted") return verdict("REVIEW", "confined verification was not granted here, so this is not a live result", evidence);
  const parts = { goodPasses: d.good === "pass", changedFails: d.bad === "fail" };
  return verdict(Object.values(parts).every(Boolean) ? "PASS" : "FAIL", all(parts), evidence);
}

/** L5 — selection by Fusion's evidence (or your tie choice), never a model's preference; the winner revalidated freshly. */
export function judgeL5(facts) {
  const t = facts.tournament;
  const d = t?.decided;
  const evidence = t ? [`outcome ${d?.outcome ?? "none"}${d?.selected ? ` · ${d.selected} selected (${d.chosenBy})` : ""}`,
    `binding ${t.resolved ? "resolved" : `UNRESOLVED: ${t.reason ?? ""}`}`,
    `revalidation ${t.revalidation ? `${t.revalidation.candidate} ${t.revalidation.deliverable ? "deliverable" : "not deliverable"}` : "none"}`,
    ...t.reasons.map(r => `reason: ${r}`)] : [];
  if (t === null || t === undefined || d === null || d === undefined) return verdict("FAIL", "no tournament decision was recorded", evidence);
  if (!t.resolved) return verdict("FAIL", `the decision's binding does not hold: ${t.reason}`, evidence);
  if (d.selected === undefined)
    return verdict("REVIEW", `no candidate was selected (${d.outcome}): selection and revalidation were not shown`, evidence);
  const parts = {
    byEvidence: d.chosenBy === "fusion" || d.chosenBy === "human",
    revalidated: t.revalidation !== null && t.revalidation.candidate === d.selected && t.revalidation.revision === d.selectedRevision,
    deliverable: d.outcome !== "DELIVERY_ELIGIBLE" || t.revalidation?.deliverable === true,
  };
  if (d.outcome === "REVALIDATION_MISMATCH" && parts.revalidated) return verdict("REVIEW", "the fresh revalidation failed and blocked the delivery", evidence);
  return verdict(Object.values(parts).every(Boolean) && d.outcome === "DELIVERY_ELIGIBLE" ? "PASS" : "FAIL", `${all(parts)} outcome=${d.outcome}`, evidence);
}

/** L6 — the selected candidate went through the unchanged Delivery, your approval and Apply; protected fixtures unchanged, only the intended file changed. */
export function judgeL6(facts, changeSegment, fixtureOk) {
  const applied = /^Result: applied/mu.test(changeSegment);
  const declined = /^Result: not applied/mu.test(changeSegment) || /Nothing was applied/u.test(changeSegment);
  const evidence = [...changeSegment.matchAll(/^(?:Decision|Result|Delivery): .+$/gmu)].map(m => m[0]);
  if (facts.tournament?.decided?.outcome !== "DELIVERY_ELIGIBLE")
    return verdict("REVIEW", `no delivery was eligible (${facts.tournament?.decided?.outcome ?? "no tournament"})`, evidence);
  if (!applied) return verdict(declined ? "REVIEW" : "FAIL", declined ? "you did not approve the apply" : "the delivery was not applied", evidence);
  const parts = { delivery: facts.deliveryId !== null, applied, fixture: fixtureOk === true };
  return verdict(Object.values(parts).every(Boolean) ? "PASS" : "FAIL", all(parts), evidence);
}

/** The overall verdict: FAIL if any part failed or a sentinel leaked, else REVIEW if any part needs a look, else PASS. */
export function overall(results, sentinelsSeen) {
  if (sentinelsSeen.length > 0 || results.some(r => r.status === "FAIL" || r.status === "NOT RUN")) return "FAIL";
  return results.some(r => r.status === "REVIEW") ? "REVIEW" : "PASS";
}
