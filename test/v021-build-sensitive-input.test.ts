import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { test } from "node:test";
import { prepareBuildDelivery } from "../src/app/build-delivery.js";
import { SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { parseConfig } from "../src/app/config.js";
import { ControlPlane } from "../src/app/control-plane.js";
import { SHELL_ANALYSIS_INSTRUCTION } from "../src/app/exploration.js";
import { buildWriterCandidates, type ProviderRegistry } from "../src/app/providers.js";
import { ROUTE_ROLES, type RouteRole } from "../src/app/route-probe.js";
import { providerViewPort, WRITER_ROLES, type ProductionWriterOptions, type WriterComposition } from "../src/app/writer-composition.js";
import { APPLY_QUESTION, PLAN_QUESTION } from "../src/cli/build-flow.js";
import { runCli } from "../src/cli/run.js";
import { SHELL_PROMPT } from "../src/cli/shell.js";
import { DockerLinuxVerificationBackend } from "../src/platform/verification/docker/backend.js";
import { VerificationService } from "../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { buildScopeProtection, prepareProviderInput, providerFacingContent, redactUnifiedDiff,
  restoreProtectedContent } from "../src/platform/workspace/sensitive-input.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker, type AttachContext } from "./fixtures/fake-docker.js";
import { changeSet, oracle, testSummary } from "./fixtures/fake-writer.js";
import { createHomeAssistantFixture, HA_FILES, HA_SENTINELS } from "./fixtures/home-assistant.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { cleanReview, fenced, plan, PREFIX, routeEnv, routeRegistry, testRouteAuthorization, testRouteBindings, type RoleScripts,
  type ScriptedTurn } from "./fixtures/route-harness.js";
import { grantedResult } from "./fixtures/v01-rig.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.2.1 — the sensitive-input policy on the BUILD (mutation) path. A conversation that turns into a change ("fix it")
 * never exposes more than the analysis did: the Lead, the Change Author and the Reviewer read masked views, secret values
 * reach no prompt and no run evidence, protected files are never in a build scope, and a normal file with an inline
 * secret can still be changed — Fusion restores the exact value host-side. Offline: real adapters on scripted fake
 * binaries (which dump what their view contained), a fake confined backend, no provider or Docker daemon.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const SENTINELS = Object.values(HA_SENTINELS);
const CONFIG = HA_FILES["configuration.yaml"]!;
const TRUSTED = "  use_x_forwarded_for: true\n  trusted_proxies:\n    - 172.30.33.0/24\n";
/** What the Change Author sees of configuration.yaml, and the fix it proposes against that view (keeping the marker). */
const FACING = providerFacingContent("configuration.yaml", Buffer.from(CONFIG))!.toString("utf8");
const PROPOSED = FACING.replace("  use_x_forwarded_for: true\n", TRUSTED);
const FIXED = CONFIG.replace("  use_x_forwarded_for: true\n", TRUSTED);
const HA_ANALYSIS = "A Home Assistant configuration.\n\nFindings:\n" +
  "1. configuration.yaml: http.use_x_forwarded_for is on but trusted_proxies is missing, so the http integration fails to load.\n" +
  "2. automations.yaml: the sunset automation targets light.livingroom_lamp, which does not exist.";

// ---------------------------------------------------------------- the policy

