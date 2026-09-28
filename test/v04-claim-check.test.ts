import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DIAGNOSIS_INSTRUCTION, HYPOTHESIS_INSTRUCTION } from "../src/app/orchestration/claim-check.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { newSessionState, planTurn } from "../src/app/session.js";
import { runCli, type CliHost } from "../src/cli/run.js";
import type { ConversationTurnRequest } from "../src/core/conversation.js";
import { claimClause, classifyIntent } from "../src/core/intent.js";
import { derivedChecks, fileCheckFrom, HYPOTHESIS_LIMITS, hypothesisReportFrom } from "../src/core/orchestration/hypotheses.js";
import { fakeConversationRegistry, type FakeTurn } from "./fixtures/fake-conversation.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.4 PR C — HYPOTHESIS ISOLATION AND DISCRIMINATING EXPERIMENTS, as executable invariants: one immutable snapshot handed
 * identically to independent investigators that never see each other's conclusion; checks Fusion authorizes and runs itself on
 * the shared copy; a claim's status decided by those checks — never by the models' agreement.
 */
const skip = gitAvailable ? false : "git executable unavailable";
interface Ran { code: number; stdout: string; stderr: string; questions: string[] }
async function shell(cwd: string, registry: ProviderRegistry, lines: Array<string | null>, env: NodeJS.ProcessEnv, extra: Partial<CliHost> = {}): Promise<Ran> {
  let stdout = "", stderr = "";
  const queue = [...lines], questions: string[] = [];
  const code = await runCli([], { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: true,
    prompt: async question => { questions.push(question); return queue.length > 0 ? queue.shift()! : null; } }, { env, cwd, registry, ...extra });
  return { code, stdout, stderr, questions };
}
async function withRepo<T>(files: Readonly<Record<string, string>>, work: (root: string, env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v04-claims-")));
  try {
    const root = join(dir, "repo");
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
      await writeFile(join(root, ...path.split("/")), content);
    }
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "base");
    return await work(root, { ...process.env, LOCALAPPDATA: join(dir, "state-local"), XDG_STATE_HOME: join(dir, "state-xdg") });
  } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
const HA = {
  "configuration.yaml": "homeassistant:\n  name: Home\n# trusted_proxies is configured further below (see the http block)\nhttp:\n  use_x_forwarded_for: true\n",
  "automations.yaml": "- id: motion_hallway\n  alias: Hallway\n",
  "secrets.yaml": "mqtt_password: V04-SECRET-7788\n",
  "README.md": "# Home config\n",
};
const report = (patch: Record<string, unknown>) => JSON.stringify({ hypothesis: "h", summary: "s", evidence: [{ claim: "read it", paths: ["configuration.yaml"] }],
  checks: [], alternatives: [], ...patch });
const hypothesisTurns = (turns: readonly FakeTurn[]) => turns.filter(t => t.request.instruction === HYPOTHESIS_INSTRUCTION.verify || t.request.instruction === HYPOTHESIS_INSTRUCTION.diagnose);
/** A reply chosen by the investigator's id in its context (parallel turns may reach the fake in any order). */
const byInvestigator = (replies: Readonly<Record<string, string | (() => string | Readonly<{ error: { kind: "ProcessFailure"; retryable: true; safeMessage: string } }>)>>) =>
  (request: ConversationTurnRequest) => {
    const id = /^Investigator: (h\d) /mu.exec(request.context)?.[1] ?? "?";
    const reply = replies[id] ?? "no reply scripted";
    return typeof reply === "function" ? reply() : reply;
  };
