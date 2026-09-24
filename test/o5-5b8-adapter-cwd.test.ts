import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { realpath, rm, symlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { test } from "node:test";
import { validateChangeSet, writerChangeScope } from "../src/core/change/contract.js";
import type { ProviderAdapter, SessionWorkspace } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { RoleCandidate } from "../src/core/policy/routing.js";
import { WorkflowEngine } from "../src/core/workflow/engine.js";
import type { ProviderViewHandle, ProviderViewRequest } from "../src/core/workflow/types.js";
import { comparablePath, ProcessGitClient } from "../src/platform/workspace/git.js";
import { ProviderViewStore } from "../src/platform/workspace/provider-views.js";
import { ClaudeAdapter } from "../src/providers/claude/claude-adapter.js";
import { MUSE_ATTESTATION_PREFIX, MuseAdapter } from "../src/providers/muse/muse-adapter.js";
import { clean, plan } from "./fixtures/fake-writer.js";
import { claudeBinary, claudeBindingFor, claudeLaunch, launches, museBinary, museBindingFor, museLaunch, withInstalls,
  type Installs, type Launch } from "./fixtures/provider-installs.js";
import { FIX, gitAvailable, MEDIUM_PACKET, observedRig, primaryEvidence, rehearsalRequest, RecordingSink, VIEW_EXCLUSIONS,
  withRehearsalRepo } from "./fixtures/writer-rehearsal-harness.js";

const skip = gitAvailable ? false : "git executable unavailable";
const PROPOSAL = "Fusion change proposal.";
const REVIEW = "Fusion fresh review.";
const PACKET = "Complete this delegated task within its scope.";
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;
const same = async (a: string, b: string) => comparablePath(await realpath(a)) === comparablePath(await realpath(b));
const within = (parent: string, child: string) => {
  const p = comparablePath(parent), c = comparablePath(child);
  return c === p || c.startsWith(`${p}${process.platform === "win32" ? "\\" : "/"}`);
};
/** Launch posture every read-only Claude process must carry (and the widening flags none may). */
const CLAUDE_WIDENING = ["--mcp-config", "--add-dir", "--allowedTools", "--allowed-tools", "--agents", "--dangerously-skip-permissions",
  "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--permission-prompt-tool", "--json-schema"];
const MUSE_WIDENING = ["--yolo", "--trust-workspace", "--disable-approval", "--disable-sandbox", "--enable-shell-tool", "--base-url",
  "--api-key-stdin", "--allow-workspace-switch", "--worktree", "-w", "--permission-profile"];
const value = (argv: readonly string[], flag: string) => argv[argv.indexOf(flag) + 1];
/** Credentials and overrides that must never reach any provider child. */
const FORBIDDEN_ENV = /^(?:ANTHROPIC_|META_API_KEY$|MODEL_API_KEY$|GITHUB_TOKEN$|AWS_SECRET|CLAUDE_CODE_EFFORT_LEVEL$|MUSE_ENABLE_|TBH_MANAGED)/u;

async function withView<T>(root: string, run: (view: Awaited<ReturnType<ProviderViewStore["baseline"]>>, store: ProviderViewStore) => Promise<T>) {
  const store = new ProviderViewStore({ primaryRoot: root, git: await ProcessGitClient.fromPath(process.env, true), excludedPaths: VIEW_EXCLUSIONS });
  const view = await store.baseline("b8-adapter.views");
  try { return await run(view, store); } finally { assert.deepEqual(await store.release(view.viewId), { complete: true }); }
}
const bound = (view: { viewId: string; path: string }): SessionWorkspace => ({ id: view.viewId, root: view.path });
const sessionRequest = (config: { model: { id: string; effort: string; maxTurns?: number } }, workspace?: SessionWorkspace,
  role: "Worker" | "Reviewer" | "Lead" = "Worker") => ({ runId: "b8-run", role, workspaceLeaseId: "candidate-b8", posture: "readOnly" as const,
  model: config.model, ...(workspace ? { workspace } : {}) });

// ---------------------------------------------------------------------------------------------------------------
// Claude one-shot (Phase C)

test("O5.5B8 Claude: every process of a Change Author session starts in its Fusion view, read-only, with a clean environment",
  { skip }, async () => withInstalls(async i => withRehearsalRepo(async repo => withView(repo.root, async view => {
    const config = claudeLaunch(i, repo.root, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL, FUSION_FAKE_OUTPUT: JSON.stringify(FIX),
      GITHUB_TOKEN: "ghp_000000000000000000000000000000000000", CLAUDE_CODE_EFFORT_LEVEL: "inherited" });
    const adapter = new ClaudeAdapter(claudeBindingFor("Worker", config), config, claudeBinary);
    assert.equal((await adapter.capabilities()).workspaceBinding, true);
    const session = await adapter.createSession(sessionRequest(config, bound(view)));
    assert.equal(session.workspaceRoot, view.path, "the session echoes its view");
    const turn = await adapter.runChangeProposalTurn!(session, { kind: "changeProposal", packet: MEDIUM_PACKET });
    await adapter.close(session);
    assert.equal(turn.status, "completed", JSON.stringify(turn.error));
    assert.deepEqual(validateChangeSet(turn.output, writerChangeScope(MEDIUM_PACKET)), FIX, "the output is still only an untrusted ChangeSet");
    const calls = await launches(i.record);
    assert.ok(calls.length >= 6, `auth (session), auth, plugin inventory, discovery, verification and the turn: ${calls.length}`);
    for (const call of calls) {
      assert.ok(await same(call.cwd, view.path), `${call.argv[0]} ran in ${call.cwd}, not the view`);
      assert.ok(!within(comparablePath(await realpath(repo.root)), comparablePath(await realpath(call.cwd))), "never the primary");
      for (const key of call.env) assert.doesNotMatch(key, FORBIDDEN_ENV, key);
      assert.ok(call.env.includes("CLAUDE_CODE_DISABLE_AUTO_MEMORY"));
    }
    const printed = calls.filter(call => call.argv.includes("-p"));
    assert.equal(printed.length, 3, "two init-only probes and the turn");
    for (const call of printed) {
      assert.equal(value(call.argv, "--tools"), "Read,Grep,Glob");
      assert.equal(value(call.argv, "--permission-mode"), "dontAsk");
      for (const flag of ["--restricted", "--safe-mode", "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence"])
        assert.ok(call.argv.includes(flag), flag);
      for (const flag of CLAUDE_WIDENING) assert.equal(call.argv.some(arg => arg.split("=")[0] === flag), false, flag);
    }
  }))));

