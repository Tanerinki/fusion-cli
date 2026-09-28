import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { EXPLORATION_LIMITS, explorationMode, fusionRequests, mentionedPaths, parseFindings, planContext } from "../src/app/exploration.js";
import { readJsonReply } from "../src/app/orchestration/envelope.js";
import { areaChoices } from "../src/app/orchestration/investigations.js";
import { routingDecisionFrom, type DecisionReading } from "../src/core/orchestration/contracts.js";
import { inventoryFolder, type RepositoryInventory } from "../src/app/repository-inventory.js";
import { addOrchestration, newSessionState, noOrchestration, planTurn, readSessionMetadata, sessionMetadataPath, writeSessionMetadata } from "../src/app/session.js";
import { issueConfirmedPlanAuthorization, liveWriterAuthorization } from "../src/app/writer-gate.js";
import { SUMMARY_APPROVAL_ANSWERS, validateHumanApprovalRecord } from "../src/core/delivery/approval.js";
import { FusionFailure } from "../src/core/errors.js";
import { classifyIntent, grantFor, type IntentKind } from "../src/core/intent.js";
import { folderFingerprint, listFolder } from "../src/platform/workspace/folder-source.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { ProviderViewStore } from "../src/platform/workspace/provider-views.js";
import { classifySensitivePath, keysOnlyYaml, prepareProviderInput, PROVIDER_INPUT_LIMITS, redactSecrets } from "../src/platform/workspace/sensitive-input.js";
import { createHomeAssistantFixture, HA_SENTINELS } from "./fixtures/home-assistant.js";

/**
 * v0.2 foundations, offline and without any provider: the sensitive-input policy, the read-only folder source and its view,
 * the host's intent classification and grants, the session's turn plans and safe metadata, the exploration contracts, the
 * shell's approval and build confirmations.
 */
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
async function withDir<T>(work: (dir: string) => Promise<T>): Promise<T> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "v02-found-")));
  try { return await work(dir); } finally { await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}
async function files(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true }))
    if (entry.isFile()) out.push(relative(root, join(entry.parentPath, entry.name)).split(sep).join("/"));
  return out.sort();
}

// ---------------------------------------------------------------- sensitive input

test("v0.2 sensitive input: credentials, key material and authentication stores are withheld; secrets files keep key names only", () => {
  const cases: Array<[string, "exclude" | "keysOnly" | undefined]> = [
    [".env", "keysOnly"], [".env.production", "keysOnly"], ["app/.env.local", "keysOnly"], [".env.example", undefined], [".env.template", undefined],
    ["secrets.yaml", "keysOnly"], ["config/secret-prod.yml", "keysOnly"], ["secrets.json", "exclude"], ["secret.toml", "exclude"],
    ["credentials", "exclude"], ["aws/credentials.json", "exclude"], ["deploy/service-account.json", "exclude"], ["token.txt", "exclude"],
    ["server.pem", "exclude"], ["certs/site.key", "exclude"], ["id_rsa", "exclude"], ["id_ed25519.pub", "exclude"], [".git-credentials", "exclude"],
    [".npmrc", "exclude"], [".netrc", "exclude"], ["vault.kdbx", "exclude"], [".storage/auth", "exclude"], [".storage/core.config_entries", "exclude"],
    ["home/.ssh/config", "exclude"], [".aws/config", "exclude"], ["home-assistant_v2.db", "exclude"], ["data.sqlite-wal", "exclude"],
    ["ip_bans.yaml", "exclude"], ["src/index.ts", undefined], ["configuration.yaml", undefined], ["src/auth/token-service.ts", undefined],
    ["docs/secrets.md", undefined],
  ];
  for (const [path, expected] of cases) assert.equal(classifySensitivePath(path)?.treatment, expected, path);
});