const removed = async (path: string): Promise<boolean> => (await readdir(dirname(path)).catch(() => [] as string[])).every(name => !path.endsWith(name));
const withoutId = (context: string) => context.replace(/\nInvestigator: h\d \(one of \d; you will not see the others' work\)$/u, "");

// ---------------------------------------------------------------- contracts

test("v0.4 hypothesis contract: a closed, bounded report; checks are exact one-line literals in relative files", () => {
  const ok = hypothesisReportFrom({ verdict: "supported", hypothesis: "It is missing.", summary: "Read it.", evidence: [{ claim: "no entry", paths: ["./configuration.yaml"] }],
    checks: [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }, { file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }],
    alternatives: ["a proxy elsewhere", "a proxy elsewhere"] }, "verify");
  assert.equal(ok.accepted, true);
  if (ok.accepted) {
    assert.deepEqual(ok.report.checks, [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }], "duplicates collapse");
    assert.deepEqual([ok.report.evidence[0]!.paths, ok.report.alternatives], [["configuration.yaml"], ["a proxy elsewhere"]]);
  }
  const refused = (value: unknown, mode: "verify" | "diagnose" = "verify") => { const r = hypothesisReportFrom(value, mode); return r.accepted ? "accepted" : r.category; };
  const base = { verdict: "supported", hypothesis: "x", summary: "y", evidence: [], checks: [] };
  assert.equal(refused({ ...base, extra: 1 }), "schema mismatch");
  assert.equal(refused({ hypothesis: "x", summary: "y", evidence: [], checks: [] }), "verdict missing");
  assert.equal(refused({ hypothesis: "x", summary: "y", evidence: [], checks: [] }, "diagnose"), "accepted", "a diagnosis has no claim to judge");
  assert.equal(refused({ ...base, verdict: "probably" }), "unknown verdict");
  assert.equal(refused({ ...base, checks: [1, 2, 3, 4] }), "too many checks");
  for (const check of [{ file: "/etc/passwd", text: "root", expect: "present" }, { file: "a.yaml", text: "two\nlines", expect: "present" },
    { file: "a.yaml", text: "", expect: "present" }, { file: "a.yaml", text: "x", expect: "maybe" }, { file: "../a", text: "x", expect: "absent" },
    { file: "a.yaml", text: "x".repeat(HYPOTHESIS_LIMITS.maxCheckTextChars + 1), expect: "present" }, { file: "a.yaml", text: "x", expect: "present", run: "rm -rf /" }])
    assert.equal(fileCheckFrom(check), undefined, JSON.stringify(check));
  assert.equal(refused({ ...base, hypothesis: "x".repeat(HYPOTHESIS_LIMITS.maxHypothesisChars + 1) }), "hypothesis too long");
});

test("v0.4 derived checks: Fusion tests a claim's own words only when they are unambiguous", () => {
  assert.deepEqual(derivedChecks("configuration.yaml already sets `trusted_proxies` and `use_x_forwarded_for`", ["configuration.yaml"]),
    [{ file: "configuration.yaml", text: "trusted_proxies", expect: "present" }, { file: "configuration.yaml", text: "use_x_forwarded_for", expect: "present" }]);
  assert.deepEqual(derivedChecks("configuration.yaml has no `trusted_proxies`", ["configuration.yaml"]), [], "a negation derives nothing");
  assert.deepEqual(derivedChecks("`trusted_proxies` is set in a.yaml or b.yaml", ["a.yaml", "b.yaml"]), [], "two files derive nothing");
  assert.deepEqual(derivedChecks("configuration.yaml is fine", ["configuration.yaml"]), [], "no literal derives nothing");
  assert.equal(claimClause("Is it true that configuration.yaml already sets `trusted_proxies`?"), "configuration.yaml already sets `trusted_proxies`");
  assert.equal(claimClause("stimmt es, dass die Automationen doppelt sind?"), "die Automationen doppelt sind");
  const intent = classifyIntent("is it true that configuration.yaml already sets `trusted_proxies`?");
  assert.deepEqual([intent.claim, intent.reference], ["configuration.yaml already sets `trusted_proxies`", undefined]);
  assert.equal(classifyIntent("check whether the second one is true").claim, undefined, "a clause about a finding is not the user's own claim");
  const state = newSessionState();
  const plan = planTurn(intent, state, "git");
  assert.deepEqual(plan, { kind: "verify", claim: "configuration.yaml already sets `trusted_proxies`", source: "user", message: intent.text });
  assert.deepEqual(planTurn(classifyIntent("why does the http block reject the proxy?"), state, "git"), { kind: "diagnose", message: "why does the http block reject the proxy?" });
  assert.equal(planTurn(classifyIntent("why do you skip tests in CI?"), state, "git").kind, "ask", "not every why is a diagnosis");
  assert.equal(planTurn(classifyIntent("what does package.json do?"), state, "git").kind, "ask");
});

// ---------------------------------------------------------------- the claim check in the shell