test("O5.5B8 Claude: the primary, a path inside or around it, a link to it or a missing root is refused before any process starts",
  { skip }, async () => withInstalls(async i => withRehearsalRepo(async repo => {
    const config = claudeLaunch(i, repo.root, {});
    const adapter = new ClaudeAdapter(claudeBindingFor("Worker", config), config, claudeBinary);
    const link = join(repo.dir, "link-to-primary");
    let linked = false;
    try { await symlink(repo.root, link, "junction"); linked = true; } catch { /* links unavailable on this host */ }
    const hostile: Array<[string, SessionWorkspace | undefined]> = [["none", undefined], ["primary", { id: "v", root: repo.root }],
      ["inside", { id: "v", root: join(repo.root, "src") }], ["around", { id: "v", root: repo.dir }],
      ["missing", { id: "v", root: join(repo.dir, "does-not-exist") }], ...(linked ? [["link", { id: "v", root: link }] as [string, SessionWorkspace]] : [])];
    for (const [name, workspace] of hostile)
      await assert.rejects(adapter.createSession(sessionRequest(config, workspace)), kind("SecurityViolation"), name);
    await assert.rejects(adapter.authStatus(), kind("CapabilityUnavailable"), "no auth readback outside a view-bound session");
    assert.deepEqual(await launches(i.record), [], "no provider process was started for any refused session");
    // A legacy adapter without the requirement still refuses the primary when a workspace is given.
    const legacy = new ClaudeAdapter(claudeBindingFor("Reviewer", config), { ...config, requireSessionWorkspace: false }, claudeBinary);
    await assert.rejects(legacy.createSession(sessionRequest(config, { id: "v", root: repo.root }, "Reviewer")), kind("SecurityViolation"));
    if (linked) await rm(link, { force: true }).catch(() => undefined);
  })));

test("O5.5B8 Claude: the billing guard is unchanged — an API key or gateway override refuses before any process starts", { skip },
  async () => withInstalls(async i => withRehearsalRepo(async repo => withView(repo.root, async view => {
    for (const env of [{ ANTHROPIC_API_KEY: "sk-ant-api03-fake" }, { ANTHROPIC_BASE_URL: "https://proxy.invalid" }, { CLAUDE_CODE_USE_BEDROCK: "1" }]) {
      const config = claudeLaunch(i, repo.root, env);
      const adapter = new ClaudeAdapter(claudeBindingFor("Worker", config), config, claudeBinary);
      await assert.rejects(adapter.createSession(sessionRequest(config, bound(view))), kind("BillingBlocked"), Object.keys(env)[0]);
    }
    assert.deepEqual(await launches(i.record), []);
  }))));

