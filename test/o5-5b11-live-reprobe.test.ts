import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import type { BindingConfig } from "../src/app/config.js";
import type { ProviderRegistry } from "../src/app/providers.js";
import { PROBE_EVIDENCE_SCHEMA_VERSION, PROBE_FIXTURE_FILES, PROBE_OUTCOMES, PROBE_TARGET, type ProbeProfileSet } from "../src/app/proposal-probe.js";
import type { WriterComposition } from "../src/app/writer-composition.js";
import { liveWriterAuthorization, REAL_WRITER_LIVE_GATE_AUTHORIZED, writerGateReport } from "../src/app/writer-gate.js";
import { PROPOSAL_PROBE_PROFILES } from "../src/providers/probe-profiles.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { changeProposalLiveRecords } from "../src/runtime/provider-profiles.js";
import { fusionTemporaryBase } from "../src/platform/fs/temporary.js";
import { changeSet } from "./fixtures/fake-writer.js";
import { BASELINE_HASH, cleanEnv, FIXED, museBinding, probe, PROFILES, PROPOSAL, PROPOSAL_PREFIX, rehearsalCompose, report, section,
  TEST_PROFILES, testRegistry, withRoot } from "./fixtures/probe-harness.js";
import { withInstalls, type Installs } from "./fixtures/provider-installs.js";
import { gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * O5.5B11 Stage 1 — the authorized Claude re-probe harness, proven offline. Every run here uses the REAL Claude adapter
 * code against the deterministic fake native binary, the real engine, candidate port and view store over a real Git
 * fixture, and the real Docker backend over the in-memory daemon; each is labelled `offlineRehearsal`. The live entry is
 * spawned ONLY with requests it must refuse before anything exists — never with an open authorization for Claude.
 *
 * Stage 2: O5.5B11 ran live (PASS) and is CONSUMED. Its rehearsals run under a TEST-ONLY open copy of it — the exact
 * production grant object under its own id, milestone and namespace; the production table is never altered.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const LIVE = "O5.5B11";
const PRODUCTION: ProbeProfileSet = PROPOSAL_PROBE_PROFILES;
const REHEARSAL = "O5.5B11-REHEARSAL";
const REHEARSED: ProbeProfileSet = Object.freeze({ ...PRODUCTION, authorizations: Object.freeze({ ...PRODUCTION.authorizations,
  [REHEARSAL]: Object.freeze({ ...PRODUCTION.authorizations[LIVE]!, milestone: REHEARSAL, evidenceDirectory: "fusion-o5-5b11-rehearsal",
    state: "open" as const }) }) });
/** A registry without any adapter: a refusal test can never reach a provider process, even if a check regressed. */
const NO_ADAPTERS: ProviderRegistry = { ...defaultRegistry(), factories: new Map() };
/** The production O5.5B11 grant's binding on the fake install (the executable option is the only test seam). */
const grantedBinding = (i: Installs): BindingConfig => ({ ...PROFILES.claude.binding,
  options: { ...PROFILES.claude.binding.options, executable: i.claudeExe } });
/** The fake answers the production alias and reads back the production canonical model. */
const grantedFake = (output: string, extra: Readonly<Record<string, string>> = {}): Record<string, string> => ({
  FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: output, FUSION_FAKE_PROMPT_INCLUDES: BASELINE_HASH,
  FUSION_FAKE_EXPECT_MODEL: "haiku", FUSION_FAKE_INIT_MODEL: "claude-haiku-4-5-20251001", ...extra });
/** One offline rehearsal under the production O5.5B11 grant (the test-only open copy; own namespace per call). */
async function rehearse(i: Installs, root: string, name: string, output: string, over: Partial<Parameters<typeof probe>[1]> = {}) {
  const runs = { count: 0 };
  const r = report(await probe("claude", { profiles: REHEARSED, authorization: REHEARSAL, env: cleanEnv({ FUSION_CLAUDE_EXE: i.claudeExe }),
    evidenceRoot: join(root, name), binding: grantedBinding(i), offlineRehearsal: true, registry: testRegistry(i, grantedFake(output)),
    compose: rehearsalCompose(root, runs), ...over }));
  return { r, runs };
}
const refusal = (value: unknown): string | false => typeof value === "object" && value !== null && "refused" in value &&
  (value as unknown as { reason: string }).reason;

// ---------------------------------------------------------------- the authorization table

test("O5.5B11 authorization data: Claude only, the pinned runtime and the O5.5B9 binding; after the live run both O5.5B9 and O5.5B11 are consumed", () => {
  const table = PRODUCTION.authorizations;
  assert.deepEqual(Object.entries(table).filter(([, a]) => a.state === "open").map(([id]) => id), [], "no open authorization");
  assert.deepEqual([table["O5.5B9"]!.state, table[LIVE]!.state], ["consumed", "consumed"]);
  const live = table[LIVE]!;
  assert.deepEqual([live.milestone, live.evidenceDirectory, Object.keys(live.grants)], [LIVE, "fusion-o5-5b11-probe", ["claude"]]);
  assert.notEqual(live.evidenceDirectory, table["O5.5B9"]!.evidenceDirectory, "a new namespace, never the consumed one");
  const grant = live.grants.claude!;
  assert.deepEqual([grant.runtimeVersions, grant.lanes, grant.requiredEnvironment], [["2.1.280"], ["subscription", "subscriptionToken"], ["FUSION_CLAUDE_EXE"]]);
  assert.deepEqual(grant.binding, { adapter: "claude-one-shot", model: "haiku", effort: "low", maxTurns: 3,
    options: { canonicalModel: "claude-haiku-4-5-20251001" } });
  const { binding } = PROFILES.claude;
  assert.deepEqual([binding.adapter, binding.model, binding.effort, binding.maxTurns, binding.options.canonicalModel],
    ["claude-one-shot", "haiku", "low", 3, "claude-haiku-4-5-20251001"], "the production profile is exactly the granted binding");
  assert.ok(PROBE_OUTCOMES.includes("MODEL_BLOCKED"));
});

test("O5.5B11 refusals before anything exists: unknown and consumed authorizations, Muse, a nested session, a foreign namespace", async () =>
  withRoot(async root => {
    const at = (name: string) => join(root, name);
    const run = (provider: string, authorization: string, evidenceRoot: string, env = cleanEnv()) =>
      probe(provider, { profiles: REHEARSED, authorization, env, registry: NO_ADAPTERS, evidenceRoot });
    assert.equal(refusal(await run("claude", "O5.5B12", at("a"))), "unknownAuthorization");
    assert.equal(refusal(await run("claude", "o5.5b11", at("a"))), "unknownAuthorization", "the token is exact");
    assert.equal(refusal(await run("claude", "O5.5B9", at("a"))), "authorizationConsumed");
    assert.equal(refusal(await run("muse", "O5.5B9", at("a"))), "authorizationConsumed");
    assert.equal(refusal(await run("claude", LIVE, at("a"))), "authorizationConsumed", "O5.5B11 ran: no second Claude turn");
    assert.equal(refusal(await run("muse", LIVE, at("a"))), "authorizationConsumed");
    assert.equal(refusal(await run("muse", REHEARSAL, at("a"))), "providerNotAuthorized", "the O5.5B11 grant names Claude only");
    assert.equal(refusal(await run("claude", REHEARSAL, at("a"), cleanEnv({ CLAUDECODE: "1" }))), "nestedAgentSession");
    assert.equal(refusal(await run("claude", REHEARSAL, at("a"), cleanEnv({ CLAUDE_CODE_ENTRYPOINT: "cli" }))), "nestedAgentSession");
    assert.equal(existsSync(at("a")), false, "no namespace, fixture, claim or evidence was created");
    // An O5.5B9-shaped directory (claims, evidence, no marker) is never read as or mixed into O5.5B11's namespace.
    await mkdir(at("b9"));
    await writeFile(join(at("b9"), "claude.claim.json"), JSON.stringify({ milestone: "O5.5B9", provider: "claude" }));
    await writeFile(join(at("b9"), "claude.evidence.json"), "{}");
    assert.equal(refusal(await run("claude", REHEARSAL, at("b9"))), "namespaceMismatch");
    await mkdir(at("marked"));
    await writeFile(join(at("marked"), "authorization.json"), JSON.stringify({ authorization: "O5.5B9", milestone: "O5.5B9" }));
    assert.equal(refusal(await run("claude", REHEARSAL, at("marked"))), "namespaceMismatch");
    await mkdir(at("mixed"));
    await writeFile(join(at("mixed"), "authorization.json"), JSON.stringify({ authorization: REHEARSAL, milestone: REHEARSAL }));
    await writeFile(join(at("mixed"), "muse.claim.json"), JSON.stringify({ authorization: "O5.5B9", milestone: "O5.5B9" }));
    assert.equal(refusal(await run("claude", REHEARSAL, at("mixed"))), "namespaceMismatch", "a foreign claim inside the namespace");
    assert.deepEqual((await readdir(at("b9"))).sort(), ["claude.claim.json", "claude.evidence.json"], "the foreign directory is untouched");
  }));

test("O5.5B11 live entry: refuses a consumed authorization, Muse, an unknown token and bad usage — nothing is created", async () =>
  withRoot(async root => {
    const entry = resolve(process.cwd(), "dist/test/live/proposal-probe.js");
    const temp = join(root, "temp");
    await mkdir(temp);
    // Never spawned with an open authorization for Claude: every request here must be refused before anything exists.
    const spawnEntry = (...args: string[]) => spawnSync(process.execPath, [entry, ...args], { encoding: "utf8", timeout: 60_000, windowsHide: true,
      env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "", TEMP: temp, TMP: temp, CLAUDECODE: "1" } });
    const cases: Array<[string[], number, RegExp]> = [
      [["--provider", "claude", "--authorization", "O5.5B9"], 3, /REFUSED \(authorizationConsumed\)/u],
      [["--provider", "muse", "--authorization", "O5.5B9"], 3, /REFUSED \(authorizationConsumed\)/u],
      [["--provider", "muse", "--authorization", LIVE], 3, /REFUSED \(authorizationConsumed\)/u],
      [["--provider", "claude", "--authorization", "O5.5B12"], 3, /REFUSED \(unknownAuthorization\)/u],
      [["--provider", "claude"], 2, /Open authorizations: none/u],
    ];
    for (const [args, status, message] of cases) {
      const child = spawnEntry(...args);
      assert.equal(child.status, status, `${args.join(" ")}: ${child.stderr}`);
      assert.match(child.stderr, message, args.join(" "));
    }
    assert.deepEqual(await readdir(temp), [], "no namespace, fixture, claim or evidence");
  }));

