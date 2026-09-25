import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { PROBE_PACKET, PROBE_TARGET } from "../src/app/proposal-probe.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport, writerReadiness } from "../src/app/writer-gate.js";
import { changeSetSchema, validateChangeSet } from "../src/core/change/contract.js";
import type { ChangeProposalRequest, ChangeScope, ReviewRequest } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import { structuredTurnPrompt } from "../src/core/review/contract.js";
import { jsonSchemaSubset } from "../src/platform/process/json-schema.js";
import { readStructuredEnvelope, structureOnlyDiagnostic, STRUCTURED_OUTPUT_CLASSES, STRUCTURED_TEXT_MAX_BYTES, type EnvelopePolicy,
  type StructuredOutputDiagnostic } from "../src/platform/process/structured-envelope.js";
import { ClaudeOneShotTransport, CLAUDE_PROPOSAL_REPLY_RULE, claudeStructuredPrompt, structuredEnvelope } from "../src/providers/claude/one-shot-transport.js";
import { claudeReadOnlyArgs } from "../src/providers/claude/plugin-quarantine.js";
import { claudeLaunchPosture } from "../src/providers/claude/posture.js";
import { CLAUDE_CHILD_SWITCHES, CLAUDE_VALIDATED_EXTENSION_VERSION, type ClaudeLaunchConfig } from "../src/providers/claude/types.js";
import { assertSupportedSchema, validateSchema } from "../src/providers/muse/structured-output.js";
import { MuseFailure } from "../src/providers/muse/types.js";
import { PROPOSAL_PROBE_PROFILES } from "../src/providers/probe-profiles.js";
import { changeProposalEnvelopeCoverage, changeProposalLiveEvidence, changeProposalLiveRecords, liveChangeProposalCoverage,
  transportProfile } from "../src/runtime/provider-profiles.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { BASELINE_HASH, claudeBinding, cleanEnv, museBinding, probe, PROPOSAL, PROPOSAL_PREFIX, rehearsalCompose, report, section,
  testRegistry, withRoot } from "./fixtures/probe-harness.js";