// ---------------------------------------------------------------------------------------------------------------
// Muse Exec / MSP (Phase C)

test("O5.5B8 Muse Exec: the Change Author turn runs with --workspace and cwd = its view; account attestation in an empty Fusion directory",
  { skip }, async () => withInstalls(async i => withRehearsalRepo(async repo => withView(repo.root, async view => {
    const config = museLaunch(i, repo.root, { FUSION_FAKE_PROMPT_PREFIX: PROPOSAL, FUSION_FAKE_OUTPUT: JSON.stringify(FIX),
      GITHUB_TOKEN: "ghp_000000000000000000000000000000000000", MUSE_ENABLE_WEB_TOOLS: "1" });
    const adapter = new MuseAdapter(museBindingFor("Worker", config), config, undefined, museBinary(i));
    assert.equal((await adapter.capabilities()).workspaceBinding, true);
    const session = await adapter.createSession(sessionRequest(config, bound(view)));
    assert.equal(session.workspaceRoot, view.path);
    const turn = await adapter.runChangeProposalTurn!(session, { kind: "changeProposal", packet: MEDIUM_PACKET });
    assert.equal(turn.status, "completed", JSON.stringify(turn.error));
    assert.deepEqual(validateChangeSet(turn.output, writerChangeScope(MEDIUM_PACKET)), FIX);
    const calls = await launches(i.record);
    const exec = calls.filter(call => call.argv[0] === "exec"), serve = calls.filter(call => call.argv[0] === "serve");
    assert.equal(exec.length, 1);
    assert.ok(await same(exec[0]!.cwd, view.path), "the turn's working directory is the view");
    assert.ok(await same(value(exec[0]!.argv, "--workspace")!, view.path), "--workspace is the view");
    for (const flag of ["--disable-write", "--disable-shell", "--disable-web-tools", "--no-foreign-personal-context"])
      assert.ok(exec[0]!.argv.includes(flag), flag);
    assert.deepEqual([value(exec[0]!.argv, "--approval-mode"), value(exec[0]!.argv, "--approval-judge")], ["never", "off"]);
    for (const flag of MUSE_WIDENING) assert.equal(exec[0]!.argv.includes(flag), false, flag);
    assert.ok(serve.length >= 1, "the account is attested through the host");
    const attestation = new Set<string>();
    for (const call of serve) {
      assert.ok(basename(call.cwd).startsWith(MUSE_ATTESTATION_PREFIX), `attestation ran in ${call.cwd}`);
      assert.ok(!(await same(call.cwd, repo.root)) && !(await same(call.cwd, view.path)));
      attestation.add(call.cwd);
    }
    for (const call of calls) for (const key of call.env) assert.doesNotMatch(key, FORBIDDEN_ENV, key);
    await adapter.close(session);
    for (const directory of attestation) assert.equal(existsSync(directory), false, "the attestation directory is removed on close");
  }))));