test("v0.2 sensitive input: high-confidence secret values are masked in any text; config files also mask plain secret-named values", () => {
  const github = `ghp_${"a".repeat(36)}`, jwt = `eyJ${"h".repeat(20)}.${"p".repeat(20)}.${"s".repeat(20)}`;
  const text = [`token in docs: ${github}`, `Authorization: Bearer ${"b".repeat(32)}`, `url: postgres://app:pa55w0rd-x@db.local/app`,
    `key: sk-ant-${"k".repeat(24)}`, `aws: AKIA${"A".repeat(16)}`, `jwt: ${jwt}`].join("\n");
  const masked = redactSecrets(text);
  for (const secret of [github, "b".repeat(32), "pa55w0rd-x", `sk-ant-${"k".repeat(24)}`, `AKIA${"A".repeat(16)}`, jwt])
    assert.ok(!masked.text.includes(secret), secret);
  assert.equal(masked.redactions, 6);
  // Source code: a quoted literal assigned to a secret-named key is masked; a function call is not a secret.
  const code = redactSecrets(`const password = "correct-horse";\nconst token = getToken();\n`);
  assert.equal(code.text, `const password = "<redacted:password>";\nconst token = getToken();\n`);
  // Configuration files: plain values are masked; references (!secret, $VAR, templates) are kept.
  const config = prepareProviderInput("configuration.yaml", Buffer.from("mqtt:\n  password: hunter2hunter\n  api_key: !secret api\n  token: ${TOKEN}\n"));
  assert.equal(config.status, "redacted");
  assert.equal(config.content!.toString("utf8"), "mqtt:\n  password: <redacted:password:1>\n  api_key: !secret api\n  token: ${TOKEN}\n");
  const plain = Buffer.from("light:\n  - platform: hue\n");
  assert.deepEqual(prepareProviderInput("lights.yaml", plain), { status: "included", content: plain });
});

test("v0.2 sensitive input: keys-only files, private keys, binaries and oversized files; the sentinels never survive", () => {
  const secrets = prepareProviderInput("secrets.yaml", Buffer.from(`# my secrets\nmqtt_password: ${HA_SENTINELS.secretsYaml}\nlist:\n  - ${HA_SENTINELS.githubToken}\n`));
  assert.equal(secrets.status, "redacted");
  assert.equal(secrets.content!.toString("utf8"), "# Fusion: values redacted; only the key names of this file are shared.\nmqtt_password: <redacted>\nlist: <redacted>\n  <redacted>\n");
  assert.equal(keysOnlyYaml("a: 1\n# comment\n\nb:\n  c: x\n"), "# Fusion: values redacted; only the key names of this file are shared.\na: <redacted>\nb: <redacted>\n  c: <redacted>\n");
  const env = prepareProviderInput(".env", Buffer.from(`DATABASE_URL=postgres://u:${HA_SENTINELS.inlinePassword}@h/db\nexport API_KEY=abc123abc123\n`));
  assert.equal(env.content!.toString("utf8"), "# Fusion: values redacted; only the variable names of this file are shared.\nDATABASE_URL=<redacted>\nexport API_KEY=<redacted>\n");
  assert.equal(prepareProviderInput("notes.txt", Buffer.from("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n")).status, "excluded");
  assert.equal(prepareProviderInput("image.png", Buffer.from([0x89, 0x50, 0x00, 0x47])).status, "excluded");
  assert.equal(prepareProviderInput("big.txt", Buffer.alloc(PROVIDER_INPUT_LIMITS.maxTextBytes + 1, 0x61)).status, "excluded");
  assert.deepEqual(prepareProviderInput(".storage/auth", Buffer.from(HA_SENTINELS.storageAuth)), { status: "excluded", reason: "authentication and integration store" });
});

// ---------------------------------------------------------------- folder source and view