test("v0.2.1 policy: protected files are never a build target; a masked value is restored exactly; foreign markers refuse", () => {
  for (const path of ["secrets.yaml", ".env", ".env.production", ".storage/auth", ".storage/core.config_entries", "certs/site.pem", "deploy/site.key",
    "id_rsa", ".git-credentials", "aws/credentials.json", "tokens.json"])
    assert.ok(buildScopeProtection(path)?.secret, path);
  assert.deepEqual(buildScopeProtection("notes/deploy.txt", Buffer.from("-----BEGIN RSA PRIVATE KEY-----\nabc\n")), { reason: "contains a private key", secret: true });
  assert.deepEqual(buildScopeProtection("logo.png", Buffer.from([0x89, 0, 1])), { reason: "binary file", secret: false });
  for (const path of ["configuration.yaml", "automations.yaml", "src/index.ts"]) assert.equal(buildScopeProtection(path, Buffer.from("a: 1\n")), undefined);
  // The view shows a numbered marker; a proposal that keeps it gets the exact value back.
  assert.ok(FACING.includes("  password: <redacted:password:1>\n") && !FACING.includes(HA_SENTINELS.inlinePassword));
  assert.deepEqual(restoreProtectedContent("configuration.yaml", Buffer.from(CONFIG), PROPOSED), { status: "restored", content: FIXED, restored: 1 });
  // Removing the secret line is a normal edit; nothing needs restoring.
  const without = FACING.replace(`  password: <redacted:password:1>\n`, "");
  assert.deepEqual(restoreProtectedContent("configuration.yaml", Buffer.from(CONFIG), without), { status: "restored", content: without, restored: 0 });
  // `null`: a new file (an explicit `undefined` would select the default).
  const refused = (proposed: string, path = "configuration.yaml", original: Buffer | null = Buffer.from(CONFIG)) => {
    const result = restoreProtectedContent(path, original ?? undefined, proposed);
    assert.equal(result.status, "refused", proposed);
    return result.status === "refused" ? result.reason : "";
  };
  assert.match(refused(PROPOSED.replace("<redacted:password:1>", "<redacted:password:2>")), /marker number 2 \(password\), which does not stand for a value of this file/u);
  assert.match(refused(PROPOSED.replace("<redacted:password:1>", "<redacted:api-key:1>")), /marker number 1 \(api-key\), which does not stand/u);
  assert.match(refused(PROPOSED.replace("<redacted:password:1>", "<redacted>")), /cannot restore/u);
  assert.match(refused("new: <redacted:password:1>\n", "packages/new.yaml", null), /new file packages\/new\.yaml contains a Fusion redaction marker/u);
  assert.match(refused("x: <redacted:password:1>\n", "automations.yaml", Buffer.from(HA_FILES["automations.yaml"]!)), /had no masked values/u);
  assert.match(refused("mqtt_password: changed\n", "secrets.yaml", Buffer.from(HA_FILES["secrets.yaml"]!)), /secrets\.yaml is protected/u);
  assert.match(refused("{}", ".storage/auth", Buffer.from(HA_FILES[".storage/auth"]!)), /\.storage\/auth is protected/u);
  // Literal marker-like text a file already had stays text; a file that mixes such text with masked values is not guessed at.
  const doc = "Fusion shows <redacted:password:1> in views.\n";
  assert.deepEqual(restoreProtectedContent("docs/redaction.md", Buffer.from(doc), `${doc}More.\n`), { status: "restored", content: `${doc}More.\n`, restored: 0 });
  assert.match(refused("x", "notes.yaml", Buffer.from("Example: <redacted:token:1>\npassword: realvalue123\n")), /cannot be restored unambiguously/u);
  assert.equal(prepareProviderInput("configuration.yaml", Buffer.from(CONFIG)).status, "redacted");
});

test("v0.2.1 policy: a review diff masks secret values, keeps only key names of secrets files and hides withheld files", () => {
  const diff = ["diff --git a/configuration.yaml b/configuration.yaml", "--- a/configuration.yaml", "+++ b/configuration.yaml", "@@ -1,3 +1,4 @@",
    " mqtt:", `-  password: ${HA_SENTINELS.inlinePassword}`, "+  password: brand-new-secret-99", "+  trusted_proxies: 10.0.0.1",
    "diff --git a/secrets.yaml b/secrets.yaml", "--- a/secrets.yaml", "+++ b/secrets.yaml", "@@ -1 +1 @@", `-mqtt_password: ${HA_SENTINELS.secretsYaml}`,
    "+mqtt_password: another-secret-77", "diff --git a/.storage/auth b/.storage/auth", "+++ b/.storage/auth", `+{"token": "${HA_SENTINELS.storageAuth}"}`,
    "diff --git a/notes.txt b/notes.txt", "+++ b/notes.txt", "+-----BEGIN OPENSSH PRIVATE KEY-----", "+b3BlbnNzaC1rZXktdjEAAAAA", "+-----END OPENSSH PRIVATE KEY-----",
    "+after the key", `+token in docs: ${HA_SENTINELS.githubToken}`].join("\n");
  const masked = redactUnifiedDiff(diff).text;
  for (const secret of [...SENTINELS, "brand-new-secret-99", "another-secret-77", "b3BlbnNzaC1rZXktdjEAAAAA"]) assert.ok(!masked.includes(secret), secret);
  for (const kept of ["+  trusted_proxies: 10.0.0.1", "-  password: <redacted:password>", "+mqtt_password: <redacted>", "+<redacted>",
    "+<redacted:private-key>", "+after the key", "diff --git a/secrets.yaml b/secrets.yaml", "@@ -1,3 +1,4 @@"])
    assert.ok(masked.split("\n").includes(kept), kept);
});

