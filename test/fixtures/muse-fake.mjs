// Deterministic local executable fixture. Never discovers or invokes Muse.
import { barrier, claimTurn } from "./fake-script.mjs";
const scenario = process.env.FUSION_FAKE_SCENARIO ?? "ok";
const args = process.argv.slice(2);
// O5.5B8: an opt-in record of how Fusion launched this process — argv, working directory and environment KEY NAMES
// (never values) — so tests can inspect exactly what the real adapter code constructed.
if (process.env.FUSION_FAKE_RECORD) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.FUSION_FAKE_RECORD, `${JSON.stringify({ argv: args, cwd: process.cwd(), env: Object.keys(process.env).sort() })}\n`);
}
const packet = { result: { status: "completed" }, changes: { files: [], summary: "fixture" },
  verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [] };
const write = x => process.stdout.write(`${JSON.stringify(x)}\n`);
const event = (type, payload) => write({ schema_version: 1, payload_type: type, payload });
/**
 * Like the live provider's strict structured decoding: every object must list every property in `required` and be
 * closed, or the turn fails with HTTP 400 (the message reproduces the live one, naming the last missing key).
 */
function strictViolation(schema) {
  if (!schema || typeof schema !== "object") return null;
  if (Array.isArray(schema.anyOf)) {
    for (const branch of schema.anyOf) { const found = strictViolation(branch); if (found) return found; }
    return null;
  }
  if (schema.type === "object") {
    const keys = Object.keys(schema.properties ?? {});
    const required = Array.isArray(schema.required) ? schema.required : [];
    const missing = keys.filter(key => !required.includes(key));
    if (!Array.isArray(schema.required) || missing.length > 0)
      return `'required' is required to be supplied and to be an array including every key in properties. Missing '${missing.at(-1) ?? ""}'.`;
    if (schema.additionalProperties !== false) return "'additionalProperties' is required to be supplied and to be false.";
    for (const child of Object.values(schema.properties ?? {})) { const found = strictViolation(child); if (found) return found; }
  }
  if (schema.type === "array") return strictViolation(schema.items);
  return null;
}
if (args[0] === "exec") {
  const { readFileSync } = await import("node:fs");
  const val = flag => args[args.indexOf(flag) + 1];
  const required = ["--json","--prompt-file","--provider","--model","--reasoning-effort","--workspace",
    "--disable-write","--disable-shell","--disable-web-tools","--approval-judge","--no-foreign-personal-context","--max-model-steps"];
  if (required.some(flag => !args.includes(flag)) || val("--provider") !== "meta" || val("--model") !== "muse-spark-1.3" ||
      val("--approval-judge") !== "off" || val("--reasoning-effort") !== (process.env.FUSION_FAKE_EXPECT_EFFORT ?? "low") ||
      val("--max-model-steps") !== "4" ||
      val("--approval-mode") !== "never") process.exit(4);
  // A security control given twice is ambiguous, and a widening flag voids the read-only posture.
  const controls = [...required, "--approval-mode", "--output-schema"];
  if (controls.some(flag => args.filter(arg => arg === flag).length > 1)) process.exit(10);
  const widening = ["--yolo", "--trust-workspace", "--disable-approval", "--disable-sandbox", "--enable-shell-tool", "--base-url",
    "--api-key-stdin", "--allow-workspace-switch", "--worktree", "-w", "--permission-profile", "--sandbox-network", "--preset",
    "--session-id", "--user-input-auto-resolve"];
  if (args.some(arg => widening.includes(arg.split("=")[0]))) process.exit(11);
  const prompt = readFileSync(val("--prompt-file"));
  if (prompt[0] === 0xef && prompt[1] === 0xbb && prompt[2] === 0xbf) process.exit(5);
  if (args.includes("--output-schema")) {
    const schema = readFileSync(val("--output-schema"));
    if (schema[0] === 0xef && schema[1] === 0xbb && schema[2] === 0xbf) process.exit(6);
    const violation = strictViolation(JSON.parse(schema.toString("utf8")));
    if (violation) {
      event("run.lifecycle.started", { kind: "run.lifecycle.started" });
      event("run.model.configured", { provider_id: "meta", model_id: "muse-spark-1.3" });
      event("run.terminal.failed", { terminal: "failed", reason: `HTTP 400: ${violation}` });
      process.exit(1);
    }
    // The prompt must show exactly the schema the decoding is constrained to.
    if (process.env.FUSION_FAKE_PROMPT_PREFIX && !readFileSync(val("--prompt-file"), "utf8").includes(schema.toString("utf8")))
      process.exit(12);
  }
  process.stderr.write("fixture diagnostic\n");
  // O5.5B12 scripted mode (see claude-fake.mjs): model turns consumed in order from FUSION_FAKE_SCRIPT; prompts logged.
  const scriptPath = process.env.FUSION_FAKE_SCRIPT;
  if (scriptPath) {
    const { appendFileSync, writeFileSync } = await import("node:fs");
    const text = readFileSync(val("--prompt-file"), "utf8");
    // v0.3: concurrent processes of one role (parallel investigations) CLAIM their turn (see claimTurn).
    const turns = JSON.parse(readFileSync(scriptPath, "utf8"));
    const n = await claimTurn(scriptPath, turns, text);
    if (n < 0) process.exit(43);
    appendFileSync(`${scriptPath}.prompts.jsonl`, `${JSON.stringify({ n, prompt: text })}\n`);
    appendFileSync(`${scriptPath}.timeline.jsonl`, `${JSON.stringify({ n, event: "start", at: Date.now(), pid: process.pid, cwd: process.cwd() })}\n`);
    if (process.env.FUSION_FAKE_VIEW_DUMP === "1") {
      const { readdirSync } = await import("node:fs");
      globalThis.__fusionFakeFs = { readdirSync, readFileSync };
      appendFileSync(`${scriptPath}.views.jsonl`, `${JSON.stringify({ n, files: viewFiles(process.cwd()) })}\n`);
    }
    const turn = turns[n];
    if (turn.barrier) await barrier(scriptPath, turn.barrier, n);
    if (turn.delayMs) await new Promise(resolve => setTimeout(resolve, turn.delayMs));
    process.on("exit", () => appendFileSync(`${scriptPath}.timeline.jsonl`, `${JSON.stringify({ n, event: "end", at: Date.now(), pid: process.pid })}\n`));
    if (!text.startsWith(turn.prefix)) process.exit(8);
    if ((turn.excludes ?? []).some(fragment => text.includes(fragment))) process.exit(42);
    // Red team: a turn that writes into its own working directory (its Fusion view) before answering.
    if (turn.scenario === "mutate") writeFileSync(`${process.cwd()}/reviewer-note.txt`, "a reviewer must not write\n");
    if (turn.scenario === "hang") setInterval(() => {}, 1000);
    else {
      event("run.lifecycle.started", { kind: "run.lifecycle.started" });
      // O5.5B23: a scripted turn may read back another model than the one requested.
      event("run.model.configured", { provider_id: "meta", model_id: turn.model ?? "muse-spark-1.3" });
      const terminal = turn.scenario === "fail" ? "failed" : "completed";
      event(`run.terminal.${terminal}`, { terminal, text: turn.output ?? "" });
    }
  } else if (scenario === "hang") setInterval(() => {}, 1000);
  else if (scenario === "delete-attempt-dir") {
    const { rmSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    rmSync(dirname(val("--prompt-file")), { recursive: true, force: true });
    setInterval(() => {}, 1000);
  } else if (scenario === "duplicate-envelope-key") {
    process.stdout.write('{"schema_version":1,"payload_type":"run.lifecycle.started","payload":{},"payload_type":"run.terminal.completed"}\n');
  } else if (scenario === "malformed-jsonl") process.stdout.write("{invalid}\n");
  else {
    event("run.lifecycle.started", { kind: "run.lifecycle.started" });
    if (scenario !== "missing-identity") event("run.model.configured", { provider_id: scenario === "provider-mismatch" ? "wrong" : "meta",
      model_id: scenario === "model-mismatch" ? "wrong" : "muse-spark-1.3" });
    if (scenario !== "missing-terminal") {
      const terminal = scenario === "failed" ? "failed" : scenario === "cancelled" ? "cancelled" : "completed";
      // Structured-turn fixtures: the prompt kind and the schema file are checked, then the scripted text is returned.
      const expectedPrompt = process.env.FUSION_FAKE_PROMPT_PREFIX;
      if (expectedPrompt && !readFileSync(val("--prompt-file"), "utf8").startsWith(expectedPrompt)) process.exit(8);
      if (expectedPrompt && !args.includes("--output-schema")) process.exit(9);
      // O5.5B9: a structured turn must carry a given fragment (for example Fusion's baseline hash) in its prompt.
      if (process.env.FUSION_FAKE_PROMPT_INCLUDES && !readFileSync(val("--prompt-file"), "utf8").includes(process.env.FUSION_FAKE_PROMPT_INCLUDES))
        process.exit(41);
      const text = process.env.FUSION_FAKE_OUTPUT !== undefined ? process.env.FUSION_FAKE_OUTPUT :
        scenario === "malformed-packet" ? "{bad" : scenario === "schema-failure" ? JSON.stringify({ ...packet, bogus: true }) :
        scenario === "duplicate-status-packet" ? `{"result":{"status":"failed"},"result":{"status":"completed"},` +
          '"changes":{"files":[],"summary":"fixture"},"verification":{"testsRun":[],"results":[]},' +
          '"uncertainties":[],"failures":[],"needsLeadDecision":[]}' : JSON.stringify(packet);
      if (scenario === "secret-stderr") {
        // The value arrives under a neutral variable name, so only pattern-based redaction can catch it.
        const secret = process.env.FUSION_FIXTURE_PAYLOAD ?? "missing";
        process.stderr.write(`token=${secret}\nAuthorization: Basic ${secret}\nhttps://user:${secret}@10.0.0.7/path\n` +
          `Cookie: session=${secret}\nprompt echo: ${readFileSync(val("--prompt-file"), "utf8")}\n`);
      }
      if (scenario === "stderr-invalid-utf8") process.stderr.write(Buffer.from([0x66, 0xff, 0xfe, 0x0a]));
      event(`run.terminal.${terminal}`, { terminal, text,
        ...(terminal === "failed" && process.env.FUSION_FAKE_FAILURE_REASON ?
          { reason: process.env.FUSION_FAKE_FAILURE_REASON } : {}) });
    }
  }
  process.exitCode = scenario === "nonzero" ? 7 : 0;
} else if (args[0] === "serve") {
  if (args.length !== 3 || args[1] !== "--disable-write" || args[2] !== "--disable-shell") process.exit(7);
  const hostBinary = (await import("node:path")).basename(process.execPath);
  let input = "";
  let sessionId = "session-fixture";
  let turnId = "";
  let approval = null;
  let decisionCount = 0;
  let approvalReceipt = false;
  const reply = (id, result) => write({ jsonrpc: "2.0", id, result });
  const rpcError = (id, code, kind) => write({ jsonrpc: "2.0", id, error: { code, message: kind, data: { kind } } });
  const notify = (method, params) => write({ jsonrpc: "2.0", method, params });
  const terminal = status => {
    if (status === "completed") notify("item/completed", { sessionId, viewCursor: "c2", sourceRange: {},
      item: { kind: "agentMessage", turnId, text: JSON.stringify(packet) } });
    notify("turn/completed", { sessionId, turnId, terminal: status, viewCursor: "c3", sourceRange: {} });
  };
  const handle = m => {
    if (!m.method) {
      if (m.id === "server-approval-1" && m.result && !m.error) approvalReceipt = true;
      return;
    }
    if (m.method === "initialized") return;
    if (m.method === "fusion/delay") return setTimeout(() => reply(m.id, { delayed: true }), 100);
    if (m.method === "fusion/echo") return reply(m.id, { echo: m.params?.value ?? null });
    if (m.method === "fusion/duplicate") { reply(m.id, { first: true }); return reply(m.id, { first: false }); }
    if (m.method === "fusion/impossible") {
      for (let i = 0; i < 3; i++) reply(9000 + i, { impossible: true });
      return;
    }
    // O5.5B23: the host reports the version core of the versioned binary it runs as (1.3.0 for the verified fixture name).
    if (m.method === "initialize") return reply(m.id, { serverInfo: { name: "muse", version: process.env.FUSION_FAKE_HOST_VERSION ??
      (/^muse-bin-(\d+\.\d+\.\d+)/iu.exec(hostBinary)?.[1] ?? "1.3.0") },
      schema: { version: 1, fingerprint: `sha256:${"a".repeat(64)}` }, sessionDurability: "durable", experimentalApi: true,
      grantedCapabilities: [], museHome: "fixture", platformFamily: "windows", platformOs: "windows", userAgent: "fixture" });
    if (m.params?.__fusionProbe) return rpcError(m.id, scenario === "missing-method" && m.method === "session/read" ? -32601 : -32602,
      scenario === "missing-method" && m.method === "session/read" ? "methodNotFound" : "invalidParams");
    if (m.method === "account/read") return reply(m.id, { state: scenario === "wrong-auth" ? "apiKey" : "accountLogin", credentialRequired: true });
    if (m.method === "usage/read") return reply(m.id, scenario === "usage-present" ? { usage: {
      tier: "fixture-tier", observedAtMs: 1000, window: { usedPercent: 17, resetsAtMs: 2000, windowDurationMins: 300 },
      weekly: { usedPercent: 12, resetsAtMs: 3000 } } } : {});
    if (m.method === "session/start") return reply(m.id, { session: { sessionId, providerId: m.params.providerId,
      modelId: m.params.modelId, workspaceRoot: m.params.workspaceRoot, approvalMode: { mode: m.params.approvalMode } }, viewCursor: "c0" });
    if (m.method === "session/read") {
      if (scenario === "request-timeout") return;
      return reply(m.id, { session: { sessionId, providerId: scenario === "provider-mismatch" ? "wrong" : "meta",
        modelId: scenario === "model-mismatch" ? "wrong" : "muse-spark-1.3", workspaceRoot: process.cwd(),
        approvalMode: { mode: "denyUnmatched" } }, viewCursor: "c1", history: [], pendingRequests: [] });
    }
    if (m.method === "turn/start") {
      if (scenario === "host-dies") process.exit(2);
      turnId = "turn-fixture";
      reply(m.id, { commandId: m.params.commandId, status: "accepted", disposition: "started", startedNewTurn: true, turnId });
      if (scenario === "approval-after-terminal") {
        terminal("completed");
        setTimeout(() => {
          notify("approval/requested", { sessionId, turnId, approvalId: "stale" });
          notify("approval/request", { sessionId, turnId, approvalId: "stale" });
        }, 10);
      } else if (scenario.startsWith("approval")) {
        const choices = [{ choiceId: "choice-deny", decision: "denied", label: "Deny", scope: "once" },
          { choiceId: "choice-abort", decision: "abort", label: "Abort", scope: "once" }];
        approval = { sessionId, approvalId: "approval-fixture", currentRequirementId: { approvalId: "approval-fixture", sourceIndex: 0 },
          turnId, subject: { kind: "shell" }, availableChoices: choices };
        if (scenario === "approval-malformed") delete approval.currentRequirementId;
        notify("approval/requested", approval);
        write({ jsonrpc: "2.0", id: "server-approval-1",
          method: scenario === "approval-requested-id" ? "approval/requested" : "approval/request", params: approval });
      } else if (scenario === "cancel-accepted" || scenario === "cancel-timeout") {
        // Wait for turn/cancel.
      } else if (scenario === "malformed-rpc") process.stdout.write("{broken}\n");
      else setTimeout(() => terminal(scenario === "turn-failed" ? "failed" : scenario === "turn-cancelled" ? "cancelled" : "completed"), 10);
      return;
    }
    if (m.method === "approval/listPending") {
      if (scenario === "approval-after-terminal") process.exit(21);
      return reply(m.id, { approvals: scenario === "approval-stale" ? [] : [approval], userInputs: [] });
    }
    if (m.method === "approval/decide") {
      if (scenario === "approval-after-terminal") process.exit(22);
      if (scenario === "approval-requested-id" && !approvalReceipt) return rpcError(m.id, -32099, "missingReceipt");
      decisionCount++;
      if (!m.params.commandId || !m.params.requirementId || m.params.requirementId.approvalId !== "approval-fixture" ||
        m.params.requirementId.sourceIndex !== 0 || !["choice-deny","choice-abort"].includes(m.params.choiceId) || decisionCount > 1)
        return rpcError(m.id, -32053, "staleRequirement");
      reply(m.id, { commandId: m.params.commandId, approvalId: m.params.approvalId, status: "accepted", terminal: true });
      if (scenario !== "approval-hang" && scenario !== "approval-requested-id") setTimeout(() => terminal("cancelled"), 10);
      return;
    }
    if (m.method === "turn/cancel") {
      if (scenario === "approval-after-terminal") process.exit(23);
      reply(m.id, { commandId: m.params.commandId, status: "accepted", turnId });
      if (scenario !== "cancel-timeout") setTimeout(() => terminal("cancelled"), 10);
      return;
    }
    rpcError(m.id, -32601, "methodNotFound");
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", chunk => {
    input += chunk;
    while (input.includes("\n")) { const i = input.indexOf("\n"), line = input.slice(0, i); input = input.slice(i + 1);
      if (line) { try { handle(JSON.parse(line)); } catch { process.stdout.write("{bad}\n"); } }
    }
  });
} else process.exit(3);

// v0.2.1 (test-only): FUSION_FAKE_VIEW_DUMP=1 records, per scripted model turn, every file of the working directory (the
// Fusion-owned view the adapter started this process in), so a test can prove what a role could READ, not only its prompt.
function viewFiles(root) {
  const { readdirSync, readFileSync: read } = globalThis.__fusionFakeFs;
  const files = {};
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = `${entry.parentPath}/${entry.name}`;
    files[full.slice(root.length + 1).split("\\").join("/")] = read(full, "utf8");
  }
  return files;
}