test("v0.2 folder source: a bounded walk that skips dependency and VCS folders; the fingerprint ignores runtime state, not config", () =>
  withDir(async dir => {
    const root = await createHomeAssistantFixture(dir);
    await mkdir(join(root, "node_modules", "x"), { recursive: true });
    await writeFile(join(root, "node_modules", "x", "index.js"), "x");
    await mkdir(join(root, ".git"));
    await writeFile(join(root, ".git", "config"), "[core]");
    const listing = await listFolder(root);
    const paths = listing.entries.map(e => e.path);
    assert.ok(paths.includes("configuration.yaml") && paths.includes(".storage/auth") && paths.includes("custom_components/example/manifest.json"));
    assert.ok(!paths.some(p => p.startsWith("node_modules/") || p.startsWith(".git/")));
    assert.deepEqual(listing.skippedDirectories, [".git", "node_modules"]);
    assert.equal(listing.truncated, false);
    const before = await folderFingerprint(root);
    await writeFile(join(root, ".storage", "auth"), `${HA_SENTINELS.storageAuth}-rotated-by-home-assistant`);
    await writeFile(join(root, "home-assistant.log"), "a longer log line written by the running service\n");
    assert.equal(await folderFingerprint(root), before, "runtime state and logs change on their own");
    await writeFile(join(root, "automations.yaml"), "[]\n");
    assert.notEqual(await folderFingerprint(root), before, "a configuration change is detected");
    // The inventory: a folder, Home Assistant recognised, sensitive files reported by path only.
    const inventory = await inventoryFolder(root, await listFolder(root), { deep: false });
    assert.equal(inventory.source, "folder");
    assert.equal(inventory.projects[0]!.kind, "Home Assistant configuration");
    assert.deepEqual(inventory.sensitive.files.map(f => `${f.path}:${f.treatment}`).sort(),
      [".storage/:exclude", "home-assistant_v2.db:exclude", "secrets.yaml:keysOnly"]);
    assert.ok(!JSON.stringify(inventory).includes("SENTINEL"), "the inventory never reads secret content");
  }));

test("v0.2 folder view: the input policy runs while copying — withheld files are never written, secrets files arrive as key names", () =>
  withDir(async dir => {
    const root = await createHomeAssistantFixture(dir);
    // A file above the sharing limit is withheld without being read.
    await writeFile(join(root, "big.txt"), Buffer.alloc(PROVIDER_INPUT_LIMITS.maxTextBytes + 1, 0x61));
    const store = new ProviderViewStore({ primaryRoot: root, git: await ProcessGitClient.fromPath(process.env, true), excludedPaths: [] });
    const listing = await listFolder(root);
    const view = await store.folder("chat-0123456789ab", listing.entries.map(e => e.path), prepareProviderInput);
    try {
      assert.equal(view.kind, "folder");
      assert.equal(view.baseCommit, "");
      const shared = await files(view.path);
      assert.ok(!shared.some(p => p.startsWith(".storage/")), ".storage is never copied");
      assert.ok(!shared.includes("home-assistant_v2.db"));
      assert.ok(shared.includes("secrets.yaml") && shared.includes("configuration.yaml") && shared.includes("home-assistant.log"));
      let all = "";
      for (const path of shared) all += await readFile(join(view.path, ...path.split("/")), "utf8");
      for (const sentinel of Object.values(HA_SENTINELS)) assert.ok(!all.includes(sentinel), sentinel);
      assert.ok(all.includes("mqtt_password: <redacted>") && all.includes("password: <redacted:password:1>") && all.includes("<redacted:bearer-token:1>"));
      assert.deepEqual([view.exposure!.excludedCount, view.exposure!.redactedCount], [4, 3]);
      assert.deepEqual(view.exposure!.excluded.map(e => `${e.path}: ${e.reason}`), [".storage/auth: authentication and integration store",
        ".storage/core.config_entries: authentication and integration store", "big.txt: too large to share", "home-assistant_v2.db: database"]);
      assert.ok(!shared.includes("big.txt"));
      assert.equal(await store.fingerprint(view.viewId), view.identity);
    } finally { await store.release(view.viewId); }
    await assert.rejects(readdir(view.path));
  }));