import { claudeBinary, EMPTY_HOME, withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B10 — Claude structured-output hardening, proven offline. No provider is ever called: the envelope reader is pure,
 * the transport and probe run the REAL adapter code against the deterministic fake native binaries, and every probe run
 * is labelled `offlineRehearsal`.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const FENCE = "```";
const TARGET = "src/name.js";
const BEFORE = "export const name = 1;\n", AFTER = "export const name = 2;\n";
const VALID = changeSet([[TARGET, BEFORE, AFTER]]);
const RAW = JSON.stringify(VALID);
const PRETTY = JSON.stringify(VALID, null, 2);
const SCOPE: ChangeScope = { allowedPaths: [TARGET], forbiddenPaths: [] };
const SUBSET = jsonSchemaSubset((_kind, message) => { throw new Error(message); });
const conforms = (value: unknown): boolean => SUBSET.validateSchema(value, changeSetSchema());
const read = (text: string, policy: EnvelopePolicy = "rawOrSingleJsonFence") => readStructuredEnvelope(text, { policy, conforms });
const crlf = (text: string): string => text.replace(/\n/gu, "\r\n");
const fence = (body: string, tag = "json"): string => `${FENCE}${tag}\n${body}\n${FENCE}`;

type Outcome = readonly ["accepted" | "envelope", string] | readonly ["contract", string];
/** The whole pipeline: envelope, then (for an accepted value) the unchanged ChangeSet validator. */
function pipeline(text: string, policy: EnvelopePolicy = "rawOrSingleJsonFence"): Outcome {
  const reading = read(text, policy);
  if (!reading.accepted) return ["envelope", reading.diagnostic.classification];
  try { validateChangeSet(reading.value, SCOPE); return ["accepted", reading.diagnostic.classification]; }
  catch (error) { assert.ok(error instanceof FusionFailure); return ["contract", error.error.kind]; }
}

const ACCEPTED: ReadonlyArray<readonly [string, string, string]> = [
  ["A compact", RAW, "RAW_VALID_JSON"],
  ["A pretty, whitespace around", `  \n${PRETTY}\n\t`, "RAW_VALID_JSON"],
  ["A CRLF", crlf(PRETTY), "RAW_VALID_JSON"],
  ["B compact", fence(RAW), "SINGLE_FENCED_VALID_JSON"],
  ["B pretty, blank lines and indentation outside", `\n\n  ${fence(PRETTY)}\n\n`, "SINGLE_FENCED_VALID_JSON"],
  ["B CRLF", crlf(`${fence(PRETTY)}\n`), "SINGLE_FENCED_VALID_JSON"],
  ["B blanks around the tag and the closing marker", `${FENCE} json \n${RAW}\n  ${FENCE}  `, "SINGLE_FENCED_VALID_JSON"],
  ["B mixed line endings", `${FENCE}json\r\n${PRETTY}\n${FENCE}\r\n`, "SINGLE_FENCED_VALID_JSON"],
  ["C compact", fence(RAW, ""), "SINGLE_FENCED_VALID_JSON"],
  ["C CRLF", crlf(fence(PRETTY, "")), "SINGLE_FENCED_VALID_JSON"],
];

const WRONG = JSON.stringify({ ...VALID, extra: true });
const PROTO = `{"__proto__":{"polluted":true},${RAW.slice(1)}`;
const RAW_NUL = RAW.replace("export const name = 2;", "export\u0000const name = 2;");
const ESCAPED_NUL = RAW.replace("export const name = 2;", "export\\u0000const name = 2;");
const BIG = JSON.stringify(changeSet([[TARGET, BEFORE, "x".repeat(STRUCTURED_TEXT_MAX_BYTES)]]));
const REJECTED: ReadonlyArray<readonly [string, string, Outcome, Partial<StructuredOutputDiagnostic>?]> = [
  ["1 prose before the fence", `Here is the JSON:\n${fence(RAW)}`, ["envelope", "EXTRA_TEXT"],
    { extraTextLocation: "beforeFence", beginsWithFence: false, bodyParsesAsJson: true, bodyMatchesExpectedSchema: true }],
  ["2 prose after the fence", `${fence(RAW)}\nHope this helps`, ["envelope", "EXTRA_TEXT"],
    { extraTextLocation: "afterFence", exactlyOneFencePair: true, whitespaceOnlyAfterFence: false, bodyMatchesExpectedSchema: true }],
  ["3 two fences", `${fence(RAW)}\n${fence(RAW)}`, ["envelope", "MULTIPLE_FENCES"], { fenceLines: 4, multipleFencesDetected: true }],
  ["4 unterminated fence", `${FENCE}json\n${RAW}`, ["envelope", "UNCLOSED_FENCE"], { fenceClosed: false, fenceLines: 1 }],
  ["4 closing marker on the body line", `${FENCE}json\n${RAW}${FENCE}`, ["envelope", "UNCLOSED_FENCE"]],
  ["4 closing line with a tag", `${FENCE}json\n${RAW}\n${FENCE}json`, ["envelope", "UNCLOSED_FENCE"]],
  ["4 closing line with trailing words", `${FENCE}json\n${RAW}\n${FENCE} done`, ["envelope", "UNCLOSED_FENCE"]],
  ["5 malformed JSON inside a valid fence", fence(`{"schemaVersion":1,"operations":[}`), ["envelope", "SINGLE_FENCED_INVALID_JSON"],
    { bodyParsesAsJson: false, bodyJsonFailure: "invalidJson" }],
  ["6 valid JSON, wrong schema, fenced", fence(WRONG), ["envelope", "INVALID_SCHEMA"], { bodyMatchesExpectedSchema: false }],
  ["6 valid JSON, wrong schema, raw (the core refuses it)", WRONG, ["contract", "MalformedOutput"]],
  ["7 array instead of an object, fenced", fence(`[${RAW}]`), ["envelope", "INVALID_SCHEMA"], { bodyTopLevelType: "array" }],
  ["7 array instead of an object, raw (the core refuses it)", `[${RAW}]`, ["contract", "MalformedOutput"]],
  ["8 two documents in one fence", fence(`${RAW}\n${RAW}`), ["envelope", "MULTIPLE_VALUES"], { multipleTopLevelValuesDetected: true }],
  ["8 two concatenated documents", `${RAW}${RAW}`, ["envelope", "MULTIPLE_VALUES"], { multipleTopLevelValuesDetected: true }],
  ["8 two documents on two lines", `${RAW}\n${RAW}`, ["envelope", "MULTIPLE_VALUES"]],
  ["9 nested fence", `${FENCE}json\n${fence(RAW)}\n${FENCE}`, ["envelope", "MULTIPLE_FENCES"]],
  ["9 four-backtick outer fence around a fence", `${FENCE}\`json\n${fence(RAW, "")}\n${FENCE}\``, ["envelope", "MULTIPLE_FENCES"]],
  ["10 javascript fence", fence(RAW, "javascript"), ["envelope", "UNSUPPORTED_FENCE"], { fenceLanguage: "other" }],
  ["10 upper-case tag", fence(RAW, "JSON"), ["envelope", "UNSUPPORTED_FENCE"]],
  ["10 jsonc tag", fence(RAW, "jsonc"), ["envelope", "UNSUPPORTED_FENCE"]],
  ["10 tilde fence", `~~~json\n${RAW}\n~~~`, ["envelope", "UNSUPPORTED_FENCE"], { fenceMarker: "tildes" }],
  ["10 four-backtick fence", `${FENCE}\`json\n${RAW}\n${FENCE}\``, ["envelope", "UNSUPPORTED_FENCE"]],
  ["11 commentary inside the fence after the JSON", fence(`${RAW}\nThis trims the name first.`), ["envelope", "EXTRA_TEXT"],
    { extraTextLocation: "insideFence" }],
  ["12 Markdown paragraph with braces", `The fix sets {"schemaVersion": 1} as described.`, ["envelope", "OTHER_MALFORMED"]],
  ["12 JSON in a bullet", `- ${RAW}`, ["envelope", "OTHER_MALFORMED"]],
  ["12 fenced JSON in a bullet", `- ${fence(RAW)}`, ["envelope", "EXTRA_TEXT"]],
  ["12 heading before the fence", `# ChangeSet\n${fence(RAW)}`, ["envelope", "EXTRA_TEXT"]],
  ["12 JSON followed by prose", `${RAW}\nDone.`, ["envelope", "EXTRA_TEXT"], { extraTextLocation: "afterValue" }],
  ["13 leading BOM, raw", `﻿${RAW}`, ["envelope", "OTHER_MALFORMED"], { leadingByteOrderMark: true }],
  ["13 leading BOM, fenced", `﻿${fence(RAW)}`, ["envelope", "EXTRA_TEXT"], { leadingByteOrderMark: true }],
  ["14 oversized, fenced", fence(BIG), ["envelope", "OVERSIZED"]],
  ["14 oversized, raw", BIG, ["envelope", "OVERSIZED"]],
  ["15 NUL in the fence tag", `${FENCE}json\u0000\n${RAW}\n${FENCE}`, ["envelope", "UNSUPPORTED_FENCE"], { rawControlCharacters: true }],
  ["15 vertical tab before the fence", `\u000b${fence(RAW)}`, ["envelope", "EXTRA_TEXT"], { rawControlCharacters: true }],
  ["15 raw control character inside a JSON string", fence(RAW_NUL), ["envelope", "SINGLE_FENCED_INVALID_JSON"], { rawControlCharacters: true }],
  ["15 escaped NUL in content (the core refuses it)", fence(ESCAPED_NUL), ["contract", "MalformedOutput"]],
  ["15 right-to-left override in the tag", fence(RAW, "json‮"), ["envelope", "UNSUPPORTED_FENCE"]],
  ["16 __proto__ key, fenced", fence(PROTO), ["envelope", "INVALID_SCHEMA"]],
  ["16 __proto__ key, raw (the core refuses it)", PROTO, ["contract", "MalformedOutput"]],
  ["16 constructor key, fenced", fence(`{"constructor":{"prototype":{}},${RAW.slice(1)}`), ["envelope", "INVALID_SCHEMA"]],
  ["16 duplicate key, fenced", fence(`{"schemaVersion":2,${RAW.slice(1)}`), ["envelope", "SINGLE_FENCED_INVALID_JSON"], { bodyJsonFailure: "duplicateKey" }],
  ["16 hostile nesting, fenced", fence(`${"[".repeat(100)}${"]".repeat(100)}`), ["envelope", "SINGLE_FENCED_INVALID_JSON"], { bodyJsonFailure: "tooDeep" }],
  ["18 third fence line after a clean pair", `${fence(RAW)}\n\n${FENCE}`, ["envelope", "MULTIPLE_FENCES"]],
  ["18 two-backtick fence", `\`\`json\n${RAW}\n\`\``, ["envelope", "OTHER_MALFORMED"]],
  ["18 tag glued to a closing marker", `${FENCE}json${FENCE}\n${RAW}`, ["envelope", "UNSUPPORTED_FENCE"]],
  ["18 fence markers inside one prose line", `Use ${FENCE}json ${RAW} ${FENCE}`, ["envelope", "OTHER_MALFORMED"]],
  ["19 lone-CR line endings", `${FENCE}json\r${RAW}\r${FENCE}`, ["envelope", "UNSUPPORTED_FENCE"], { lineEndings: "cr" }],
  ["20 empty output", "", ["envelope", "EMPTY"]],
  ["20 whitespace-only output", " \r\n\t\n", ["envelope", "EMPTY"]],
  ["20 empty fence", `${FENCE}json\n${FENCE}`, ["envelope", "SINGLE_FENCED_INVALID_JSON"]],
  ["20 blank fence", `${FENCE}json\n  \n${FENCE}`, ["envelope", "SINGLE_FENCED_INVALID_JSON"]],
  ["JSON5 in a fence", fence(`{schemaVersion: 1, operations: []}`), ["envelope", "SINGLE_FENCED_INVALID_JSON"]],
  ["comment in a fence", fence(`{"schemaVersion": 1, // one\n"operations": []}`), ["envelope", "SINGLE_FENCED_INVALID_JSON"]],
  ["trailing comma in a fence", fence(RAW.replace(/\}$/u, ",}")), ["envelope", "SINGLE_FENCED_INVALID_JSON"]],
  ["JSON5, raw", "{schemaVersion: 1}", ["envelope", "RAW_INVALID_JSON"]],
];