// ---------------------------------------------------------------- the rig: a Home Assistant configuration under Git

interface HaRun { code: number; stdout: string; stderr: string; questions: string[]; prompts: Record<RouteRole, string[]>;
  views: Record<RouteRole, Array<Record<string, string>>> }
interface HaRig { dir: string; root: string; env: NodeJS.ProcessEnv; registry: ProviderRegistry; streamed: AttachContext[];
  cli(argv: string[], answers: Array<string | null>): Promise<HaRun> }
const VIEW_DUMP = { FUSION_FAKE_VIEW_DUMP: "1" };

/** A composition over a fake confined backend whose unit check passes only for the exactly restored fix. */
function haCompose(dir: string, streamed: AttachContext[]): (options: ProductionWriterOptions) => Promise<WriterComposition> {
  return async options => {
    const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry, { workspace: options.root, env: options.env }, WRITER_ROLES);
    const isolated = await ProcessGitClient.fromPath(process.env, true);
    const attach = oracle((command, context) => {
      const config = context.files.get("configuration.yaml")?.toString("utf8");
      const fixed = config === FIXED;
      return command.id === "unit" ? { pass: fixed, stdout: testSummary(fixed ? 1 : 0, fixed ? 0 : 1) } : { pass: false };
    }, streamed);
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: new FakeDocker({ attach }), resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE),
      dependencyStoreDirectory: join(dir, "dependency-store") });
    const verification = options.config.verification;
    const workspace = new PrivateCandidateWorkspacePort({ primaryRoot: options.root, git: isolated, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform: verification.platformRequirement, dependencies: verification.dependencies ?? "none",
      prepareDependencies: true });
    return { roles: candidates, unavailable, workspace, views: providerViewPort(options.root, isolated, options.registry, workspace),
      plan: { commands: [...(verification.confinedCommands ?? [])] }, verification: { acceptance: "offlineRehearsal", reasons: [] } };
  };
}
async function withHaRig<T>(name: string, scripts: RoleScripts, work: (rig: HaRig) => Promise<T>,
  options: Readonly<{ unitArgs?: readonly string[] }> = {}): Promise<T> {
  return withInstalls(async i => {
    const dir = join(i.dir, name);
    await mkdir(dir, { recursive: true });
    // The worst case: secrets.yaml, .storage/ and the log with a bearer token are all TRACKED.
    const root = await createHomeAssistantFixture(dir, "ha");
    await writeFile(join(root, ".gitignore"), "home-assistant_v2.db\n");
    git(root, "init", "-q"); git(root, "add", "."); git(root, "commit", "-qm", "baseline");
    const scriptDir = join(dir, "scripts");
    await mkdir(scriptDir);
    const paths = Object.fromEntries(ROUTE_ROLES.map(role => [role, join(scriptDir, `${role}.json`)])) as Record<RouteRole, string>;
    for (const role of ROUTE_ROLES) await writeFile(paths[role], JSON.stringify(scripts[role] ?? []));
    const bindings = testRouteBindings(i, testRouteAuthorization(i));
    const config = parseConfig({ schemaVersion: 1, bindings: ROUTE_ROLES.map(role => bindings[role]),
      verification: { commands: [], platformRequirement: "linux-compatible", dependencies: "none",
        confinedCommands: [{ id: "unit", executable: "/usr/local/bin/node", args: [...(options.unitArgs ?? ["--test"])], cwd: ".", timeoutMs: 180_000,
          mutationPolicy: "readOnly" }] },
      limits: { runTimeoutMs: 10 * 60_000 } });
    const registry: ProviderRegistry = { ...routeRegistry(i, paths, { Lead: VIEW_DUMP, Worker: VIEW_DUMP, Reviewer: VIEW_DUMP }), defaults: config };
    const env = routeEnv({ LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg") });
    const streamed: AttachContext[] = [];
    const read = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).map(line => JSON.parse(line) as
      { prompt?: string; files?: Record<string, string> });
    return work({ dir, root, env, registry, streamed, async cli(argv, answers) {
      let stdout = "", stderr = "";
      const queue = [...answers], questions: string[] = [];
      const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: answers.length > 0,
        ...(answers.length > 0 ? { prompt: async (question: string) => { questions.push(question); return queue.length > 0 ? queue.shift()! : null; } } : {}) },
        { env, cwd: root, registry, writerComposition: haCompose(dir, streamed) });
      const prompts = {} as Record<RouteRole, string[]>, views = {} as Record<RouteRole, Array<Record<string, string>>>;
      for (const role of ROUTE_ROLES) {
        prompts[role] = (await read(`${paths[role]}.prompts.jsonl`)).map(entry => entry.prompt!);
        views[role] = (await read(`${paths[role]}.views.jsonl`)).map(entry => entry.files!);
      }
      return { code, stdout, stderr, questions, prompts, views };
    } });
  });
}
/** Every sentinel that reached a prompt or anything a provider could read. */
function leaked(run: HaRun, secrets: readonly string[] = SENTINELS): string[] {
  const seen = ROUTE_ROLES.flatMap(role => [...run.prompts[role], ...run.views[role].flatMap(files => Object.entries(files).flat())]).join("\n");
  return secrets.filter(secret => seen.includes(secret));
}
async function treeOf(root: string): Promise<string> {
  const out: string[] = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    const rel = relative(root, join(entry.parentPath, entry.name)).split(sep).join("/");
    if (rel === ".git" || rel.startsWith(".git/") || rel === ".fusion" || rel.startsWith(".fusion/") || !entry.isFile()) continue;
    out.push(`${rel}:${sha256(await readFile(join(entry.parentPath, entry.name)))}`);
  }
  return out.sort().join("\n");
}
async function allText(root: string): Promise<string> {
  let text = "";
  let entries;
  try { entries = await readdir(root, { recursive: true, withFileTypes: true }); } catch { return text; }
  for (const entry of entries) {
    const path = join(entry.parentPath, entry.name);
    if (entry.isFile() && (await stat(path)).size < 4 * 1024 * 1024) text += `\n${await readFile(path, "utf8")}`;
  }
  return text;
}
const scope = (paths: readonly string[]): ScriptedTurn => ({ prefix: SCOPE_INSTRUCTION.slice(0, 60), output: fenced(paths) });
const analysis: ScriptedTurn = { prefix: SHELL_ANALYSIS_INSTRUCTION.slice(0, 60), output: HA_ANALYSIS };
const proposalOf = (content: string, expected = sha256(FACING)): ScriptedTurn =>
  ({ prefix: PREFIX.proposal, output: fenced({ schemaVersion: 1, operations: [{ kind: "writeText", path: "configuration.yaml", expectedSha256: expected, content }] }) });