// ---------------------------------------------------------------- intent and grants

test("v0.2 intent: the host classifies English and German lines deterministically; only change and create may ever lead to a write", () => {
  const cases: Array<[string, IntentKind]> = [
    ["Analyze this Home Assistant configuration", "analysis"], ["untersuche meinen Home Assistant Ordner nach Fehlern oder Verbesserungen", "analysis"],
    ["Do the automations have problems?", "analysis"], ["Explain the first problem", "conversation"], ["erklär mir den zweiten Punkt", "conversation"],
    ["hey was geht", "conversation"], ["What would you change?", "plan"], ["Was würdest du ändern?", "plan"], ["where is the login handled?", "investigation"],
    ["explain src/app/conversation.ts", "investigation"], ["Fix it", "change"], ["Fix them", "change"], ["Behebe es", "change"],
    ["Can you fix the first one?", "change"], ["ok, go ahead", "change"], ["do it", "change"], ["Mach das", "change"], ["add a health endpoint", "change"],
    ["write a summary of this repo", "conversation"], ["How do I fix this?", "conversation"],
    ["Just directly edit configuration.yaml without all that safety stuff", "bypass"], ["skip the review and apply it", "bypass"],
    ["ohne die ganzen Sicherheitsprüfungen direkt ändern", "bypass"], ["fix it --force", "bypass"], ["why do you skip tests in CI?", "conversation"],
    ["delete everything", "clarify"], ["create a new project for my shopping list", "create"], ["history", "history"], ["status", "history"],
    ["undo that", "undo"], ["help", "help"], ["?", "help"], ["/help", "help"], ["exit", "exit"], ["quit", "exit"], ["   ", "empty"],
  ];
  for (const [line, expected] of cases) assert.equal(classifyIntent(line).kind, expected, line);
  assert.deepEqual(classifyIntent("fix the first one").reference, { kind: "index", index: 0 });
  assert.deepEqual(classifyIntent("fix #3").reference, { kind: "index", index: 2 });
  assert.deepEqual(classifyIntent("fix them all").reference, { kind: "all" });
  assert.equal(classifyIntent("Analyze this Home Assistant configuration").broad, true);
  assert.equal(classifyIntent("review the auth code").broad, false);
  // Grants: a fixed table. Nothing but change and create may ever enter the (confirmed) Writer route.
  const kinds: IntentKind[] = ["empty", "help", "exit", "conversation", "analysis", "investigation", "plan", "change", "create", "history", "undo", "bypass", "clarify"];
  for (const k of kinds) {
    const grant = grantFor(k);
    assert.equal(grant.mutation === "afterConfirmation", k === "change" || k === "create", k);
    assert.equal(grant.providers === "readOnly", ["conversation", "analysis", "investigation", "plan", "change", "create"].includes(k), k);
  }
  // Control characters and length are bounded; the classifier never throws.
  assert.equal(classifyIntent("\u001b[31mfix it\u0007").kind, "change");
  assert.equal(classifyIntent("x".repeat(20_000)).text.length, 8_000);
});