// ---------------------------------------------------------------- the envelope grammar

test("O5.5B10 accept: raw JSON (A), exactly one ```json fence (B) or bare fence (C), JSON whitespace outside, LF/CRLF/mixed", () => {
  for (const [name, text, classification] of ACCEPTED) {
    const reading = read(text);
    assert.ok(reading.accepted, name);
    assert.equal(reading.diagnostic.classification, classification, name);
    assert.deepEqual(validateChangeSet(reading.value, SCOPE), VALID, `${name}: the unchanged ChangeSet validator accepts exactly the proposal`);
    // The accepted value is a plain JSON.parse result: no accessor, no foreign prototype.
    const value = reading.value as Record<string, unknown>;
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
    assert.ok(Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor));
  }
  // A JSON string may hold fence text mid-line (Markdown content): still one document; the fence pair stays unambiguous.
  const markdown = changeSet([["docs/guide.md", null, "# Guide\n```js\nrun();\n```\n"]]);
  const reading = read(fence(JSON.stringify(markdown, null, 2)));
  assert.ok(reading.accepted);
  assert.deepEqual(reading.value, markdown);
  assert.equal(reading.diagnostic.fenceLines, 2);
});

test("O5.5B10 reject: prose, trailing text, several fences or values, unclosed or foreign fences, bad JSON, wrong schema, BOM, size, controls", () => {
  for (const [name, text, expected, facts] of REJECTED) {
    assert.deepEqual(pipeline(text), expected, name);
    const reading = read(text);
    if (expected[0] === "envelope") assert.equal(reading.accepted, false, name);
    for (const [key, value] of Object.entries(facts ?? {}))
      assert.deepEqual(reading.diagnostic[key as keyof StructuredOutputDiagnostic], value, `${name}: ${key}`);
  }
  assert.equal(({} as Record<string, unknown>).polluted, undefined, "a __proto__ key never reaches a prototype");
  assert.ok(read(fence(BIG)).diagnostic.outputBytes > STRUCTURED_TEXT_MAX_BYTES);
});

