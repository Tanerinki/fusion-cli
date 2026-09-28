// v0.3 live acceptance — the VERDICTS of L2 and L4, decided from the transcript segments the runner recorded (the real
// shell's own lines: Route:, Turns:, Explorer investigations:, the explorer failure lines, the verification's claim and
// coverage, the change task, the build plan). Pure: it starts nothing and reads nothing. Used by
// scripts/v03-live-acceptance.mjs; pinned by test/v03-live-verdicts.test.ts.
//
// L2 is judged by the route contract of docs/v0.3-adaptive-orchestration.md, not by the wording of one ideal route:
//   - a delegated team route: parallel investigations, then the lead's synthesis, then a fresh review (neither failed);
//   - a transiently failed investigation is repeated ONCE within the retry budget ("One investigation fails transiently …
//     Repeated once within the retry budget; siblings' reports stand"): a route whose failed investigations all answered
//     after their bounded repeat is a PASS, and says so;
//   - an investigation that never answered (its repeat failed too, or it was not repeatable) is a FAIL: the parallel
//     investigation did not deliver, whatever the synthesis made of the rest;
//   - the lead answering directly stays a CHECK (a finding about its choice, not a failure); the clone must be unchanged.
//
// L4's evidence is judged by the handoff contract: the change task is bound to the finding the verification checked (the
// same finding), and it carries the host's evidence of that verification — the shared files the investigations cited, or
// the shared files the lead's own verification answer cited — and those files are the ones the verification reported.

const routeLines = segment => (segment.match(/^ {2}Route: .+$/gmu) ?? []).map(l => l.trim());
const turnLines = segment => (segment.match(/^ {2}Turns: .+$/gmu) ?? []).map(l => l.trim());
const fusionFailure = segment => /^fusion: .+$/mu.exec(segment)?.[0];
const sum = (values) => values.reduce((total, value) => total + value, 0);

/** The recorded lines of L2 worth pasting back: route, turns, planning, investigations, each failed attempt, evidence. */
export function l2Lines(segment) {
  return [...routeLines(segment), ...turnLines(segment),
    ...(segment.match(/^ {2}(?:Planning|Explorer investigations|Evidence|\(the explorer binding|\(explorer for).+$/gmu) ?? []).map(l => l.trim())];
}

/** L2: `{ status: "PASS" | "CHECK" | "FAIL", detail }` for the segment of `analyze the whole repository`. */
export function judgeL2(segment, unchanged) {
  const failure = fusionFailure(segment);
  if (failure !== undefined) return { status: "FAIL", detail: failure };
  const route = routeLines(segment).at(-1)?.replace(/^Route: /u, "") ?? "";
  if (/answer directly/u.test(route)) return unchanged
    ? { status: "CHECK", detail: "the lead chose to answer directly (a finding about its choice, not a failure)" }
    : { status: "FAIL", detail: "the lead answered directly and the clone changed" };
  const parts = route.split(" → ");
  const batches = parts.flatMap(p => { const m = /^(\d+) (?:parallel )?investigations?(?: \((\d+) failed\))?$/u.exec(p); return m ? [{ parallel: / parallel /u.test(p), count: Number(m[1]), failed: Number(m[2] ?? 0) }] : []; });
  const repeats = parts.flatMap(p => { const m = /^(\d+) repeats?(?: \((\d+) failed\))?$/u.exec(p); return m ? [{ count: Number(m[1]), failed: Number(m[2] ?? 0) }] : []; });
  const explorers = /^ {2}Explorer investigations: (\d+) of (\d+) answered/mu.exec(segment);
  const [answered, total] = explorers === null ? [0, 0] : [Number(explorers[1]), Number(explorers[2])];
  const firstFailed = sum(batches.map(b => b.failed)), repeated = sum(repeats.map(r => r.count));
  const reasons = [];
  if (!batches.some(b => b.parallel)) reasons.push("no parallel investigations ran");
  if (parts.slice(-2).join(" → ") !== "lead synthesis → fresh review") reasons.push("the route did not end with lead synthesis → fresh review");
  if (total === 0) reasons.push("no investigation state was reported");
  else if (answered < total) reasons.push(`${total - answered} of ${total} investigation(s) never answered, after the bounded repeat (see the explorer lines)`);
  if (repeated > firstFailed) reasons.push("more repeats than failed investigations (the repeat is bounded to once each)");
  if (!unchanged) reasons.push("the clone changed");
  if (reasons.length > 0) return { status: "FAIL", detail: reasons.join("; ") };
  return { status: "PASS", detail: firstFailed === 0
    ? "parallel investigations, lead synthesis, fresh review; clone unchanged: true"
    : `parallel investigations with bounded recovery (${firstFailed} failed, ${repeated} repeated once, ${answered} of ${total} answered), ` +
      "lead synthesis, fresh review; clone unchanged: true" };
}

const clean = text => text.replace(/\s+/gu, " ").trim();
/** Whether the change task's finding is the one the verification checked (the claim line is clipped at 200 characters). */
function sameFinding(taskFinding, claim) {
  const [t, c] = [clean(taskFinding), clean(claim)];
  return c.endsWith("…") ? t.startsWith(c.slice(0, -1)) : t === c;
}

/**
 * L4's evidence: `{ ok, detail }` from the verification segment (`is the … finding really a problem?`) and the change
 * segment (`fix it`). The task must name the verified finding and carry the verification's host evidence, and those files
 * must be what the verification cited.
 */
export function judgeL4Evidence(verification, change) {
  const claim = /^Checking whether this holds \(read-only\): (.+)$/mu.exec(verification)?.[1];
  const task = /^Preparing a verified change: Fix this finding from the analysis: (.+)$/mu.exec(change)?.[1];
  const carried = /^\(Fusion's (investigation|verification) of this finding cited: ([^)]+)\)$/mu.exec(change);
  if (claim === undefined) return { ok: false, detail: "no verification of a finding" };
  if (task === undefined || !sameFinding(task, claim)) return { ok: false, detail: "the change task is not bound to the verified finding" };
  if (carried === null) return { ok: false, detail: "the change task carries no evidence of the verification" };
  const files = carried[2].split(", ").map(f => f.trim()).filter(Boolean);
  if (carried[1] === "investigation") {
    const investigated = /investigation/u.test(routeLines(verification).join(" ")) && /^ {2}Claim checked: /mu.test(verification);
    return investigated ? { ok: true, detail: `investigation: ${files.join(", ")}` }
      : { ok: false, detail: "the task names an investigation the verification did not run" };
  }
  // The lead verified the finding itself: its evidence is the shared files its answer cited, as the coverage reported them.
  const cited = /^ {2}Cited in the final answer: \d+ files? from the shared copy \((.+)\)$/mu.exec(verification)?.[1];
  if (cited === undefined) return { ok: false, detail: "the verification cited no shared file" };
  const truncated = cited.endsWith(", …");
  const shown = (truncated ? cited.slice(0, -3) : cited).split(", ").map(f => f.trim()).filter(Boolean);
  const matches = truncated ? shown.every((f, i) => files[i] === f) && files.length >= shown.length
    : files.length === shown.length && shown.every((f, i) => files[i] === f);
  return matches ? { ok: true, detail: `verification: ${files.join(", ")}` }
    : { ok: false, detail: `the task's evidence (${files.join(", ")}) is not what the verification cited (${shown.join(", ")})` };
}