// ---------------------------------------------------------------- analyze → fix it

test("v0.2.1 build path: analyze → fix it on a Home Assistant repository — masked views for every role, the real inline password kept, no secret in any prompt or evidence",
  { skip }, async () => withHaRig("fix-config", { Lead: [analysis, scope(["configuration.yaml"]), { prefix: PREFIX.plan, output: plan("Plan: add trusted_proxies to configuration.yaml.") }],
    Worker: [proposalOf(PROPOSED)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, async rig => {
    const before = await treeOf(rig.root);
    const ran = await rig.cli([], ["analyze this home assistant configuration", "fix the first one", "y", "exit"]);
    assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.deepEqual(ran.questions, [SHELL_PROMPT, SHELL_PROMPT, PLAN_QUESTION, SHELL_PROMPT]);
    assert.match(ran.stdout, /^Scope \(proposed by lead \([^)]+\); confirm or rerun with --path\): configuration\.yaml$/mu);
    assert.match(ran.stdout, /^Build: PASS \(offline rehearsal — never delivered\)$/mu);
    // The confined check passed only because the candidate held EXACTLY the fix with the real password restored.
    assert.equal([...ran.stdout.matchAll(/^Verification: (.*)$/gmu)].at(-1)?.[1], "PASS (docker-linux, 1 command(s))");
    const verified = rig.streamed.at(-1)!.files.get("configuration.yaml")!.toString("utf8");
    assert.equal(verified, FIXED);
    assert.ok(verified.includes(`password: ${HA_SENTINELS.inlinePassword}`));
    // Every role read masked views: no sentinel anywhere, .storage never present, secrets.yaml as key names only.
    // Low risk: the Lead analysed and proposed the scope; the Change Author proposed once (no plan or review turn at this risk).
    assert.deepEqual([ran.prompts.Lead.length, ran.prompts.Worker.length], [2, 1]);
    assert.deepEqual(leaked(ran), []);
    const views = ROUTE_ROLES.flatMap(role => ran.views[role]);
    assert.ok(views.length >= 3, `${views.length} views dumped`);
    for (const files of views) {
      assert.ok(!Object.keys(files).some(path => path.startsWith(".storage/")), Object.keys(files).join(","));
      assert.ok(files["secrets.yaml"]?.includes("mqtt_password: <redacted>"));
      assert.ok(files["configuration.yaml"]?.includes("password: <redacted:password:"));
    }
    // The Change Author was handed the digest of what it saw, never the real file's.
    const worker = ran.prompts.Worker[0]!;
    assert.ok(worker.includes(sha256(FACING)) && !worker.includes(sha256(CONFIG)));
    // The Reviewer (when the risk calls for one) saw a masked diff of the real change.
    for (const prompt of ran.prompts.Reviewer) assert.ok(prompt.includes("trusted_proxies") && !prompt.includes(HA_SENTINELS.inlinePassword));
    // The working tree is untouched; the run evidence holds no secret.
    assert.equal(await treeOf(rig.root), before);
    const evidence = await allText(join(rig.root, ".fusion")) + await allText(join(rig.dir, "localappdata")) + await allText(join(rig.dir, "xdg"));
    assert.ok(evidence.length > 0);
    for (const secret of SENTINELS) assert.ok(!evidence.includes(secret), secret);
  }));

const AUTOMATIONS = HA_FILES["automations.yaml"]!;
const AUTOMATIONS_FIXED = AUTOMATIONS.replace("light.livingroom_lamp", "light.living_room_lamp");
test("v0.2.1 build path: at medium risk the Lead plans and a fresh Reviewer reviews the candidate — every view and the review diff are masked",
  { skip }, async () => withHaRig("fresh-review", { Lead: [{ prefix: PREFIX.plan, output: plan("Plan: add trusted_proxies and fix the lamp entity.") }],
    Worker: [{ prefix: PREFIX.proposal, output: fenced({ schemaVersion: 1, operations: [
      { kind: "writeText", path: "configuration.yaml", expectedSha256: sha256(FACING), content: PROPOSED },
      { kind: "writeText", path: "automations.yaml", expectedSha256: sha256(AUTOMATIONS), content: AUTOMATIONS_FIXED }] }) }],
    Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, async rig => {
    const ran = await rig.cli(["build", "--path", "configuration.yaml", "--path", "automations.yaml", "--", "Add trusted_proxies and fix the lamp entity."], ["build"]);
    assert.equal(ran.code, 0, `${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, /^Build: PASS \(offline rehearsal — never delivered\)$/mu);
    assert.match(ran.stdout, /^Review: PASS \(1 cycle\(s\), 0 finding\(s\), 0 outstanding\)$/mu);
    assert.deepEqual([ran.prompts.Lead.length, ran.prompts.Worker.length, ran.prompts.Reviewer.length], [1, 1, 1]);
    const verified = rig.streamed.at(-1)!.files;
    assert.deepEqual([verified.get("configuration.yaml")!.toString("utf8"), verified.get("automations.yaml")!.toString("utf8")], [FIXED, AUTOMATIONS_FIXED]);
    // The Reviewer read the CANDIDATE (the fix is in it) through the same policy, and its diff shows the change, not the value.
    const [reviewerView] = ran.views.Reviewer;
    assert.ok(reviewerView!["configuration.yaml"]!.includes("trusted_proxies") && reviewerView!["configuration.yaml"]!.includes("password: <redacted:password:1>"));
    assert.ok(reviewerView!["automations.yaml"]!.includes("light.living_room_lamp"));
    const review = ran.prompts.Reviewer[0]!;
    assert.ok(review.includes("+  trusted_proxies:") && review.includes("light.living_room_lamp"));
    assert.deepEqual(leaked(ran), []);
    assert.equal(await readFile(join(rig.root, "configuration.yaml"), "utf8"), CONFIG);
  }, { unitArgs: ["--test", "automations.yaml"] }));

test("v0.2.1 build path: a scope with protected material is a human decision before any build turn — shell and expert command",
  { skip }, async () => withHaRig("protected-scope", { Lead: [analysis, scope(["configuration.yaml", "secrets.yaml"])] }, async rig => {
    const before = await treeOf(rig.root);
    const ran = await rig.cli([], ["analyze this home assistant configuration", "fix the first one", "exit"]);
    assert.equal(ran.code, 0, ran.stderr);
    assert.match(ran.stdout, /^Not started: this change would have to write a file Fusion keeps away from AI models: secrets\.yaml \(secret values; AI models only ever see its key names\)\. It holds protected material, and Fusion never hands protected material to an AI model as normal source\. Make that change yourself, or narrow the task to other files \(with --path\)\. No provider was started and nothing was changed\.$/mu);
    assert.ok(!ran.questions.includes(PLAN_QUESTION), "nothing is offered to start");
    assert.deepEqual([ran.prompts.Lead.length, ran.prompts.Worker.length, ran.prompts.Reviewer.length], [2, 0, 0]);
    // The expert command stops the same way, recorded, with no model turn — interactive or not, JSON or not.
    for (const path of [".storage/auth", "secrets.yaml", ".env", "certs/site.pem"]) {
      const refused = await rig.cli(["build", "--path", path, "--path", "configuration.yaml", "--", "Add trusted_proxies to the http config."], []);
      assert.equal(refused.code, 13, `${path}: ${refused.stdout}${refused.stderr}`);
      assert.match(refused.stdout, new RegExp(`Fusion keeps away from AI models: ${path.replace(/\./gu, "\\.")} \\(`, "u"));
    }
    const json = JSON.parse((await rig.cli(["--json", "build", "--path", ".storage/auth", "--", "Rotate the auth store."], [])).stdout) as
      { exitCode: number; outcome: { state: string; code: string } };
    assert.deepEqual([json.exitCode, json.outcome.state, json.outcome.code], [13, "DECISION_REQUIRED", "protectedMaterial"]);
    const typed = await rig.cli(["build", "--path", "secrets.yaml", "--", "Change the MQTT password."], ["build"]);
    assert.equal(typed.code, 11, typed.stdout);
    assert.deepEqual(typed.questions, [], "the confirmation is never asked for a protected scope");
    assert.deepEqual([ran.prompts.Lead.length, typed.prompts.Lead.length, typed.prompts.Worker.length], [2, 2, 0]);
    assert.equal(await treeOf(rig.root), before);
  }));

test("v0.2.1 build path: a proposal whose markers Fusion cannot restore is a decision; nothing is applied or verified", { skip }, async () =>
  withHaRig("foreign-marker", { Lead: [{ prefix: PREFIX.plan, output: plan("Plan: add trusted_proxies.") }],
    Worker: [proposalOf(PROPOSED.replace("<redacted:password:1>", "<redacted:password:7>"))] }, async rig => {
    const ran = await rig.cli(["build", "--path", "configuration.yaml", "--", "Add trusted_proxies to the http config."], ["build"]);
    assert.equal(ran.code, 13, `${ran.stdout}\n${ran.stderr}`);
    assert.match(ran.stdout, /^Not applied: the proposal for configuration\.yaml uses redaction marker number 7 \(password\), which does not stand for a value of this file\. Fusion never hands protected material to an AI model as normal source, so this change needs your decision: make it yourself, or narrow the task\. Nothing was changed\./mu);
    assert.equal(rig.streamed.length, 0, "nothing reached verification");
    assert.deepEqual(leaked(ran), []);
    assert.equal(await readFile(join(rig.root, "configuration.yaml"), "utf8"), CONFIG);
  }));

test("v0.2.1 review: `fusion review` hands the Reviewer a masked diff of the working tree", { skip }, async () =>
  withHaRig("review-diff", { Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, async rig => {
    await writeFile(join(rig.root, "configuration.yaml"), CONFIG.replace(HA_SENTINELS.inlinePassword, "rotated-secret-4242").replace("  use_x_forwarded_for: true\n", TRUSTED));
    await writeFile(join(rig.root, "secrets.yaml"), HA_FILES["secrets.yaml"]!.replace(HA_SENTINELS.secretsYaml, "rotated-secret-5353"));
    const ran = await rig.cli(["review", "--no-verify"], []);
    assert.equal(ran.prompts.Reviewer.length, 1, `${ran.stdout}\n${ran.stderr}`);
    const prompt = ran.prompts.Reviewer[0]!;
    assert.ok(prompt.includes("trusted_proxies") && prompt.includes("<redacted:password>") && prompt.includes("mqtt_password: <redacted>"));
    assert.deepEqual(leaked(ran, [...SENTINELS, "rotated-secret-4242", "rotated-secret-5353"]), []);
  }));

test("v0.2.1 delivery: a change to a file with an inline secret is delivered with its exact bytes and applied through the unchanged approval",
  { skip }, async () => withHaRig("deliver-config", {}, async rig => {
    const plane = new ControlPlane({ registry: rig.registry, env: rig.env, cwd: rig.root });
    const base = git(rig.root, "rev-parse", "HEAD").trim();
    const eventLog = join(rig.dir, "events.jsonl");
    await writeFile(eventLog, `${JSON.stringify({ type: "RunStarted" })}\n`);
    // The host ChangeSet the port produces for the proposal above (checked by the build test): the exact fixed bytes.
    const delivery = await prepareBuildDelivery(plane, { runId: "r-v021-deliver", task: "Add trusted_proxies.", result: grantedResult(changeSet([["configuration.yaml", CONFIG, FIXED]])),
      baseCommit: base, eventLogPath: eventLog });
    const typedWrong = await rig.cli(["approve-delivery", delivery.deliveryId], ["y"]);
    assert.equal(typedWrong.code, 13, "the expert approval still needs the exact digest");
    assert.equal((await rig.cli(["approve-delivery", delivery.deliveryId], [delivery.manifestSha256])).code, 0);
    const applied = await rig.cli(["apply", delivery.deliveryId], []);
    assert.equal(applied.code, 0, applied.stdout + applied.stderr);
    assert.equal(await readFile(join(rig.root, "configuration.yaml"), "utf8"), FIXED, "the real password is still there, next to the fix");
    assert.equal(await readFile(join(rig.root, "secrets.yaml"), "utf8"), HA_FILES["secrets.yaml"]);
    assert.equal(git(rig.root, "rev-parse", "HEAD").trim(), base, "no commit");
    assert.equal((await rig.cli(["apply", delivery.deliveryId], [])).code, 2, "single use");
    assert.ok(APPLY_QUESTION.includes("[y/N]"));
  }));