test("O5.5B10 raw-only policy (reviews, adjudications, packets, other families): every fenced form is refused, raw JSON unchanged", () => {
  for (const [name, text, classification] of ACCEPTED) {
    const outcome = pipeline(text, "rawOnly");
    assert.deepEqual(outcome, classification === "RAW_VALID_JSON" ? ["accepted", "RAW_VALID_JSON"] : ["envelope", "SINGLE_FENCED_VALID_JSON"], name);
    assert.equal(read(text, "rawOnly").diagnostic.policy, "rawOnly");
  }
  // What the fence policy hands to the core only from a clean fence is refused earlier under raw-only.
  for (const [name, text, expected] of REJECTED)
    assert.deepEqual(pipeline(text, "rawOnly"), expected[0] === "contract" && read(text).diagnostic.classification === "SINGLE_FENCED_VALID_JSON"
      ? ["envelope", "SINGLE_FENCED_VALID_JSON"] : expected, `${name} (raw-only)`);
  assert.throws(() => readStructuredEnvelope(RAW, { policy: "anything" as EnvelopePolicy }), RangeError);
});

test("O5.5B10 later stages: a getter or proxy cannot reach the applier — the ChangeSet validator refuses what is not plain data", () => {
  const reading = read(fence(RAW));
  assert.ok(reading.accepted);
  assert.throws(() => validateChangeSet(new Proxy(reading.value as object, {}), SCOPE),
    (error: unknown) => error instanceof FusionFailure && error.error.kind === "MalformedOutput");
  let reads = 0;
  const shifting = { schemaVersion: 1, get operations() { reads++; return reads === 1 ? VALID.operations : []; } };
  assert.deepEqual(validateChangeSet(shifting, SCOPE), VALID, "one snapshot: the checked value is the applied value");
  assert.equal(reads, 1);
});