test("v0.4 invariant 6: independent hypotheses see ONE identical snapshot and never each other's conclusion; they run in parallel",
  { skip }, async () => withRepo(HA, async (root, env) => {
    let arrived = 0;
    let release!: () => void;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    const fake = fakeConversationRegistry({
      during: async turn => {
        if (turn.request.instruction !== HYPOTHESIS_INSTRUCTION.verify) return;
        if (++arrived === 2) release();
        await Promise.race([barrier, new Promise((_, reject) => setTimeout(() => reject(new Error("the hypotheses did not run at the same time")), 20_000).unref())]);
      },
      replies: {
        Lead: ["The config lacks trusted_proxies.\n\nFindings:\n1. configuration.yaml: `http` has `use_x_forwarded_for` but no `trusted_proxies`.",
          "Both checks agree: trusted_proxies is missing. LEAD-DIAGNOSIS"],
        Explorer: Array(2).fill(byInvestigator({
          h1: report({ verdict: "supported", hypothesis: "HYPOTHESIS-ONE", checks: [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }] }),
          h2: report({ verdict: "supported", hypothesis: "HYPOTHESIS-TWO", checks: [{ file: "configuration.yaml", text: "use_x_forwarded_for: true", expect: "present" }] }) })) } });
    const ran = await shell(root, fake.registry, ["analyze this configuration", "is the first finding really a problem?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    const hyps = hypothesisTurns(fake.turns);
    assert.equal(hyps.length, 2);
    assert.equal(withoutId(hyps[0]!.request.context), withoutId(hyps[1]!.request.context), "the same snapshot, byte for byte");
    assert.notEqual(hyps[0]!.workspace, hyps[1]!.workspace, "each in its own view copy");
    for (const t of hyps) {
      assert.deepEqual(t.request.history, [], "no transcript");
      assert.doesNotMatch(JSON.stringify(t.request), /HYPOTHESIS-(?:ONE|TWO)|LEAD-DIAGNOSIS|The config lacks/u, "no other conclusion, no lead text");
      assert.ok(!t.viewText.includes("V04-SECRET-7788"), "the secret is never shared");
    }
    const diagnosis = fake.turns.find(t => t.request.instruction === DIAGNOSIS_INSTRUCTION)!;
    assert.ok(fake.turns.indexOf(diagnosis) > fake.turns.indexOf(hyps[1]!), "comparison only after every hypothesis");
    assert.match(diagnosis.request.context, /HYPOTHESIS-ONE/u);
    assert.match(diagnosis.request.context, /HYPOTHESIS-TWO/u);
    assert.match(diagnosis.request.context, /^k1 configuration\.yaml lacks "trusted_proxies:" — NO: as predicted → supports the claim \(proposed by h1\)$/mu);
    assert.match(ran.stdout, /^ {2}Route: evidence snapshot → 2 independent hypotheses → 2 Fusion checks → lead diagnosis$/mu);
    assert.match(ran.stdout, /^ {2}Turns: 3 model turns \(lead 1 · explorers 2\) · 1 batch \(1 parallel\) · /mu);
    assert.match(ran.stdout, /^ {2}Evidence snapshot: sha256:[0-9a-f]{12}… given identically to 2 investigators, each in its own view copy and session; none saw another's conclusion$/mu);
    assert.match(ran.stdout, /^ {2}Claim: SUPPORTED — Fusion's own checks support it \(2\) and none contradicts it \(investigators: 2 support, 0 contradict\)$/mu);
  }));

test("v0.4 C (false consensus): two investigators agree on a wrong claim — Fusion's check contradicts it and Fusion refuses it",
  { skip }, async () => withRepo(HA, async (root, env) => {
    const fake = fakeConversationRegistry({ replies: {
      Lead: ["It is set.\n\nFindings:\n1. configuration.yaml: trusted_proxies is configured in the http block.", "The claim holds; trusted_proxies is set. WRONG-CONSENSUS"],
      Explorer: Array(2).fill(byInvestigator({
        h1: report({ verdict: "supported", hypothesis: "trusted_proxies is set", checks: [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "present" }] }),
        h2: report({ verdict: "supported", hypothesis: "the comment says it is set", checks: [] }) })) } });
    const ran = await shell(root, fake.registry, ["analyze this configuration", "is the first finding really true?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /WRONG-CONSENSUS/u, "the lead's answer is shown as model output");
    assert.match(ran.stdout, /^ {4}k1 configuration\.yaml contains "trusted_proxies:" \.\.\. NO → CONTRADICTS the claim \(proposed by h1\)$/mu);
    assert.match(ran.stdout, /^ {2}Claim: CONTRADICTED — Fusion's own checks contradict it \(1\); Fusion does not accept it, whatever the models concluded \(investigators: 2 support, 0 contradict\)$/mu);
    assert.doesNotMatch(ran.stdout, /Claim: SUPPORTED/u);
  }));

test("v0.4 L3 shape: the user's own claim is checked as stated — Fusion's check from the claim's words contradicts it even when no model does",
  { skip }, async () => withRepo(HA, async (root, env) => {
    const fake = fakeConversationRegistry({ replies: {
      Lead: ["Yes, it is configured."],
      Explorer: [report({ verdict: "supported", hypothesis: "the comment says so" }), report({ verdict: "supported", hypothesis: "it is below" })] } });
    const ran = await shell(root, fake.registry, ["is it true that configuration.yaml already sets `trusted_proxies`?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Checking whether this holds \(read-only\): configuration\.yaml already sets `trusted_proxies`$/mu);
    assert.match(ran.stdout, /^ {4}k1 configuration\.yaml contains "trusted_proxies" \.\.\. YES → supports the claim \(proposed by fusion\)$/mu,
      "the comment line contains the literal: a check is exactly as good as its prediction, and Fusion shows it");
    const strict = fakeConversationRegistry({ replies: { Lead: ["Yes."], Explorer: [report({ verdict: "supported" }), report({ verdict: "supported" })] } });
    const second = await shell(root, strict.registry, ["is it true that configuration.yaml already sets `trusted_proxies: 10.0.0.2`?", "exit"], env);
    assert.match(second.stdout, /^ {4}k1 configuration\.yaml contains "trusted_proxies: 10\.0\.0\.2" \.\.\. NO → CONTRADICTS the claim \(proposed by fusion\)$/mu);
    assert.match(second.stdout, /^ {2}Claim: CONTRADICTED — /mu);
    assert.equal(second.stdout.includes("Fix this finding"), false);
  }));

test("v0.4 B (hard debug): two different hypotheses → Fusion's checks distinguish them → one diagnosis survives", { skip }, async () =>
  withRepo(HA, async (root, env) => {
    const fake = fakeConversationRegistry({ replies: {
      Lead: ["The proxy is not trusted: trusted_proxies is missing.\n\nFindings:\n1. configuration.yaml: add `trusted_proxies`."],
      Explorer: Array(2).fill(byInvestigator({
        h1: report({ hypothesis: "trusted_proxies is missing from the http block", checks: [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }],
          alternatives: ["the proxy sends no forwarded header"] }),
        h2: report({ hypothesis: "use_x_forwarded_for is disabled", checks: [{ file: "configuration.yaml", text: "use_x_forwarded_for: false", expect: "present" }] }) })) } });
    const ran = await shell(root, fake.registry, ["why does Home Assistant reject requests from my reverse proxy?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Diagnosing \(read-only\): why does Home Assistant reject requests from my reverse proxy\?$/mu);
    const hyps = hypothesisTurns(fake.turns);
    assert.deepEqual(hyps.map(t => t.request.instruction), [HYPOTHESIS_INSTRUCTION.diagnose, HYPOTHESIS_INSTRUCTION.diagnose]);
    assert.match(ran.stdout, /^ {4}k1 configuration\.yaml lacks "trusted_proxies:" \.\.\. NO → supports hypothesis h1 \(proposed by h1\)$/mu);
    assert.match(ran.stdout, /^ {4}k2 configuration\.yaml contains "use_x_forwarded_for: false" \.\.\. NO → CONTRADICTS hypothesis h2 \(proposed by h2\)$/mu);
    assert.match(ran.stdout, /^ {2}Diagnosis: h1 SUPPORTED by Fusion's checks — trusted_proxies is missing from the http block; h2 CONTRADICTED$/mu);
    assert.match(ran.stdout, /^Next: "explain the first finding"/mu, "the diagnosis's findings are what follow-ups refer to");
  }));

test("v0.4 secrets: a check can never become an oracle — withheld files are refused, masked values never match", { skip }, async () =>
  withRepo({ ...HA, "configuration.yaml": `${HA["configuration.yaml"]}mqtt:\n  password: V04-INLINE-5566\n`, ".storage/auth": '{"token":"V04-AUTH-9911"}\n' },
    async (root, env) => {
      const fake = fakeConversationRegistry({ replies: { Lead: ["done"], Explorer: Array(2).fill(byInvestigator({
        h1: report({ verdict: "supported", checks: [{ file: ".storage/auth", text: "V04-AUTH-9911", expect: "present" },
          { file: "secrets.yaml", text: "V04-SECRET-7788", expect: "present" }, { file: "configuration.yaml", text: "V04-INLINE-5566", expect: "present" }] }),
        h2: report({ verdict: "supported" }) })) } });
      const ran = await shell(root, fake.registry, ["is it true that the mqtt password is weak?", "exit"], env);
      assert.equal(ran.code, 0, ran.stderr);
      assert.match(ran.stdout, /^ {4}k1 \.storage\/auth contains "V04-AUTH-9911" \.\.\. not run \(not shared\)/mu, "a withheld file is never read");
      assert.match(ran.stdout, /^ {4}k2 secrets\.yaml contains "V04-SECRET-7788" \.\.\. NO → CONTRADICTS the claim/mu, "a masked value never matches");
      assert.match(ran.stdout, /^ {4}k3 configuration\.yaml contains "V04-INLINE-5566" \.\.\. NO → CONTRADICTS the claim/mu);
      assert.ok(!fake.turns.some(t => ["V04-SECRET-7788", "V04-INLINE-5566", "V04-AUTH-9911"].some(secret => t.viewText.includes(secret))));
    }));

test("v0.4 invariant 13 (read-only): simple questions stay one lead turn; without a proven explorer a claim check falls back to v0.3",
  { skip }, async () => withRepo(HA, async (root, env) => {
    const simple = fakeConversationRegistry({ replies: { Lead: ["It configures Home Assistant."] } });
    const ran = await shell(root, simple.registry, ["what does configuration.yaml do?", "exit"], env);
    assert.deepEqual(simple.turns.map(t => t.role), ["Lead"]);
    assert.match(ran.stdout, /^ {2}Route: lead only · 1 model turn · /mu);
    const alone = fakeConversationRegistry({ unproven: ["Explorer", "Reviewer"], replies: { Lead: ["It is set."] } });
    const verified = await shell(root, alone.registry, ["is it true that configuration.yaml already sets `trusted_proxies`?", "exit"], env);
    assert.deepEqual(alone.turns.map(t => t.role), ["Lead"], "never an unproven explorer");
    assert.match(verified.stdout, /^ {2}Route: no explorer available → lead only · 1 model turn|^ {2}Route: no explorer available → lead only$/mu);
    assert.doesNotMatch(verified.stdout, /Evidence snapshot/u);
  }));

test("v0.4 invariant 19 (read-only): Ctrl+C during the hypotheses stops both, removes every view copy; the next line works", { skip }, async () =>
  withRepo(HA, async (root, env) => {
    const controller = new AbortController();
    let scope = new AbortController();
    const fake = fakeConversationRegistry({ during: async (turn, signal) => {
      if (turn.request.instruction !== HYPOTHESIS_INSTRUCTION.verify) return;
      scope.abort();
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true }); });
    }, replies: { Lead: ["It configures Home Assistant."] } });
    const ran = await shell(root, fake.registry, ["is it true that configuration.yaml already sets `trusted_proxies`?", "what does configuration.yaml do?", "exit"], env,
      { signal: controller.signal, turnScope: () => { scope = new AbortController(); return { signal: scope.signal, release: () => undefined }; } });
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Cancelled\. Nothing was changed\.$/mu);
    assert.match(ran.stdout, /It configures Home Assistant\./u);
    const started = hypothesisTurns(fake.turns);
    assert.ok(started.length >= 1);
    for (const t of started) assert.ok(await removed(t.workspace), "every hypothesis view copy is removed");
  }));

test("v0.4 containment: a transient hypothesis failure is repeated once; a request failure keeps Fusion's evidence honest", { skip }, async () =>
  withRepo(HA, async (root, env) => {
    let calls = 0;
    const h1 = () => ++calls === 1 ? { error: { kind: "ProcessFailure" as const, retryable: true as const, safeMessage: "The explorer process failed." } }
      : report({ verdict: "supported", checks: [{ file: "configuration.yaml", text: "trusted_proxies:", expect: "absent" }] });
    const fake = fakeConversationRegistry({ replies: {
      Lead: [(request: ConversationTurnRequest) => request.instruction === DIAGNOSIS_INSTRUCTION ? "Diagnosed." : "x"],
      Explorer: Array(3).fill(byInvestigator({ h1, h2: report({ verdict: "contradicted", hypothesis: "it is fine" }) })) } });
    const ran = await shell(root, fake.registry, ["is it true that the http block misses trusted proxies?", "exit"], env);
    assert.equal(ran.code, 0, ran.stderr);
    assert.equal(calls, 2, "h1 failed once and answered on its one repeat");
    assert.match(ran.stdout, /^ {2}Route: evidence snapshot → 2 independent hypotheses \(1 failed\) → 1 repeat → 1 Fusion check → lead diagnosis$/mu);
    assert.match(ran.stdout, /^ {4}\(h1: attempt 1 failed — provider failure: The explorer process failed\. It was repeated once and answered\.\)$/mu);
    assert.match(ran.stdout, /^ {2}Claim: SUPPORTED — /mu);
  }));