test("v0.2 session: plans never exceed the grant; a folder never gets a change; follow-ups resolve against the bounded findings", () => {
  const state = newSessionState();
  state.findings = ["configuration.yaml: use_x_forwarded_for without trusted_proxies", "automations.yaml: light.livingroom_lamp does not exist"];
  const explain = planTurn(classifyIntent("explain the second finding"), state, "folder");
  assert.equal(explain.kind, "ask");
  assert.match((explain as { message: string }).message, /refers to this finding from the earlier analysis:\n2\. automations\.yaml/u);
  assert.equal(state.focus, 1);
  // "fix it" follows the focus; in a folder it is blocked, with the task it would have been.
  const blocked = planTurn(classifyIntent("fix it"), state, "folder");
  assert.deepEqual(blocked, { kind: "blocked", reason: "noGitBaseline", task: `Fix this finding from the analysis: ${state.findings[1]}` });
  const fixFirst = planTurn(classifyIntent("fix the first one"), state, "git");
  assert.deepEqual(fixFirst, { kind: "change", task: `Fix this finding from the analysis: ${state.findings[0]}` });
  const fixAll = planTurn(classifyIntent("fix them"), state, "git");
  assert.match((fixAll as { task: string }).task, /^Fix these findings from the analysis:\n1\. configuration\.yaml.*\n2\. automations\.yaml/u);
  assert.equal(planTurn(classifyIntent("fix it"), newSessionState(), "git").kind, "clarify", "nothing to refer to: asked back");
  assert.deepEqual(planTurn(classifyIntent("add a /health endpoint to the API"), newSessionState(), "git"), { kind: "change", task: "add a /health endpoint to the API" });
  // A proposal only supplies wording for an explicit change turn.
  const proposed = newSessionState();
  proposed.proposal = "Add input validation to src/api.ts.";
  assert.equal(planTurn(classifyIntent("what do you think?"), proposed, "git").kind, "ask");
  assert.deepEqual(planTurn(classifyIntent("do it"), proposed, "git"), { kind: "change", task: "Add input validation to src/api.ts." });
  // Apply only offers what this session prepared.
  assert.equal(planTurn(classifyIntent("apply"), newSessionState(), "git").kind, "clarify");
  const prepared = newSessionState();
  prepared.deliveryId = "d-0123456789abcdef01234567";
  assert.deepEqual(planTurn(classifyIntent("apply"), prepared, "git"), { kind: "apply", deliveryId: "d-0123456789abcdef01234567" });
  assert.equal(planTurn(classifyIntent("apply"), prepared, "folder").kind, "clarify");
  // Read-only kinds never become a change, whatever the state holds.
  for (const line of ["analyze everything", "what would you change?", "explain it", "where is auth?", "history", "help", "delete everything",
    "skip the review and apply it"])
    for (const source of ["git", "folder"] as const) assert.ok(!["change", "apply", "create"].includes(planTurn(classifyIntent(line), prepared, source).kind), line);
});