// ---------------------------------------------------------------- the structure-only diagnostic

test("O5.5B10 diagnostic: structure only — fixed keys, enumerations and counts; never content, keys, tags or prose", () => {
  const canary = changeSet([["src/CANARY-PATH-4d1e.js", null, "CANARY-CONTENT-91f2"]]);
  const body = JSON.stringify(canary);
  const texts = [...ACCEPTED.map(([, text]) => text), ...REJECTED.map(([, text]) => text), fence(body), fence(body, "CANARY-TAG-77aa"),
    `CANARY-PROSE-5b0c\n${fence(body)}`, `${fence(body)}\nCANARY-PROSE-5b0c`, `${body}${body}`, fence(`${body}\nCANARY-PROSE-5b0c`)];
  const classes = new Set<string>();
  for (const text of texts) for (const policy of ["rawOnly", "rawOrSingleJsonFence"] as const) {
    const { diagnostic } = read(text, policy);
    classes.add(diagnostic.classification);
    assert.deepEqual(structureOnlyDiagnostic(diagnostic), diagnostic, "every diagnostic survives the evidence filter unchanged");
    assert.equal(Object.keys(diagnostic).length, 27);
    assert.doesNotMatch(JSON.stringify(diagnostic), /CANARY|name\.js|export|operations|writeText|Hope|Here|javascript/u);
    for (const value of Object.values(diagnostic))
      assert.ok(typeof value === "boolean" || Number.isSafeInteger(value) || typeof value === "string" && /^[A-Za-z_/]+$/u.test(value));
  }
  assert.deepEqual([...STRUCTURED_OUTPUT_CLASSES].filter(name => !classes.has(name)), [], "every classification is exercised");
});

test("O5.5B10 evidence filter: an extra key, a string outside an enumeration, a getter or a proxy makes the record `invalid`", () => {
  const { diagnostic } = read(`${fence(RAW)}\nHope`);
  const leaky = [{ ...diagnostic, classification: "EXTRA_TEXT; body={secret}" }, { ...diagnostic, extra: "value" }, { ...diagnostic, outputBytes: -1 },
    { ...diagnostic, lines: 1.5 }, { ...diagnostic, fenceLines: "2" }, Object.fromEntries(Object.entries(diagnostic).filter(([key]) => key !== "body")),
    Object.defineProperty({ ...diagnostic }, "classification", { get: () => "LEAK-CANARY", enumerable: true }),
    new Proxy({ ...diagnostic }, {}), ["EXTRA_TEXT"], "EXTRA_TEXT"];
  for (const candidate of leaky) assert.equal(structureOnlyDiagnostic(candidate), "invalid", JSON.stringify(candidate));
  assert.equal(structureOnlyDiagnostic(undefined), null);
  assert.equal(structureOnlyDiagnostic(null), null);
});

// ---------------------------------------------------------------- the Claude transport (fake native binary)

const REQUIREMENTS = { structuredOutput: true, webToolsDisabled: true, filesystem: { read: true, write: false }, shell: { available: false } } as const;
const PROPOSAL_REQUEST: ChangeProposalRequest = { kind: "changeProposal", packet: PROBE_PACKET, baseline: [{ path: PROBE_TARGET, sha256: BASELINE_HASH }] };
const REVIEW: ReviewRequest = { kind: "review", cycle: 1, priorFindings: [], limits: { maxFindings: 5 },
  evidence: { task: { goal: "g", constraints: [], acceptanceCriteria: [] }, architecture: { decisions: [], invariants: [] },
    scope: { relevantFiles: [], allowedFiles: [], forbiddenFiles: [] }, verification: { required: false, passed: false, commands: [] },
    change: { kind: "diff", changedPaths: [], text: "", truncated: false } } };