// ---------------------------------------------------------------- static preflight (no provider process)

test("O5.5B11 preflight: wrong model/effort/turns, a missing pinned-runtime variable, an unauthorized version or lane, and PAYG are BLOCKED before any process",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const blocked = async (name: string, binding: BindingConfig, env: NodeJS.ProcessEnv, profiles = REHEARSED) => {
      const r = report(await probe("claude", { profiles, authorization: REHEARSAL, env, evidenceRoot: join(root, name), binding,
        registry: defaultRegistry() }));
      assert.deepEqual([r.evidence.stage, r.modelTurnLaunched, r.evidence.launches], ["preflight", false, undefined], name);
      assert.equal(existsSync(join(root, name, "claude.claim.json")), false, `${name}: a preflight block consumes nothing`);
      return r;
    };
    const env = cleanEnv({ FUSION_CLAUDE_EXE: i.claudeExe });
    const wrongModel = await blocked("model", { ...grantedBinding(i), model: "alias" }, env);
    assert.deepEqual([wrongModel.outcome, section<{ bindingMismatches: string[] }>(wrongModel, "preflight").bindingMismatches], ["MODEL_BLOCKED", ["model"]]);
    assert.equal((await blocked("effort", { ...grantedBinding(i), effort: "high" }, env)).outcome, "MODEL_BLOCKED");
    assert.equal((await blocked("turns", { ...grantedBinding(i), maxTurns: 8 }, env)).outcome, "MODEL_BLOCKED");
    assert.equal((await blocked("canonical", { ...grantedBinding(i), options: { ...grantedBinding(i).options, canonicalModel: "claude-opus-x" } }, env)).outcome,
      "MODEL_BLOCKED");
    const unpinned = await blocked("unpinned", grantedBinding(i), cleanEnv());
    assert.deepEqual([unpinned.outcome, section<{ requiredEnvironment: Record<string, string> }>(unpinned, "preflight").requiredEnvironment],
      ["VERSION_BLOCKED", { FUSION_CLAUDE_EXE: "missing" }]);
    for (const [name, extra] of [["api-key", { ANTHROPIC_API_KEY: "sk-ant-api03-fixture" }], ["gateway", { ANTHROPIC_BASE_URL: "https://gateway.invalid" }],
      ["bedrock", { CLAUDE_CODE_USE_BEDROCK: "1" }]] as const) {
      const r = await blocked(name, grantedBinding(i), cleanEnv({ FUSION_CLAUDE_EXE: i.claudeExe, ...extra }));
      assert.equal(r.outcome, "AUTH_BLOCKED", name);
      assert.doesNotMatch(await readFile(r.evidencePath, "utf8"), /sk-ant-api03-fixture|gateway\.invalid/u, "no credential or endpoint value");
    }
    // A lane the authorization does not name (a test copy that grants only the token lane; no token is present).
    const tokenOnly: ProbeProfileSet = { ...REHEARSED, authorizations: { ...REHEARSED.authorizations, [REHEARSAL]: { ...REHEARSED.authorizations[REHEARSAL]!,
      grants: { claude: { ...REHEARSED.authorizations[REHEARSAL]!.grants.claude!, lanes: ["subscriptionToken"] } } } } };
    const lane = await blocked("lane", grantedBinding(i), env, tokenOnly);
    assert.deepEqual([lane.outcome, lane.detail], ["AUTH_BLOCKED", "credential lane subscription is not authorized (subscriptionToken)"]);
    // A validated release the authorization does not name.
    const otherVersion: ProbeProfileSet = { ...REHEARSED, authorizations: { ...REHEARSED.authorizations, [REHEARSAL]: { ...REHEARSED.authorizations[REHEARSAL]!,
      grants: { claude: { ...REHEARSED.authorizations[REHEARSAL]!.grants.claude!, runtimeVersions: ["9.9.9"] } } } } };
    assert.equal((await blocked("authorized-version", grantedBinding(i), env, otherVersion)).outcome, "VERSION_BLOCKED");
    await writeFile(join(i.dir, "claude-code", "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.281" }));
    const newer = await blocked("version", grantedBinding(i), env);
    assert.deepEqual([newer.outcome, newer.detail], ["VERSION_BLOCKED", "installed 2.1.281 is not a validated claude-one-shot release"]);
  })));