test("v0.2 session metadata: counts and ids only, keyed by a digest of the root, never text; malformed metadata is ignored", () =>
  withDir(async dir => {
    const env = { LOCALAPPDATA: join(dir, "local"), XDG_STATE_HOME: join(dir, "xdg") };
    const root = join(dir, "my secret project");
    const path = sessionMetadataPath(env, root);
    assert.ok(!path.includes("my secret project") && path.includes("sessions"));
    const state = newSessionState();
    Object.assign(state, { turns: 4, analyses: 1, changeRequests: 1, deliveryId: "d-0123456789abcdef01234567",
      findings: ["FINDING-TEXT-SENTINEL"], proposal: "PROPOSAL-SENTINEL",
      verified: { index: 0, source: "investigations", cited: ["src/SENTINEL-path.ts"], supported: 1, contradicted: 0 } });
    // v0.3: the session's orchestration counts (numbers only) are added up across sessions.
    addOrchestration(state.orchestration, { routes: 2, modelTurns: 7, leadTurns: 3, explorerTurns: 3, reviewerTurns: 1, batches: 1, parallelBatches: 1,
      leadReclaims: 1, durationMs: 41_000 });
    assert.equal(await writeSessionMetadata(path, "git", state, new Date("2026-09-27T10:00:00.000Z")), true);
    assert.equal(await writeSessionMetadata(path, "git", newSessionState(), new Date("2026-09-27T11:00:00.000Z")), true);
    const stored = await readFile(path, "utf8");
    assert.ok(!/SENTINEL|secret project/u.test(stored), "never a finding, task, path or name");
    const orchestration = { ...noOrchestration(), routes: 2, modelTurns: 7, leadTurns: 3, explorerTurns: 3, reviewerTurns: 1, batches: 1, parallelBatches: 1,
      leadReclaims: 1, durationMs: 41_000 };
    assert.deepEqual(await readSessionMetadata(path), { format: "fusion.shellSession", version: 2, source: "git", lastUsedAt: "2026-09-27T11:00:00.000Z",
      sessions: 2, turns: 4, analyses: 1, changeRequests: 1, lastDeliveryId: "d-0123456789abcdef01234567", orchestration });
    // A v0.2 file (version 1, no orchestration counts) is still read, as having none.
    await writeFile(path, JSON.stringify({ format: "fusion.shellSession", version: 1, source: "folder", lastUsedAt: "2026-09-27T09:00:00.000Z",
      sessions: 3, turns: 9, analyses: 2, changeRequests: 0, lastDeliveryId: null }));
    assert.deepEqual((await readSessionMetadata(path))?.orchestration, noOrchestration());
    for (const malformed of [{ format: "fusion.shellSession", version: 1, extra: true },
      { format: "fusion.shellSession", version: 2, source: "git", lastUsedAt: "2026-09-27T09:00:00.000Z", sessions: 1, turns: 1, analyses: 0, changeRequests: 0,
        lastDeliveryId: null, orchestration: { ...noOrchestration(), prompt: "text" } },
      { format: "fusion.shellSession", version: 2, source: "git", lastUsedAt: "2026-09-27T09:00:00.000Z", sessions: 1, turns: 1, analyses: 0, changeRequests: 0,
        lastDeliveryId: null, orchestration: { ...noOrchestration(), modelTurns: -1 } }]) {
      await writeFile(path, JSON.stringify(malformed));
      assert.equal(await readSessionMetadata(path), undefined, JSON.stringify(malformed).slice(0, 60));
    }
    assert.equal(await readSessionMetadata(join(dir, "missing.json")), undefined);
  }));

// ---------------------------------------------------------------- exploration contracts

const inventory = (directories: Array<[string, number]>, trackedFiles: number): RepositoryInventory => ({
  source: "git", name: "big", trackedFiles, languages: [], directories: directories.map(([path, files]) => ({ path, files })), packageManagers: [],
  manifests: [], frameworks: [], entrypoints: ["src/index.ts"], tests: { files: 0, directories: [], frameworks: [] }, ci: [], containers: [], config: [],
  docs: ["docs/guide.md"], git: { branch: "main", head: "abc", commits: 1, dirtyPaths: 0, recent: [] }, largestFiles: [], truncated: false,
  projects: [], sensitive: { count: 0, files: [] } });

