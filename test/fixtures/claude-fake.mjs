// Deterministic fixture. Never invokes Claude or a network service.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const scenario = process.env.FUSION_FAKE_SCENARIO ?? "ok";
const args = process.argv.slice(2);
const val = flag => args[args.indexOf(flag) + 1];
const write = value => process.stdout.write(`${JSON.stringify(value)}\n`);
// Cross-startup state models Claude materializing plugins between consecutive startups
// (cached remote flags, claude.ai plugin sync). Only the materialization scenarios use it.
const stateDir = process.env.FUSION_FAKE_STATE_DIR;
const synced = () => !!stateDir && existsSync(join(stateDir, "synced"));
function nextStartup() {
  if (!stateDir) return 1;
  const file = join(stateDir, "startups");
  const count = (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0) + 1;
  writeFileSync(file, String(count));
  return count;
}
function materialized(startup) {
  if (scenario === "builtin-materializes") return [{ name: "agents-md", path: "builtin", source: "agents-md@builtin" },
    ...(startup >= 2 ? [{ name: "late-builtin", path: "builtin", source: "late-builtin@builtin" }] : [])];
  if (scenario === "synced-materializes" && synced())
    return [{ name: "synced-tool", path: "private-cache-path", source: "synced-tool@claude-plugins-official" }];
  if (scenario === "unknown-materializes" && startup >= 2) return [{ name: "ghost", path: "private-path", source: "ghost@unlisted" }];
  if (scenario === "never-converges" && startup >= 2)
    return [{ name: `late-${startup}`, path: "builtin", source: `late-${startup}@builtin` }];
  return [];
}
const disableKey = plugin => plugin.source.endsWith("@builtin") ? `${plugin.name}@builtin` : plugin.source;
if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_BASE_URL ||
    process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_FOUNDRY) process.exit(31);