// ---------------------------------------------------------------- the pre-launch guard

test("O5.5B11 pre-launch guard: a view outside Fusion's view store, a view holding .git, a forbidden variable or a turn without its controls never starts",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    // A view that is not in Fusion's view store, and one that is placed like a Fusion view but holds a .git directory.
    const outside = join(root, "outside-store", "workspace");
    await mkdir(outside, { recursive: true });
    const placed = await mkdtemp(join(fusionTemporaryBase(), "fusion-provider-view-b11test-"));
    await mkdir(join(placed, "workspace", ".git"), { recursive: true });
    const cases: Array<[string, (composition: WriterComposition) => WriterComposition, ProbeProfileSet, string]> = [];
    for (const [name, path] of [["outside-store", outside], ["shared-git", join(placed, "workspace")]] as const) {
      cases.push([name, composition => ({ ...composition, views: { viewRoot: composition.views.viewRoot,
        open: async () => ({ viewId: `hostile-${name}`, kind: "baseline" as const, path }), fingerprint: async () => "same",
        release: async () => ({ complete: true }) } as unknown as WriterComposition["views"] }), REHEARSED,
        "a provider process would start outside a checked Fusion-owned view"]);
    }
    cases.push(["forbidden-variable", composition => composition, { ...REHEARSED, forbiddenEnv: /^FUSION_FAKE_RECORD$/u },
      "a forbidden variable would reach a provider process (FUSION_FAKE_RECORD)"]);
    const strict = { ...REHEARSED.profiles.claude!, turnPosture: { ...REHEARSED.profiles.claude!.turnPosture,
      required: [...REHEARSED.profiles.claude!.turnPosture.required, ["--a-control-the-turn-lacks"]] } };
    cases.push(["turn-posture", composition => composition, { ...REHEARSED, profiles: { ...REHEARSED.profiles, claude: strict } },
      "the provider model turn lacks a read-only control or carries a widening flag"]);
    try {
      for (const [name, override, profiles, reason] of cases) {
        const runs = { count: 0 };
        const r = report(await probe("claude", { profiles, authorization: REHEARSAL, env: cleanEnv({ FUSION_CLAUDE_EXE: i.claudeExe }),
          evidenceRoot: join(root, `${name}-probe`), binding: grantedBinding(i), offlineRehearsal: true,
          registry: testRegistry(i, grantedFake(PROPOSAL)), compose: rehearsalCompose(root, runs, override) }));
        const refusals = section<{ refusals: Array<{ reason: string }> }>(r, "launchGuard").refusals;
        assert.equal(refusals[0]?.reason, reason, name);
        assert.equal(r.modelTurnLaunched, false, `${name}: no model turn started`);
        assert.equal(section<Record<string, number>>(r, "launchCounts").providerTurn, 0);
        assert.ok(["POSTURE_BLOCKED", "AUTH_BLOCKED"].includes(r.outcome), `${name}: ${r.outcome}`);
        assert.match(r.detail, /refused before it started/u);
        assert.deepEqual([runs.count, section<{ applied: unknown }>(r, "candidate").applied], [0, null], `${name}: nothing applied or verified`);
        assert.equal(section<{ unchanged: boolean }>(r, "primary").unchanged, true);
        if (name === "shared-git") assert.deepEqual(section<Array<{ checks: Record<string, boolean> }>>(r, "views")[0]?.checks,
          { ownedLocation: true, primaryDisjoint: true, gitAbsent: false, providerStateAbsent: true }, "refused for the .git alone");
      }
    } finally { await rm(placed, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
  })));