function claudeTransport(i: Installs, env: Readonly<Record<string, string>>, purposes: string[]): ClaudeOneShotTransport {
  const config: ClaudeLaunchConfig = { executablePath: i.claudeExe, workspace: i.dir, model: { id: "alias", effort: "low", maxTurns: 3 },
    expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly", timeoutMs: 20_000,
    sourceEnvironment: { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: EMPTY_HOME, FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, ...env },
    launchObserver: launch => { purposes.push(launch.purpose ?? "unlabelled"); } };
  return new ClaudeOneShotTransport(config, undefined, claudeBinary);
}

test("O5.5B10 Claude prompt: the reply rule is the LAST line of a change proposal only; the neutral contract (other families) is unchanged", () => {
  const proposal = claudeStructuredPrompt(PROPOSAL_REQUEST);
  assert.ok(proposal.startsWith(structuredTurnPrompt(PROPOSAL_REQUEST)));
  assert.ok(proposal.endsWith(`\n${CLAUDE_PROPOSAL_REPLY_RULE}`));
  for (const phrase of ["raw JSON object alone", "first character of your reply must be {", "Do not wrap it in a Markdown code fence"])
    assert.ok(CLAUDE_PROPOSAL_REPLY_RULE.includes(phrase), phrase);
  assert.ok(!structuredTurnPrompt(PROPOSAL_REQUEST).includes(CLAUDE_PROPOSAL_REPLY_RULE), "the provider-neutral prompt carries no Claude rule");
  assert.match(structuredTurnPrompt(PROPOSAL_REQUEST), /no Markdown fence, no commentary, no text before or after it/u, "the neutral rule is unchanged");
  assert.equal(claudeStructuredPrompt(REVIEW), structuredTurnPrompt(REVIEW), "review prompts are unchanged");
  assert.equal(structuredEnvelope(PROPOSAL_REQUEST).policy, "rawOrSingleJsonFence");
  assert.equal(structuredEnvelope(REVIEW).policy, "rawOnly");
  assert.equal(structuredEnvelope(PROPOSAL_REQUEST).conforms!(VALID), true);
  assert.equal(structuredEnvelope(PROPOSAL_REQUEST).conforms!({ schemaVersion: 1 }), false);
});

test("O5.5B10 Claude transport: one fenced proposal (CRLF) is read, one turn, diagnostic kept; the reply rule reached the process", async () =>
  withInstalls(async i => {
    const purposes: string[] = [];
    const fenced = crlf(`${fence(JSON.stringify(JSON.parse(PROPOSAL), null, 2))}\n`);
    const t = claudeTransport(i, { FUSION_FAKE_OUTPUT: fenced, FUSION_FAKE_PROMPT_INCLUDES: CLAUDE_PROPOSAL_REPLY_RULE }, purposes);
    const turn = await t.runStructured({ request: PROPOSAL_REQUEST, requiredCapabilities: REQUIREMENTS });
    assert.equal(turn.status, "completed", JSON.stringify(turn));
    if (turn.status === "completed") assert.deepEqual(turn.output, JSON.parse(PROPOSAL));
    assert.deepEqual([t.structuredOutputDiagnostic?.classification, t.structuredOutputDiagnostic?.accepted, t.structuredOutputDiagnostic?.lineEndings],
      ["SINGLE_FENCED_VALID_JSON", true, "crlf"]);
    assert.equal(purposes.filter(p => p === "providerTurn").length, 1);
    const raw = claudeTransport(i, { FUSION_FAKE_OUTPUT: PROPOSAL }, []);
    assert.equal((await raw.runStructured({ request: PROPOSAL_REQUEST, requiredCapabilities: REQUIREMENTS })).status, "completed");
    assert.equal(raw.structuredOutputDiagnostic?.classification, "RAW_VALID_JSON", "the raw path is unchanged");
  }));

