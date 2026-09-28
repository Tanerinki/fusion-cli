import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFindings } from "../src/app/exploration.js";
import { distinctiveTerms, newSessionState, planTurn, selectFinding, type SessionState } from "../src/app/session.js";
import { classifyIntent } from "../src/core/intent.js";
import { classifyMuseTerminalFailure } from "../src/providers/muse/failure-diagnostic.js";

/**
 * v0.3 — FINDING IDENTITY across a conversation, pinned against the maintainer's SECOND real L1–L4 run (2026-09-28,
 * transcript fusion-v03-live-2026-09-28T02-22-58-066Z). Replayed with Fusion's own functions, its L4 went:
 *   1. the analysis answer had a prose `## Problems` section, a numbered "Suggested fixes" list, its proposed build task and
 *      only THEN its `Findings:` list; `parseFindings` took `## Problems` for the list heading and collected the six fixes
 *      plus the first six findings (12, the cap): the numbering was wrong and two real findings were lost;
 *   2. "is the trusted_proxies finding really a problem?" — `trusted_proxies` occurred in two of those items (a fix and the
 *      finding), so no finding was selected, and the line silently ran as a NEW analysis, which replaced the findings and
 *      cleared the focus;
 *   3. "fix it" had nothing to refer to: Fusion asked "What should I change?". No build, no scope, no delivery, no apply —
 *      the fixture failed its checks because NOTHING changed (no trusted_proxies; "only configuration.yaml changed" needs
 *      exactly one change).
 * Now the answer's own `Findings:` list is authoritative, a finding named by its terms is selected deterministically (exactly
 * one, else Fusion asks), and "fix it" means the active, verified finding.
 */
// The second run's analysis, with its real structure (headings, lists and order), wording shortened.
const ANALYSIS = ["I read 5 files.", "", "## What this setup is", "A small Home Assistant configuration.", "", "## Problems", "",
  "**Secrets in git.** The repo tracks `secrets.yaml`, `.storage/` and `home-assistant.log`.", "",
  "**Proxy setting that doesn't work.** `configuration.yaml:12` turns on `use_x_forwarded_for` without listing `trusted_proxies`.", "",
  "**Duplicate automation ID.** Both automations use `id: motion_hallway`.", "", "## Suggested fixes",
  "1. Stop tracking `secrets.yaml`, `.storage/` and `*.log` by adding them to `.gitignore`.", "2. Change any real credential.",
  "3. Either add `trusted_proxies` or remove `use_x_forwarded_for`.", "4. Move the MQTT connection to the UI, or at least use `!secret mqtt_password`.",
  "5. Give the sunset automation its own ID.", "6. Add `\"version\"` to the manifest.", "",
  "Proposed build task: Add a .gitignore, fix the duplicate automation id, add trusted_proxies and remove the inline MQTT credentials.", "",
  "Findings:",
  "1. `secrets.yaml`, `.storage/auth`, `home-assistant.log`: secrets and a logged Bearer token are tracked in git.",
  "2. `configuration.yaml`: the MQTT password is typed inline (line 21) instead of using `!secret mqtt_password`.",
  "3. `configuration.yaml`: `use_x_forwarded_for` without `trusted_proxies` breaks the `http:` config, which the error in `home-assistant.log` confirms.",
  "4. `automations.yaml`: two automations share `id: motion_hallway`.",
  "5. `custom_components/example/manifest.json`: the required `\"version\"` key is missing, so the integration won't load.",
  "6. `configuration.yaml`: MQTT broker, username and password can't be set in YAML on Home Assistant 2022.12 or later.",
  "7. `home-assistant.log`: debug logging records Authorization headers.",
  "8. `automations.yaml`: uses the older `trigger`/`platform`/`service` style."].join("\n");
const TRUSTED = 2;   // 0-based: finding 3
const analysed = (): SessionState => { const state = newSessionState(); state.findings = parseFindings(ANALYSIS); return state; };
const plan = (state: SessionState, line: string) => planTurn(classifyIntent(line), state, "git");
/** What the shell records when the lead verified finding `index` itself and its answer cited these shared files. */
const verifiedByLead = (state: SessionState, index: number, cited: readonly string[]) => {
  state.verified = { index, source: "lead", cited: [...cited], supported: 0, contradicted: 0 };
};