// ---------------------------------------------------------------- the O5.5B11 flow (offline rehearsal)

test("O5.5B11 rehearsal under the production grant: one turn, raw and single-fenced ChangeSets validated, host-applied, verified; evidence is complete and redacted",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const pretty = JSON.stringify(JSON.parse(PROPOSAL), null, 2);
    for (const [name, output, classification] of [["raw", PROPOSAL, "RAW_VALID_JSON"],
      ["fenced", `\`\`\`json\r\n${pretty.replace(/\n/gu, "\r\n")}\r\n\`\`\`\r\n`, "SINGLE_FENCED_VALID_JSON"],
      ["bare-fence", `\`\`\`\n${pretty}\n\`\`\``, "SINGLE_FENCED_VALID_JSON"]] as const) {
      const { r, runs } = await rehearse(i, root, name, output);
      assert.equal(r.outcome, "PASS", `${name}: ${r.detail} ${JSON.stringify(r.evidence.workflow)}`);
      const e = r.evidence;
      assert.deepEqual([e.schemaVersion, e.milestone, e.evidenceKind, e.provider], [PROBE_EVIDENCE_SCHEMA_VERSION, REHEARSAL, "offlineRehearsal", "claude"]);
      assert.equal(section<{ id: string }>(r, "authorization").id, REHEARSAL);
      assert.deepEqual(section<{ grant: unknown }>(r, "authorization").grant, JSON.parse(JSON.stringify(PRODUCTION.authorizations[LIVE]!.grants.claude)),
        "the rehearsal ran under exactly the production O5.5B11 grant");
      assert.deepEqual(section<Record<string, number>>(r, "launchCounts"), { providerAuthReadback: 2, providerInventory: 1, providerInitProbe: 2,
        providerTurn: 1, providerHost: 0 }, "purposes counted separately; exactly one model turn");
      assert.deepEqual([section<number>(r, "proposalCalls"), runs.count], [1, 1]);
      assert.deepEqual(section<{ checkedBeforeStart: boolean; refusals: unknown[] }>(r, "launchGuard"), { checkedBeforeStart: true, refusals: [] });
      const preflight = section<Record<string, unknown>>(r, "preflight");
      assert.deepEqual([preflight.installedVersion, preflight.bindingMatchesAuthorization, preflight.requiredEnvironment, (preflight.billing as { laneIntent: string }).laneIntent],
        ["2.1.280", true, { FUSION_CLAUDE_EXE: "set" }, "subscription"]);
      const readback = section<Record<string, unknown>>(r, "runtimeReadback");
      assert.deepEqual([readback.source, readback.runtimeVersion, readback.requestedModel, readback.effectiveModel, readback.apiKeySource, readback.tools],
        ["completedTurn", "2.1.280", "haiku", "claude-haiku-4-5-20251001", "none", ["Glob", "Grep", "Read"]]);
      const turn = (r.evidence.launches as Array<{ purpose: string; cwdClass: string; posture?: unknown }>).find(l => l.purpose === "providerTurn")!;
      assert.deepEqual([turn.cwdClass, turn.posture], ["providerView", { missing: [], widening: [] }]);
      assert.deepEqual([section<{ classification: string; accepted: boolean }>(r, "structuredOutput").classification,
        section<{ accepted: boolean }>(r, "structuredOutput").accepted], [classification, true], name);
      const proposal = section<{ validated: Array<{ path: string; expectedSha256: string; content: string }> }>(r, "proposal");
      assert.deepEqual(proposal.validated.map(op => [op.path, op.expectedSha256, op.content]), [[PROBE_TARGET, BASELINE_HASH, FIXED]]);
      assert.deepEqual(section<{ changedPaths: string[] }>(r, "candidate").changedPaths, [PROBE_TARGET], "only src/name.js changed");
      assert.deepEqual([section<{ unchanged: boolean; canariesUnchanged: boolean }>(r, "primary").unchanged,
        section<{ canariesUnchanged: boolean }>(r, "primary").canariesUnchanged], [true, true]);
      assert.ok(section<Array<{ unchanged: boolean; checks: Record<string, boolean> }>>(r, "views").every(v => v.unchanged && Object.values(v.checks).every(Boolean)));
      assert.deepEqual(section<{ leftoverOwnedTemporaries: string[] }>(r, "cleanup").leftoverOwnedTemporaries, []);
      const text = await readFile(r.evidencePath, "utf8");
      for (const secret of [i.claudeExe, "synthetic-not-a-secret-5c1e", "synthetic protected canary", PROPOSAL_PREFIX, "```", "private@example.com", "private-org"])
        assert.ok(!text.includes(secret), `${name}: evidence leaks ${secret}`);
      // The namespace and the claim belong to O5.5B11; the claim refuses a second run.
      assert.deepEqual(JSON.parse(await readFile(join(root, name, "authorization.json"), "utf8")), { authorization: REHEARSAL, milestone: REHEARSAL });
      assert.equal(JSON.parse(await readFile(join(root, name, "claude.claim.json"), "utf8")).authorization, REHEARSAL);
      assert.equal(refusal(await probe("claude", { profiles: REHEARSED, authorization: REHEARSAL, env: cleanEnv({ FUSION_CLAUDE_EXE: i.claudeExe }),
        evidenceRoot: join(root, name), binding: grantedBinding(i), registry: NO_ADAPTERS })), "alreadyAttempted");
    }
    // A rehearsal records nothing: the recorded history is exactly the two live probes.
    assert.deepEqual(changeProposalLiveRecords("claude", "claude-one-shot").map(record => [record.milestone, record.outcome]),
      [["O5.5B9", "MALFORMED_PROPOSAL"], ["O5.5B11", "PASS"]]);
    assert.deepEqual([REAL_WRITER_LIVE_GATE_AUTHORIZED, liveWriterAuthorization().authorized, writerGateReport().realWriterModeReady], [false, false, false]);
  })));