test("O5.5B10 Claude transport: a refused proposal fails typed after exactly one turn (no retry); its shape and init readback are kept", async () =>
  withInstalls(async i => {
    for (const [text, classification] of [[`${fence(PROPOSAL)}\nHope this helps!`, "EXTRA_TEXT"], [`${fence(PROPOSAL)}\n${fence(PROPOSAL)}`, "MULTIPLE_FENCES"],
      [fence(PROPOSAL, "javascript"), "UNSUPPORTED_FENCE"], [`Here it is: ${PROPOSAL}`, "OTHER_MALFORMED"]] as const) {
      const purposes: string[] = [];
      const t = claudeTransport(i, { FUSION_FAKE_OUTPUT: text }, purposes);
      const turn = await t.runStructured({ request: PROPOSAL_REQUEST, requiredCapabilities: REQUIREMENTS });
      assert.equal(turn.status, "failed", classification);
      if (turn.status === "failed") {
        assert.deepEqual([turn.error.kind, turn.error.retryable], ["MalformedOutput", false]);
        assert.equal(turn.error.safeMessage, `Claude structured output was refused: ${classification} under the rawOrSingleJsonFence envelope.`);
      }
      assert.equal("output" in turn, false, "a refused turn hands back nothing");
      assert.deepEqual([t.structuredOutputDiagnostic?.classification, t.structuredOutputDiagnostic?.accepted], [classification, false]);
      assert.equal(t.initReadback?.runtimeVersion, "2.1.280");
      assert.equal(purposes.filter(p => p === "providerTurn").length, 1, `${classification}: exactly one model turn`);
    }
  }));

// ---------------------------------------------------------------- the probe (offline rehearsal)

test("O5.5B10 probe: a single fenced Claude ChangeSet passes the whole offline pipeline — one turn, validated, host-applied, verified; the recorded live FAIL stands",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const fenced = crlf(`${fence(JSON.stringify(JSON.parse(PROPOSAL), null, 2))}\n`);
    const r = report(await probe("claude", { env: cleanEnv(), evidenceRoot: root, binding: claudeBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: fenced, FUSION_FAKE_PROMPT_INCLUDES: BASELINE_HASH }),
      compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "PASS", `${r.detail} ${JSON.stringify(r.evidence.workflow)}`);
    assert.deepEqual([r.evidence.evidenceKind, r.evidence.schemaVersion], ["offlineRehearsal", 3], "a fake provider can never produce live evidence");
    assert.deepEqual([section<Record<string, number>>(r, "launchCounts").providerTurn, section<number>(r, "proposalCalls"), runs.count], [1, 1, 1]);
    const shape = section<Record<string, unknown>>(r, "structuredOutput");
    assert.deepEqual([shape.classification, shape.accepted, shape.policy, shape.fenceLanguage, shape.lineEndings],
      ["SINGLE_FENCED_VALID_JSON", true, "rawOrSingleJsonFence", "json", "crlf"]);
    const text = await readFile(r.evidencePath, "utf8");
    assert.ok(!text.includes("```") && !text.includes(PROPOSAL_PREFIX), "no reply text or prompt is persisted");
    // A rehearsal records nothing: the O5.5B9 failure stays history, and the provider row reads only recorded probes
    // (O5.5B11's PASS came from a validated live evidence file, never from a rehearsal).
    assert.equal(changeProposalLiveRecords("claude", "claude-one-shot")[0]?.outcome, "MALFORMED_PROPOSAL");
    assert.equal(changeProposalLiveRecords("claude", "claude-one-shot").some(record => record.milestone === "TEST"), false);
    assert.deepEqual(section<Record<string, unknown>>(r, "gatesAfter"), { liveGateAuthorized: false,
      providerChangeProposal: writerGateReport().rows.find(row => row.id === "providerChangeProposal")?.state });
  })));

test("O5.5B10 Muse regression: a fenced Muse proposal is still refused (raw-only) after exactly one Exec turn; no Claude diagnostic appears",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const r = report(await probe("muse", { env: cleanEnv(), evidenceRoot: root, binding: museBinding(i), offlineRehearsal: true,
      registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: fence(PROPOSAL), FUSION_FAKE_EXPECT_EFFORT: "minimal" }),
      compose: rehearsalCompose(root, runs) }));
    assert.equal(r.outcome, "MALFORMED_PROPOSAL", r.detail);
    assert.deepEqual([section<Record<string, number>>(r, "launchCounts").providerTurn, runs.count], [1, 0]);
    // No Claude diagnostic appears. Since O5.5B23 Muse reports its OWN structure-only diagnostic, under its raw-only policy:
    // the refusal is recorded exactly, and the policy is unchanged.
    const shape = section<Record<string, unknown>>(r, "structuredOutput");
    assert.deepEqual([shape.classification, shape.accepted, shape.policy], ["SINGLE_FENCED_VALID_JSON", false, "rawOnly"]);
    assert.equal(section<{ applied: unknown }>(r, "candidate").applied, null);
  })));