test("findings: the answer's own Findings: list is authoritative — not a prose `## Problems` heading, not a Suggested-fixes list", () => {
  const findings = parseFindings(ANALYSIS);
  assert.equal(findings.length, 8, "exactly the eight findings (the live run parsed 12: six fixes and six findings)");
  assert.match(findings[0]!, /^`secrets\.yaml`/u);
  assert.match(findings[TRUSTED]!, /^`configuration\.yaml`: `use_x_forwarded_for` without `trusted_proxies`/u);
  assert.deepEqual(findings.flatMap((f, i) => f.includes("trusted_proxies") ? [i] : []), [TRUSTED], "one finding mentions trusted_proxies");
  // The list ends where another section starts; a later numbered list is not a finding.
  assert.deepEqual(parseFindings("Findings:\n1. a.yaml: one\n2. b.yaml: two\n\nProposed build task: fix a.yaml.\n\nSteps:\n1. not a finding"), ["a.yaml: one", "b.yaml: two"]);
  // The LAST Findings: list is the answer's conclusion.
  assert.deepEqual(parseFindings("Findings:\n1. draft\n\n## Details\n\nFindings:\n1. final one\n2. final two"), ["final one", "final two"]);
  // Without the label, a generic heading or any numbered line still works (earlier answers stay readable).
  assert.deepEqual(parseFindings("## Problems\n1. p.yaml: one"), ["p.yaml: one"]);
  assert.deepEqual(parseFindings("1. x.yaml: one\n2. y.yaml: two"), ["x.yaml: one", "y.yaml: two"]);
});

test("selection is by whole distinctive terms: exactly one finding, several (ask), none (ask) or no term at all", () => {
  const findings = parseFindings(ANALYSIS);
  assert.deepEqual(selectFinding("is the trusted_proxies finding really a problem?", findings), { kind: "one", index: TRUSTED });
  assert.deepEqual(selectFinding("is the configuration.yaml finding really a problem?", findings), { kind: "ambiguous", indices: [1, 2, 5] });
  assert.deepEqual(selectFinding("is the configuration.yaml trusted_proxies finding real?", findings), { kind: "one", index: TRUSTED }, "every named term");
  assert.deepEqual(selectFinding("is the lodash_merge finding really a problem?", findings), { kind: "unknown", terms: ["lodash_merge"] });
  assert.deepEqual(selectFinding("is the first finding really a problem?", findings), { kind: "none" });
  assert.deepEqual(selectFinding("is the manifest.json finding real?", findings), { kind: "one", index: 4 }, "a path's file name");
  assert.deepEqual(selectFinding("is the proxies finding real?", findings), { kind: "none" }, "a plain word is not a distinctive term");
  assert.ok(!distinctiveTerms("`use_x_forwarded_for_extra` is set").has("use_x_forwarded_for"), "whole tokens, never a substring");
  assert.ok(distinctiveTerms("`http.use_x_forwarded_for`").has("use_x_forwarded_for"), "a dotted key names its identifier");
});

test("A: the trusted_proxies finding becomes active, is verified, and \"fix it\" is exactly that verified finding with its evidence", () => {
  const state = analysed();
  const verify = plan(state, "is the trusted_proxies finding really a problem?");
  assert.equal(verify.kind, "verify", "a verification of an existing finding, not a new analysis");
  assert.deepEqual([(verify as { index: number }).index, (verify as { claim: string }).claim, state.focus], [TRUSTED, state.findings[TRUSTED], TRUSTED]);
  assert.equal(state.findings.length, 8, "the analysis's findings are kept");
  verifiedByLead(state, TRUSTED, ["configuration.yaml", "home-assistant.log"]);
  assert.deepEqual(plan(state, "fix it"), { kind: "change",
    task: `Fix this finding from the analysis: ${state.findings[TRUSTED]}\n\n(Fusion's verification of this finding cited: configuration.yaml, home-assistant.log)` });
});

test("B: a reference several findings match is asked about — no verification, no change, the session unchanged", () => {
  for (const [line, example] of [["is the configuration.yaml finding really a problem?", "is finding 2 really a problem?"],
    ["fix the configuration.yaml finding", "fix finding 2"]] as const) {
    const state = analysed();
    const asked = plan(state, line);
    assert.equal(asked.kind, "clarify", line);
    const question = (asked as { question: string }).question;
    assert.match(question, /^That matches 3 findings of the last analysis:\n {2}2\. `configuration\.yaml`: the MQTT password[^\n]*\n {2}3\. `configuration\.yaml`: `use_x_forwarded_for`[^\n]*\n {2}6\. /u);
    assert.ok(question.includes(`For example: "${example}"`), question);
    assert.deepEqual([state.findings.length, state.focus, state.verified], [8, undefined, undefined], "nothing selected, nothing forgotten");
  }
  // The suggested wording is understood.
  const state = analysed();
  assert.deepEqual([plan(state, "is finding 3 really a problem?").kind, state.focus], ["verify", TRUSTED]);
});

test("C: an unknown finding reference is asked about — never the first finding, never a new analysis", () => {
  for (const line of ["is the lodash_merge finding really a problem?", "fix the lodash_merge finding"]) {
    const state = analysed();
    const asked = plan(state, line);
    assert.equal(asked.kind, "clarify", line);
    assert.match((asked as { question: string }).question, /^No finding of the last analysis mentions `lodash_merge`\. Name one by its number/u);
    assert.deepEqual([state.findings.length, state.focus], [8, undefined]);
  }
  // A question that names no finding at all is still an ordinary question or analysis (unchanged behaviour).
  assert.equal(plan(analysed(), "is package.json really needed?").kind === "clarify", false);
});