test("v0.2 exploration (v0.3 routing decisions): findings and cited paths are parsed boundedly; the lead's decision is strict; Fusion's areas are the fallback", () => {
  assert.deepEqual(parseFindings("Overview...\n\n## Findings:\n1. **configuration.yaml**: no trusted_proxies\n2) automations.yaml: bad id\n\nNotes 3. not a finding"),
    ["configuration.yaml: no trusted_proxies", "automations.yaml: bad id"]);
  assert.deepEqual(parseFindings("Findings: none"), []);
  assert.equal(parseFindings(Array.from({ length: 40 }, (_, i) => `${i + 1}. item ${"x".repeat(400)}`).join("\n")).length, EXPLORATION_LIMITS.maxFindings);
  assert.ok(parseFindings(`1. ${"y".repeat(1000)}`)[0]!.length <= EXPLORATION_LIMITS.maxFindingChars);
  assert.deepEqual(mentionedPaths("See `src/app/x.ts`, configuration.yaml and ../etc/passwd or https://example.com/a.js.").sort(),
    ["configuration.yaml", "src/app/x.ts"]);
  const inv = inventory([["src", 300], ["lib", 120], ["docs", 40], ["test", 90]], 550);
  assert.equal(explorationMode(inv, true, false), "team");
  assert.equal(explorationMode(inv, false, false), "single");
  assert.equal(explorationMode(inventory([["src", 20]], 20), true, false), "single");
  // v0.3: the closed routing-decision contract, read from one JSON value (raw or one outer fence), refused with a safe category.
  const areas = areaChoices(inv);
  const rules = { allowed: ["answer", "delegate"] as const, areas, maxInvestigations: 3, claimAllowed: true };
  const plan = (value: unknown) => typeof value === "string" ? value : JSON.stringify(value);
  const read = (value: unknown): DecisionReading => {
    const json = readJsonReply(plan(value));
    return json.accepted ? routingDecisionFrom(json.value, { ...rules, allowed: [...rules.allowed] }) : { accepted: false, category: json.category };
  };
  const good = read({ action: "delegate", investigations: [{ area: "src", question: "How are requests handled?" }, { area: "lib", question: "Any unsafe parsing?" }] });
  assert.deepEqual(good, { accepted: true, decision: { action: "delegate", investigations: [{ area: "src", question: "How are requests handled?" },
    { area: "lib", question: "Any unsafe parsing?" }] } });
  // One outer fence (as real replies come) and a trailing "/" or leading "./" are read; nothing else is repaired.
  const fenced = read(`\`\`\`json\n${plan({ action: "delegate", investigations: [{ area: "lib/", question: "Unsafe parsing?" }, { area: "./docs", question: "Stale docs?" }] })}\n\`\`\`\n`);
  assert.deepEqual(fenced.accepted && fenced.decision.action === "delegate" ? fenced.decision.investigations.map(i => i.area) : fenced, ["lib", "docs"]);
  const delegate = (investigations: unknown) => ({ action: "delegate", investigations });
  const categories: Array<[unknown, string]> = [
    ["", "empty reply"], ["not json at all", "invalid JSON"], ["{\"action\": [", "invalid JSON"],
    [`Here is my plan:\n${plan({ action: "answer" })}`, "prose around the JSON"],
    [`Plan:\n\`\`\`json\n${plan({ action: "answer" })}\n\`\`\``, "prose around the JSON"],
    [`${plan({ action: "answer" })}\nI chose to answer because the question is small.`, "prose around the JSON"],
    [`${plan({ action: "answer" })}\n${plan({ action: "answer" })}`, "more than one JSON value or fence"],
    [`\`\`\`json\n${plan({ action: "answer" })}\n\`\`\`\n\`\`\`json\n{}\n\`\`\``, "more than one JSON value or fence"],
    [delegate([]), "no investigations"], [delegate(["src", "lib", "docs", "test"].map(area => ({ area, question: "q" }))), "too many investigations"],
    [delegate([{ area: "src", question: "a" }, { area: "src/", question: "b" }]), "duplicate area"],
    [delegate([{ area: "src/app", question: "q" }]), "unknown area"], [delegate([{ area: "/etc", question: "q" }]), "unknown area"],
    [delegate([{ area: "src" }]), "schema mismatch"], [delegate([{ area: "src", question: "q", priority: 1 }]), "schema mismatch"],
    [{ ...delegate([{ area: "src", question: "q" }]), note: "x" }, "schema mismatch"], [{ areas: [{ id: "src", reason: "r" }] }, "schema mismatch"],
    [delegate([{ area: 3, question: "q" }]), "schema mismatch"], [delegate([{ area: "src", question: "   " }]), "schema mismatch"],
    [delegate([{ area: "src", question: "x".repeat(201) }]), "question too long"], [[{ area: "src", question: "q" }], "schema mismatch"],
    [{ action: "synthesize" }, "action not allowed now"], [{ action: "rewrite everything" }, "unknown action"],
    ['{"action":"delegate","investigations":[{"area":"src","question":"q","area":"lib"}]}', "invalid JSON"],
  ];
  for (const [reply, category] of categories) assert.deepEqual(read(reply), { accepted: false, category }, plan(reply));
  // The planning context: the bounded inventory and the closed list of ids, nothing else.
  assert.match(planContext(inv, areas), /\nAreas you may choose \(id: files\):\n- src: 300 file\(s\)\n- lib: 120 file\(s\)\n- docs: 40 file\(s\)\n- test: 90 file\(s\)$/u);
  assert.deepEqual(fusionRequests(inv, "find the problems").map(r => r.area), ["src", "lib", "docs"]);
  assert.deepEqual(fusionRequests(inv, "find the problems", new Set(["lib"])).map(r => r.area), ["src", "docs", "test"], "never a withheld area");
});