// ---------------------------------------------------------------- posture, pin, readiness

test("O5.5B10 posture: --json-schema stays a widening flag (it adds a fourth tool on 2.1.280); the Claude pin stays 2.1.280", () => {
  const args = claudeReadOnlyArgs("model", "effort", 1);
  assert.equal(args.includes("--json-schema"), false);
  const widened = claudeLaunchPosture([...args, "--json-schema", "{}"], CLAUDE_CHILD_SWITCHES, true);
  assert.deepEqual([widened.read, widened.write, widened.shell], ["unknown", "unknown", "unknown"], "a widening flag voids every launch-time fact");
  assert.ok(PROPOSAL_PROBE_PROFILES.profiles.claude!.turnPosture.widening.includes("--json-schema"));
  assert.equal(CLAUDE_VALIDATED_EXTENSION_VERSION, "2.1.280");
  assert.deepEqual(transportProfile("claude", "claude-one-shot")?.compatibility, { kind: "validatedVersions", versions: ["2.1.280"] });
  const binding = PROPOSAL_PROBE_PROFILES.profiles.claude!.binding;
  assert.deepEqual([binding.model, binding.effort, binding.maxTurns], ["haiku", "low", 3]);
});

test("O5.5B10 readiness (with O5.5B11): the envelope row is implementation only; the live row moves only through recorded probes; the live gate never", () => {
  assert.deepEqual(changeProposalEnvelopeCoverage(), { changeAuthors: 2, rawOnly: 1, singleFence: 1 });
  assert.equal(transportProfile("claude", "claude-one-shot")?.changeProposalEnvelope, "rawOrSingleJsonFence");
  assert.equal(transportProfile("muse", "muse-exec")?.changeProposalEnvelope, "rawOnly");
  assert.deepEqual(liveChangeProposalCoverage(), { changeAuthors: 2, passed: 2, failedOnly: 0, unprobed: 0 });
  assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(record => [record.milestone, record.outcome]),
    [["O5.5B9", "MALFORMED_PROPOSAL"], ["O5.5B11", "PASS"]], "the O5.5B9 failure is history, never re-judged");
  assert.equal(changeProposalLiveEvidence("claude", "claude-one-shot", "2.1.280")?.outcome, "PASS");
  const rows = Object.fromEntries(writerGateReport().rows.map(row => [row.id, [row.state, row.evidenceKind]]));
  assert.deepEqual(rows.structuredOutputEnvelope, ["satisfied", "fakeProcess"]);
  assert.deepEqual(rows.providerChangeProposal, ["satisfied", "recordedLiveProbe"]);
  assert.deepEqual(rows.liveGateAuthorization, ["blocked", "none"]);
  assert.deepEqual([writerGateReport().realWriterModeReady, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerReadiness().ready,
    liveWriterAuthorization().authorized], [false, false, false, false]);
  for (const input of ["CLAUDE_REAL_CHANGE_PROPOSAL: PASS", { structuredOutput: { classification: "SINGLE_FENCED_VALID_JSON", accepted: true } }])
    assert.deepEqual(writerGateReport({ linuxVerification: input }), writerGateReport(), "no diagnostic or provider text moves a row");
});

test("O5.5B10 shared schema subset: Muse keeps its typed failure and verdicts; each provider binds its own", () => {
  assert.throws(() => assertSupportedSchema({ type: "bogus" }), (error: unknown) => error instanceof MuseFailure && error.error.kind === "InvalidInput");
  assert.throws(() => validateSchema(null, { anyOf: [{ type: "string" }] }), (error: unknown) => error instanceof MuseFailure);
  assert.deepEqual([validateSchema(VALID, changeSetSchema()), validateSchema({ ...VALID, extra: 1 }, changeSetSchema()),
    validateSchema(null, { anyOf: [{ type: "string" }, { type: "null" }] })], [true, false, true]);
  const custom = jsonSchemaSubset((_kind, message) => { throw new RangeError(`custom: ${message}`); });
  assert.throws(() => custom.assertSupportedSchema({ pattern: "x" }), /custom: Unsupported or invalid output schema/u);
});