test("D: ordinal references still work — the first finding, finding 3, the last one", () => {
  const state = analysed();
  const first = plan(state, "is the first finding really a problem?");
  assert.deepEqual([first.kind, (first as { index: number }).index, state.focus], ["verify", 0, 0]);
  assert.deepEqual(plan(state, "fix the first one"), { kind: "change", task: `Fix this finding from the analysis: ${state.findings[0]}` });
  assert.deepEqual((plan(analysed(), "fix finding 3") as { task: string }).task, `Fix this finding from the analysis: ${parseFindings(ANALYSIS)[TRUSTED]}`);
  const last = analysed();
  assert.deepEqual([plan(last, "is the last finding really a problem?").kind, last.focus], ["verify", 7]);
});

test("E: the verified finding survives follow-up turns and is the one fixed; a finding named later becomes the active one", () => {
  const state = analysed();
  plan(state, "is the trusted_proxies finding really a problem?");
  verifiedByLead(state, TRUSTED, ["configuration.yaml"]);
  for (const line of ["explain it", "what would you change?", "tell me more about it"]) {
    const turn = plan(state, line);
    assert.equal(turn.kind, "ask", line);
    assert.equal(state.focus, TRUSTED, `${line}: the active finding stays`);
  }
  assert.match((plan(state, "fix it") as { task: string }).task, /^Fix this finding from the analysis: `configuration\.yaml`: `use_x_forwarded_for` without `trusted_proxies`[\s\S]*\(Fusion's verification of this finding cited: configuration\.yaml\)$/u);
  // Naming another finding by its terms makes THAT one active (and it carries no evidence it was never given).
  const other = plan(state, "explain the motion_hallway finding");
  assert.deepEqual([other.kind, state.focus], ["ask", 3]);
  assert.equal((plan(state, "fix it") as { task: string }).task, `Fix this finding from the analysis: ${state.findings[3]}`);
});

test("F: the analysis's broad proposed build task is never reused while a specific finding is active", () => {
  const state = analysed();
  state.proposal = "Add a .gitignore, fix the duplicate automation id, add trusted_proxies and remove the inline MQTT credentials.";
  plan(state, "is the trusted_proxies finding really a problem?");
  verifiedByLead(state, TRUSTED, ["configuration.yaml", "home-assistant.log"]);
  for (const line of ["fix it", "do it", "go ahead"]) {
    const change = plan(state, line);
    assert.equal(change.kind, "change", line);
    assert.ok((change as { task: string }).task.startsWith(`Fix this finding from the analysis: ${state.findings[TRUSTED]}`), line);
    assert.ok(!(change as { task: string }).task.includes(".gitignore"), `${line}: not the broad proposal`);
  }
  // Without an active finding (no analysis findings at all), a short "do it" still takes the proposal (unchanged).
  const bare = newSessionState();
  bare.proposal = "Add trusted_proxies to configuration.yaml.";
  assert.deepEqual(plan(bare, "do it"), { kind: "change", task: "Add trusted_proxies to configuration.yaml." });
});

test("L2 observability: Muse's failure reason becomes Fusion's own class, length and category — never its text", () => {
  const reason = (text: string) => classifyMuseTerminalFailure(text, "meta");
  const cases: Array<[string, string, string | undefined]> = [
    ["Run stopped: maximum model steps reached (4) RAW-REASON-SENTINEL", "stepLimit", "turnLimit"],
    ["HTTP 400: context length exceeded for this model RAW-REASON-SENTINEL", "contextOverflow", "inputTooLarge"],
    ["HTTP 413 payload too large", "http413", "inputTooLarge"],
    ["the prompt is too long", "contextOverflow", "inputTooLarge"],
    ["HTTP 429 too many requests", "http429", "rateLimited"],
    ["quota exceeded for today", "rateLimit", "rateLimited"],
    ["HTTP 503 upstream unavailable", "http5xx", "providerApiError"],
    ["socket hang up", "network", "providerApiError"],
    ["HTTP 401 unauthorized", "http401", undefined],
    ["timed out waiting for the model", "timeout", undefined],
    ["something the model said went wrong RAW-REASON-SENTINEL", "unclassified", undefined],
    ["", "absent", undefined]];
  for (const [text, reasonClass, category] of cases) {
    const failure = reason(text);
    assert.deepEqual([failure.reasonClass, failure.category, failure.reasonChars], [reasonClass, category, text.length], text);
    assert.ok(!JSON.stringify(failure).includes("SENTINEL") && !JSON.stringify(failure).includes("model said"), "no provider text is kept");
  }
  assert.deepEqual([classifyMuseTerminalFailure(undefined, "meta").reasonClass, classifyMuseTerminalFailure(42, "meta").reasonChars], ["absent", 0]);
});