test("O5.5B11 rehearsal: malformed fence, trailing prose and wrong schema are MALFORMED_PROPOSAL, an out-of-scope file INVALID_CHANGESET — one turn, never retried, nothing applied",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const outOfScope = JSON.stringify(changeSet([["test/name.test.js", PROBE_FIXTURE_FILES["test/name.test.js"]!, "// gutted\n"]]));
    for (const [name, output, outcome, classification] of [
      ["malformed-fence", "```json\n{\"schemaVersion\":1,\"operations\":[}\n```", "MALFORMED_PROPOSAL", "SINGLE_FENCED_INVALID_JSON"],
      ["trailing-prose", `\`\`\`json\n${PROPOSAL}\n\`\`\`\nThis trims the name.`, "MALFORMED_PROPOSAL", "EXTRA_TEXT"],
      ["wrong-schema", `\`\`\`json\n${JSON.stringify({ ...JSON.parse(PROPOSAL), note: "x" })}\n\`\`\``, "MALFORMED_PROPOSAL", "INVALID_SCHEMA"],
      ["raw-wrong-schema", JSON.stringify({ ...JSON.parse(PROPOSAL), note: "x" }), "MALFORMED_PROPOSAL", "INVALID_SCHEMA"],
      ["out-of-scope", outOfScope, "INVALID_CHANGESET", "RAW_VALID_JSON"]] as const) {
      const { r, runs } = await rehearse(i, root, name, output);
      assert.equal(r.outcome, outcome, `${name}: ${r.detail}`);
      assert.deepEqual([section<Record<string, number>>(r, "launchCounts").providerTurn, section<number>(r, "proposalCalls"), runs.count], [1, 1, 0], name);
      assert.equal(section<{ classification: string }>(r, "structuredOutput").classification, classification, name);
      assert.equal(section<{ applied: unknown }>(r, "candidate").applied, null, `${name}: nothing applied`);
      assert.equal(section<{ unchanged: boolean }>(r, "primary").unchanged, true);
      assert.ok(!(await readFile(r.evidencePath, "utf8")).includes("This trims the name"), "no refused reply text is persisted");
    }
  })));