test("O5.5B8 Muse: MSP refuses view-bound sessions; Exec refuses the primary; the billing guard still blocks API keys", { skip },
  async () => withInstalls(async i => withRehearsalRepo(async repo => withView(repo.root, async view => {
    const mspConfig = museLaunch(i, repo.root, {}, { requireSessionWorkspace: false });
    const msp = new MuseAdapter(museBindingFor("Reviewer", mspConfig, "muse-msp"), mspConfig, undefined, museBinary(i));
    await assert.rejects(msp.createSession(sessionRequest(mspConfig, bound(view), "Reviewer")), kind("CapabilityUnavailable"));
    const config = museLaunch(i, repo.root, {});
    const exec = new MuseAdapter(museBindingFor("Worker", config), config, undefined, museBinary(i));
    await assert.rejects(exec.createSession(sessionRequest(config, { id: "v", root: repo.root })), kind("SecurityViolation"));
    await assert.rejects(exec.createSession(sessionRequest(config)), kind("SecurityViolation"), "a Change Author always needs a view");
    const keyed = museLaunch(i, repo.root, { META_API_KEY: "fake-key", FUSION_FAKE_PROMPT_PREFIX: PROPOSAL });
    const blocked = new MuseAdapter(museBindingFor("Worker", keyed), keyed, undefined, museBinary(i));
    const session = await blocked.createSession(sessionRequest(keyed, bound(view)));
    const turn = await blocked.runChangeProposalTurn!(session, { kind: "changeProposal", packet: MEDIUM_PACKET });
    await blocked.close(session);
    assert.deepEqual([turn.status, turn.error?.kind], ["failed", "BillingBlocked"]);
    // An MSP adapter built for view-bound runs reports that statically: routing never starts its host in the primary.
    const boundConfig = { ...mspConfig, requireSessionWorkspace: true };
    const boundMsp = new MuseAdapter(museBindingFor("Reviewer", boundConfig, "muse-msp"), boundConfig, undefined, museBinary(i));
    assert.equal((await boundMsp.capabilities()).workspaceBinding, false);
    await assert.rejects(boundMsp.authStatus(), kind("CapabilityUnavailable"));
    assert.deepEqual((await launches(i.record)).filter(call => call.argv[0] === "exec"), [], "no Exec process ever started");
    assert.deepEqual((await launches(i.record)).filter(call => call.argv[0] === "serve"), [], "no host was started in the primary");
  }))));

// ---------------------------------------------------------------------------------------------------------------
// A whole Writer workflow driven by the REAL adapter code (fake native processes) — Phase C / L

test("O5.5B8 full Writer workflow with real adapter code: every provider process of every role runs in a Fusion view", { skip },
  async () => withInstalls(async (i: Installs) => withRehearsalRepo(async repo => {
    const rig = await observedRig(repo);
    const opened: ProviderViewHandle[] = [];
    const open = rig.views.open.bind(rig.views);
    rig.views.open = async (ownerId: string, request: ProviderViewRequest, signal?: AbortSignal) => {
      const view = await open(ownerId, request, signal); opened.push(view); return view; };
    const record = (role: string) => join(i.dir, `${role}.jsonl`);
    const adapter = (role: "Lead" | "Worker" | "Reviewer", prefix: string, output: unknown): RoleCandidate => {
      const config = claudeLaunch(i, repo.root, { FUSION_FAKE_PROMPT_PREFIX: prefix, FUSION_FAKE_OUTPUT: JSON.stringify(output),
        FUSION_FAKE_RECORD: record(role) });
      return { binding: claudeBindingFor(role, config), adapter: new ClaudeAdapter(claudeBindingFor(role, config), config, claudeBinary) as ProviderAdapter };
    };
    const roles = [adapter("Lead", PACKET, plan("Plan: tax the discounted subtotal and add the regression test.")),
      adapter("Worker", PROPOSAL, FIX), adapter("Reviewer", REVIEW, clean())];
    const engine = new WorkflowEngine({ roles, workspace: rig.port, views: rig.views, events: new RecordingSink(),
      verifier: { verify: () => { throw new Error("a Writer candidate is never verified on the host"); } } });
    try {
      const result = await engine.run(rehearsalRequest());
      assert.equal(result.state, "completed", JSON.stringify(result.error));
      const expectedKind: Record<string, string> = { Lead: "baseline", Worker: "baseline", Reviewer: "candidate" };
      const primary = comparablePath(await realpath(repo.root));
      for (const role of ["Lead", "Worker", "Reviewer"]) {
        const calls: Launch[] = await launches(record(role));
        assert.ok(calls.length >= 6, `${role}: ${calls.length} launches`);
        for (const call of calls) {
          const cwd = comparablePath(call.cwd);
          const view = opened.find(v => comparablePath(v.path) === cwd);
          assert.equal(view?.kind, expectedKind[role], `${role} ran in ${call.cwd}`);
          assert.ok(!within(primary, cwd) && !within(cwd, primary), `${role}: never the primary`);
          for (const handle of rig.port.handles) assert.ok(!within(comparablePath(dirname(handle.path)), cwd), `${role}: never a candidate`);
        }
      }
      assert.deepEqual(result.providerViews, { created: 2, released: 2, complete: true });
      for (const view of opened) assert.equal(existsSync(dirname(view.path)), false);
      assert.deepEqual(await primaryEvidence(repo.root), repo.before, "the primary checkout is untouched");
    } finally {
      for (const handle of rig.port.handles) await rig.port.forceRelease(handle).catch(() => undefined);
      for (const view of rig.store.live()) await rig.store.release(view.viewId);
    }
  })));