// ---------------------------------------------------------------- approval and build confirmations

test("v0.2 approvals: the stored record accepts exactly the two human confirmation kinds; the shell's yes and build confirmation are explicit and bound", () => {
  const record = { format: "fusion.deliveryHumanApproval", version: 2, deliveryId: "d-0123456789abcdef01234567", manifestSha256: "a".repeat(64),
    bundleSha256: "b".repeat(64), repositoryIdentity: "c".repeat(64), baseCommit: "d".repeat(40), checkoutSha256: "e".repeat(64),
    confirmation: "confirmedVerifiedSummary", approvedAt: "2026-09-27T10:00:00.000Z" };
  assert.equal(validateHumanApprovalRecord(record).confirmation, "confirmedVerifiedSummary");
  assert.equal(validateHumanApprovalRecord({ ...record, confirmation: "typedManifestSha256" }).confirmation, "typedManifestSha256");
  for (const confirmation of ["y", "auto", "", null, 1]) assert.throws(() => validateHumanApprovalRecord({ ...record, confirmation }), kind("SecurityViolation"));
  assert.deepEqual([...SUMMARY_APPROVAL_ANSWERS], ["y", "yes", "j", "ja"]);
  // The shell's build confirmation: an explicit yes, bound to the task, the exact scope and the repository, used once.
  const request = { task: "Fix the tax basis.", paths: ["src/quote.ts"], repositoryRoot: join(tmpdir(), "repo") };
  for (const answer of [null, "", "n", "no", "maybe", "yes please", "build?"]) assert.equal(issueConfirmedPlanAuthorization({ ...request, answer }), undefined, String(answer));
  const authorization = issueConfirmedPlanAuthorization({ ...request, answer: " JA " })!;
  assert.equal(authorization.confirmation, "confirmedBuildPlan");
  assert.equal(liveWriterAuthorization({ authorization, ...request, task: "Something else." }).authorized, false, "bound to the task");
  assert.equal(liveWriterAuthorization({ authorization, ...request, paths: ["src/other.ts"] }).authorized, false, "bound to the scope");
  assert.equal(liveWriterAuthorization({ authorization, ...request }).authorized, true);
  assert.equal(liveWriterAuthorization({ authorization, ...request }).authorized, false, "used once");
  assert.equal(liveWriterAuthorization({ authorization: { ...authorization }, ...request }).authorized, false, "a copy is never an authorization");
});

test("v0.2 guard: the new host policy modules name no provider or model", async () => {
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama|sonnet|haiku/iu;
  for (const path of ["src/core/intent.ts", "src/platform/workspace/sensitive-input.ts", "src/platform/workspace/folder-source.ts",
    "src/app/session.ts", "src/app/exploration.ts", "src/cli/shell.ts", "src/cli/build-flow.ts",
    // v0.3: adaptive orchestration is host policy too.
    "src/core/orchestration/budget.ts", "src/core/orchestration/contracts.ts", "src/core/orchestration/route.ts", "src/app/orchestration/adaptive.ts",
    "src/app/orchestration/investigations.ts", "src/app/orchestration/scheduler.ts", "src/app/orchestration/envelope.ts"])
    assert.doesNotMatch(await readFile(join(process.cwd(), path), "utf8"), forbidden, path);
  assert.ok(dirname(join(process.cwd(), "src")).length > 0);
});