test("O5.5B11 regression: under the test authorization Muse still refuses a fenced proposal after one turn (the O5.5B11 grant has no Muse)",
  { skip }, async () => withInstalls(async i => withRoot(async root => {
    const runs = { count: 0 };
    const r = report(await probe("muse", { profiles: TEST_PROFILES, env: cleanEnv(), evidenceRoot: join(root, "muse"), binding: museBinding(i),
      offlineRehearsal: true, registry: testRegistry(i, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL_PREFIX, FUSION_FAKE_OUTPUT: `\`\`\`json\n${PROPOSAL}\n\`\`\``,
        FUSION_FAKE_EXPECT_EFFORT: "minimal" }), compose: rehearsalCompose(root, runs) }));
    assert.deepEqual([r.outcome, section<Record<string, number>>(r, "launchCounts").providerTurn, runs.count], ["MALFORMED_PROPOSAL", 1, 0]);
  })));

// ---------------------------------------------------------------- the fixture

test("O5.5B11 fixture: the baseline fails exactly 2 of 3 tests and the intended fix passes 3 of 3 (host node, synthetic code only)", async () =>
  withRoot(async root => {
    const run = async (name: string, source: string) => {
      const dir = join(root, name);
      for (const [path, content] of Object.entries({ ...PROBE_FIXTURE_FILES, [PROBE_TARGET]: source })) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), content);
      }
      const child = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/name.test.js"], { cwd: dir, encoding: "utf8", timeout: 60_000,
        windowsHide: true, env: { SystemRoot: process.env.SystemRoot ?? "", PATH: process.env.PATH ?? "" } });
      const count = (label: string) => Number(new RegExp(`^# ${label} (\\d+)\\r?$`, "mu").exec(child.stdout)?.[1] ?? "-1");
      return [count("tests"), count("pass"), count("fail")];
    };
    assert.deepEqual(await run("baseline", PROBE_FIXTURE_FILES[PROBE_TARGET]!), [3, 1, 2]);
    assert.deepEqual(await run("fixed", FIXED), [3, 3, 0]);
    assert.deepEqual(Object.keys(PROBE_FIXTURE_FILES).sort(), [".gitignore", "README.md", "package.json", "src/name.js", "test/name.test.js"]);
    assert.equal(JSON.parse(PROBE_FIXTURE_FILES["package.json"]!).dependencies, undefined, "no dependency, no network");
  }));