if (args[0] === "auth" && args[1] === "status") {
  if (scenario === "auth-hang") { setInterval(() => {}, 1000); }
  else if (scenario === "auth-duplicate-key") process.stdout.write('{"isLoggedIn":false,"isLoggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty","apiKeySource":null,"subscriptionType":"pro"}\n');
  // Like the real CLI, a CLAUDE_CODE_OAUTH_TOKEN in the environment takes precedence over the interactive login.
  else write({ ...(scenario === "auth-no-login-evidence" ? {} : { isLoggedIn: scenario !== "auth-logged-out" }),
    ...(scenario === "auth-no-method" ? {} : { authMethod: scenario === "auth-login-method" ? "claude.ai"
      : scenario.startsWith("token") || process.env.CLAUDE_CODE_OAUTH_TOKEN !== undefined ? "oauth_token" : "claude.ai" }),
    apiProvider: scenario === "auth-third-party" ? "bedrock" : "firstParty", ...(["auth-no-key-source", "token-no-key-source"].includes(scenario) ? {} :
      { apiKeySource: scenario === "auth-api-key" ? "ANTHROPIC_API_KEY" : null }),
    subscriptionType: scenario === "auth-ambiguous" ? null : "pro", email: "private@example.com", organizationId: "private-org" });
} else if (args[0] === "plugin" && args[1] === "list" && args[2] === "--json") {
  if (scenario === "plugin-list-hang") setInterval(() => {}, 1000);
  else if (scenario === "plugin-list-failure") process.exit(9);
  else if (scenario === "plugin-list-malformed") process.stdout.write("{bad\n");
  else if (scenario === "plugin-list-multiple") write([
    { id: "private-alpha@market", enabled: true, scope: "user" },
    { id: "private-beta@synced", enabled: true, scope: "synced" },
    { id: "private-gamma@skills-dir", enabled: true, scope: "project" }]);
  else if (scenario === "plugin-list-required") write([{ id: "required@synced", requiredByOrg: true }]);
  else if (scenario === "synced-materializes" && synced())
    write([{ id: "synced-tool@claude-plugins-official", enabled: true, scope: "synced" }]);
  else write([]);
} else if (args[0] === "-p") {
  const required = ["--input-format", "--output-format", "--verbose", "--include-hook-events", "--model", "--effort",
    "--permission-mode", "--permission-prompts", "--tools", "--restricted", "--safe-mode",
    "--disable-slash-commands", "--strict-mcp-config", "--no-session-persistence", "--max-turns"];
  if (required.some(flag => !args.includes(flag)) || val("--input-format") !== "text" ||
      val("--output-format") !== "stream-json" || val("--model") !== "alias" ||
      val("--effort") !== "low" || val("--permission-mode") !== "dontAsk" ||
      val("--permission-prompts") !== "none" || val("--tools") !== "Read,Grep,Glob" ||
      !["1", "3"].includes(val("--max-turns")) || process.env.CLAUDE_CODE_EFFORT_LEVEL) process.exit(32);
  // Auto memory (personal context) is switched off for every Fusion-started process.
  if (process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1") process.exit(36);
  // A security control given twice is ambiguous, and a widening flag voids the read-only posture.
  const controls = ["--input-format", "--output-format", "--verbose", "--include-hook-events", "--model", "--effort",
    "--permission-mode", "--permission-prompts", "--tools", "--restricted", "--safe-mode", "--disable-slash-commands",
    "--strict-mcp-config", "--no-session-persistence", "--max-turns", "--settings"];
  if (controls.some(flag => args.filter(arg => arg === flag).length > 1)) process.exit(38);
  const widening = ["--mcp-config", "--add-dir", "--allowedTools", "--allowed-tools", "--disallowedTools", "--agents",
    "--dangerously-skip-permissions", "--allow-dangerously-skip-permissions", "--plugin-dir", "--bare", "--permission-prompt-tool",
    "--system-prompt", "--append-system-prompt", "--setting-sources", "--resume", "--continue", "--session-id", "--fork-session"];
  if (args.some(arg => widening.includes(arg.split("=")[0]))) process.exit(39);
  const startup = nextStartup();
  let prompt = "";
  for await (const chunk of process.stdin) prompt += chunk;
  const initOnly = prompt.startsWith("Fusion init-only plugin ");
  const discovery = prompt.startsWith("Fusion init-only plugin discovery.");
  // A structured turn is identified by its prompt prefix; a packet turn by the delegated goal it carries.
  const structured = process.env.FUSION_FAKE_PROMPT_PREFIX;
  if (!initOnly && structured && !prompt.startsWith(structured)) process.exit(37);
  // Claude is prompted with the canonical contract only; a provider wire form must never reach it.
  if (!initOnly && structured && prompt.includes('"anyOf"')) process.exit(40);
  if (!initOnly && !structured && !prompt.includes("line 1\\n& | $() ü ☃")) process.exit(33);
  if (args.includes("--json-schema")) process.exit(32);
  // Like the real CLI, child-only --settings enabledPlugins applies to every startup, init-only probes included.
  const childSettings = args.includes("--settings") ? JSON.parse(await readFile(val("--settings"), "utf8")) : {};
  const disabled = key => childSettings.enabledPlugins?.[key] === false;
  const dynamicPlugins = materialized(startup).filter(plugin => !disabled(disableKey(plugin)));
  // A background account sync finishing during the first startup; the plugin exists from the next startup on.
  if (scenario === "synced-materializes" && startup === 1 && stateDir) writeFileSync(join(stateDir, "synced"), "1");
  if (initOnly) {
    if (discovery && scenario === "probe-hook") write({ type: "system", subtype: "hook_started" });
    if (discovery && scenario === "probe-plugin-install") write({ type: "system", subtype: "plugin_install" });
    const plugins = (scenario.startsWith("builtin-") && scenario !== "builtin-materializes" ?
      [{ name: "private-plugin-name", path: "private-path", source: "builtin:private" }] : [])
      .filter(plugin => scenario === "builtin-race" || scenario === "builtin-required-stays" || !disabled(`${plugin.name}@builtin`));
    write({ type: "system", subtype: "init", claude_code_version: scenario === "version-upgrade" ? "2.2.0" : "2.1.280",
      permissionMode: "dontAsk", apiKeySource: "none", tools: ["Glob", "Grep", "Read"],
      mcp_servers: [], agents: [], skills: [], slash_commands: [], plugins: [...plugins, ...dynamicPlugins] });
    setInterval(() => {}, 1000);
  } else {
  if (scenario === "malformed") { process.stdout.write("{bad}\n"); process.exit(0); }
  // M7 hostile-output scenarios: every one must fail closed with a typed error.
  if (scenario === "whitespace-output") { process.stdout.write("   \n"); process.exit(0); }
  if (scenario === "truncated-json") { process.stdout.write('{"type":"system","subtype":"init"'); process.exit(0); }
  if (scenario === "garbage-after-json") { process.stdout.write('{"type":"system","subtype":"init"} trailing\n'); process.exit(0); }
  if (scenario === "primitive-frame") { process.stdout.write("42\n"); process.exit(0); }
  if (scenario === "deep-frame") { process.stdout.write(`${"[".repeat(5000)}${"]".repeat(5000)}\n`); process.exit(0); }
  if (scenario === "long-line") { process.stdout.write(`{"type":"system","subtype":"x","pad":"${"x".repeat(1_100_000)}"}\n`); process.exit(0); }
  if (scenario === "duplicate-frame-key") {
    process.stdout.write('{"type":"system","subtype":"init","permissionMode":"bypassPermissions","model":"claude-canonical-fixture",' +
      '"claude_code_version":"2.1.280","tools":["Glob","Grep","Read"],"mcp_servers":[],"agents":[],"skills":[],"plugins":[],' +
      '"slash_commands":[],"apiKeySource":"none","permissionMode":"dontAsk"}\n');
    process.exit(0);
  }
  if (scenario === "stderr-protocol") {
    process.stderr.write(`${JSON.stringify({ type: "system", subtype: "init", model: "claude-canonical-fixture" })}\n`);
    process.exit(0);
  }
  if (scenario === "stderr-invalid-utf8") process.stderr.write(Buffer.from([0x66, 0xff, 0xfe, 0x0a]));
  if (scenario === "process-failure") process.exit(7);
  if (scenario === "no-init") process.exit(0);
  if (scenario === "plugin-list-multiple") {
    const settings = JSON.parse(await readFile(val("--settings"), "utf8"));
    if (["private-alpha@market", "private-beta@synced", "private-gamma@skills-dir"]
      .some(id => settings.enabledPlugins?.[id] !== false)) process.exit(35);
  }
  if (scenario === "preinit-system") write({ type: "system", subtype: "commands_changed" });
  if (scenario === "hook-active") write({ type: "system", subtype: "hook_started" });
  if (scenario === "slash-command-active") write({ type: "system", subtype: "local_command_output" });
  const init = { type: "system", subtype: "init", cwd: process.cwd(), model: scenario === "model-mismatch" ? "wrong-model" : "claude-canonical-fixture",
    claude_code_version: scenario === "version-upgrade" ? "2.2.0" : "2.1.280",
    tools: ["Glob", "Grep", "Read"], mcp_servers: [], agents: [], skills: [], plugins: [], slash_commands: [],
    permissionMode: "dontAsk", apiKeySource: scenario === "init-api-key" ? "ANTHROPIC_API_KEY" : "none" };
  if (scenario === "init-no-key-source") delete init.apiKeySource;
  if (scenario === "permission") init.permissionMode = "bypassPermissions";
  if (scenario === "shell-tool") init.tools.push("Bash");
  if (scenario === "write-tool") init.tools.push("Write");
  if (scenario === "mcp") init.mcp_servers.push({ name: "connector" });
  if (scenario === "plugin") init.plugins.push({ name: "side-effect", path: "fixture", source: "fixture" });
  if (scenario.startsWith("builtin-") && scenario !== "builtin-materializes") {
    let disabled = false;
    if (args.includes("--settings")) {
      const settings = JSON.parse(await readFile(val("--settings"), "utf8"));
      disabled = settings.enabledPlugins?.["private-plugin-name@builtin"] === false;
    }
    if (!disabled || scenario === "builtin-race" || scenario === "builtin-required-stays")
      init.plugins.push({ name: "private-plugin-name", path: "private-path", source: "builtin:private" });
  }
  init.plugins.push(...dynamicPlugins);
  if (scenario === "inventory") { init.agents.push("available-agent"); init.skills.push("available-skill");
    init.slash_commands.push("available-command"); }
  if (scenario === "inventory-unknown-version") { init.agents.push("available-agent");
    init.skills.push("available-skill"); init.claude_code_version = "2.2.0"; }
  if (scenario === "task-tool") init.tools.push("Task");
  if (scenario === "skill-tool") init.tools.push("Skill");
  if (scenario === "plugin-tool") init.tools.push("mcp__plugin__execute");
  if (scenario === "hooks-field") init.hooks = [{ source: "managed" }];
  write(init);
  if (scenario === "rate-limit-info" || scenario === "overage-active")
    write({ type: "rate_limit_event", rate_limit_info: { status: "allowed",
      isUsingOverage: scenario === "overage-active", rateLimitType: "five_hour" } });
  if (scenario === "timeout" || scenario === "cancel") { setInterval(() => {}, 1000); }
  else if (scenario === "missing-result") process.exit(0);
  else if (scenario === "rate-limit") {
    write({ type: "system", subtype: "api_retry", error_status: 429, attempt: 1 });
    setInterval(() => {}, 1000);
  } else {
    const packet = { result: { status: "completed" }, changes: { files: [], summary: "fixture" },
      verification: { testsRun: [], results: [] }, uncertainties: [], failures: [], needsLeadDecision: [] };
    write({ type: "assistant", message: { model: scenario === "assistant-model-mismatch" ? "wrong-model" : init.model,
      content: [{ type: "text", text: "fixture" }] } });
    const text = process.env.FUSION_FAKE_OUTPUT !== undefined ? process.env.FUSION_FAKE_OUTPUT : scenario === "duplicate-status" ?
      `{"result":{"status":"failed"},"result":{"status":"completed"},"changes":{"files":[],"summary":"fixture"},` +
        '"verification":{"testsRun":[],"results":[]},"uncertainties":[],"failures":[],"needsLeadDecision":[]}' :
      scenario === "deep-packet" ? `${"[".repeat(200)}${"]".repeat(200)}` :
      scenario === "packet-trailing-garbage" ? `${JSON.stringify(packet)} and then prose` : undefined;
    write({ type: "result", subtype: "success", is_error: scenario === "success-error" || scenario === "contradictory-result",
      terminal_reason: scenario === "success-error" ? "api_error" : "completed",
      ...(scenario === "structured-output" ? { structured_output: packet } : {}),
      ...(scenario === "result-missing-text" ? {} : { result: text ?? (scenario === "structured-output" ? "not-json" : scenario === "bad-packet" ? "{bad" :
        JSON.stringify(scenario === "extra-packet" ?
        { ...packet, secret: "must-not-escape" } : packet)) }),
      ...(scenario === "usage-absent" ? {} : { usage: { input_tokens: 12, output_tokens: 7 }, total_cost_usd: 0.0123 }) });
    if (scenario === "multiple-results") write({ type: "result", subtype: "success", is_error: false, terminal_reason: "completed",
      result: JSON.stringify(packet) });
    process.exitCode = scenario === "nonzero" ? 7 : 0;
  }
  }
} else process.exit(34);
