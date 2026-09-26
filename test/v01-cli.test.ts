import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../src/app/config.js";
import { SAFETY_STATEMENT } from "../src/app/config-report.js";
import { COMMANDS, commandHelp, parseArgs, USAGE, UsageError } from "../src/cli/args.js";
import { runCli } from "../src/cli/run.js";
import { FusionFailure } from "../src/core/errors.js";
import { defaultRegistry } from "../src/providers/registry.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 5 — CLI UX and configuration: grouped help and per-command help, errors that point at the right help,
 * stable exit codes, `fusion config` (roles, conversation partner, verifier profile, evidence and delivery store
 * locations) with paths containing spaces, and no option that disables a safety control.
 */
const skip = gitAvailable ? false : "git executable unavailable";

async function cli(argv: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) {
  let stdout = "", stderr = "";
  const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; } }, { env, cwd, registry: defaultRegistry() });
  return { code, stdout, stderr };
}

test("v0.1 help: every command is documented once, grouped; fusion <command> --help shows that command; no stale readiness text", async () => {
  for (const command of COMMANDS) {
    const help = commandHelp(command);
    assert.ok(help.startsWith("Usage: fusion"), command);
    assert.match(help, new RegExp(`^  ${command}\\b`, "mu"), command);
    assert.notEqual(help, USAGE, `${command} has its own help`);
    assert.equal(USAGE.split("\n").filter(entry => entry.startsWith(`  ${command} `) || entry === `  ${command}`).length, 1, command);
  }
  for (const group of ["Talk and look (read-only; nothing is changed):", "Build and deliver:", "History and setup:", "Options:", "Exit codes:"])
    assert.ok(USAGE.includes(group), group);
  assert.doesNotMatch(USAGE, /REAL_WRITER_MODE_NOT_READY|No live delivery authorization/u, "v0.1 help describes the product as it is");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-v01-help-")));
  try {
    const one = await cli(["build", "--help"], dir);
    assert.equal(one.code, 0);
    assert.match(one.stdout, /^  build \[--path <p>\]/mu);
    assert.doesNotMatch(one.stdout, /^  chat /mu);
    const all = await cli(["--help"], dir);
    assert.equal(all.stdout, USAGE);
    // A usage error names the help of the command it concerns, with the stable invalid-input exit code.
    const bad = await cli(["history", "--limit", "0"], dir);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /^fusion: --limit must be a whole number from 1 to 50\.\nRun `fusion history --help` for usage\.\n$/u);
    const unknown = await cli(["frobnicate"], dir);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Run `fusion --help` for usage/u);
    const json = await cli(["--json", "create", "a library"], dir);
    assert.equal(json.code, 2);
    assert.match(json.stderr, /create is interactive only/u);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("v0.1 safety options: no flag, value or command skips a confirmation, an approval, the precheck or the claim", () => {
  for (const flag of ["--force", "--yes", "-y", "--skip-approval", "--no-precheck", "--unsafe", "--allow-dirty", "--auto-approve", "--dangerous", "--repo"])
    for (const command of ["build", "apply", "approve-delivery", "create"]) {
      const argv = command === "build" || command === "create" ? [command, flag, "--", "task"] : [command, flag, "d-0123456789abcdef01234567"];
      assert.throws(() => parseArgs(argv), (error: unknown) => error instanceof UsageError, `${command} ${flag}`);
    }
  assert.ok(!USAGE.match(/--(force|yes|skip|unsafe|bypass|disable|auto-approve)/u));
  assert.match(SAFETY_STATEMENT, /No setting, flag or variable disables a safety control/u);
});

test("v0.1 configuration: conversation.partner is a strict, optional key; secrets and unknown keys stay refused", () => {
  assert.equal(parseConfig({ schemaVersion: 1, conversation: { partner: "reviewer" } }).conversation?.partner, "reviewer");
  assert.equal(parseConfig({ schemaVersion: 1 }).conversation, undefined);
  for (const conversation of [{ partner: "" }, { partner: "../x" }, { partner: 3 }, { partner: "lead", model: "x" }, "lead"])
    assert.throws(() => parseConfig({ schemaVersion: 1, conversation }), (error: unknown) => error instanceof FusionFailure && error.error.kind === "InvalidInput");
  assert.throws(() => parseConfig({ schemaVersion: 1, safety: { disabled: true } }), /unknown key "safety"/u);
  assert.throws(() => parseConfig({ schemaVersion: 1, bindings: [{ role: "Lead", adapter: "x", model: "m", effort: "e", options: { apiKey: "k" } }] }),
    /credential-like key/u);
});

test("v0.1 fusion config: roles and models, the conversation partner, the verifier profile and where state lives — in a path with spaces",
  { skip }, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "fusion-v01-config-")));
    try {
      const root = join(dir, "my project");
      await mkdir(root);
      git(root, "init", "-q");
      await writeFile(join(root, "fusion.config.json"), JSON.stringify({ schemaVersion: 1,
        bindings: [{ role: "Lead", adapter: "claude-one-shot", model: "opus", effort: "high", maxTurns: 8, options: {} },
          { role: "Reviewer", adapter: "muse-exec", model: "muse-spark-1.3", effort: "low", options: { provider: "meta" } }],
        conversation: { partner: "reviewer" },
        verification: { commands: [], platformRequirement: "linux-compatible", dependencies: "none",
          confinedCommands: [{ id: "unit", executable: "/usr/local/bin/node", args: ["--test"], cwd: ".", timeoutMs: 60_000, mutationPolicy: "readOnly" }] } }));
      const env = { ...process.env, LOCALAPPDATA: join(dir, "state here"), XDG_STATE_HOME: join(dir, "state here") };
      const shown = await cli(["--cwd", root, "config"], dir, env);
      assert.equal(shown.code, 0, shown.stderr);
      assert.match(shown.stdout, new RegExp(`^Configuration: .*my project[\\\\/]fusion\\.config\\.json$`, "mu"));
      assert.match(shown.stdout, /^  Lead \(plans, adjudicates, chat\) +claude-one-shot, model opus, effort high, at most 8 turns$/mu);
      assert.match(shown.stdout, /^  Reviewer \(fresh review\) +meta via muse-exec, model muse-spark-1\.3, effort low$/mu);
      assert.match(shown.stdout, /^Conversation partner: reviewer \(conversation\.partner\)$/mu);
      assert.match(shown.stdout, /^  confined commands: unit: \/usr\/local\/bin\/node --test$/mu);
      assert.match(shown.stdout, /^  Writer builds: supported$/mu);
      assert.match(shown.stdout, /^  run evidence: .*my project[\\/]\.fusion[\\/]runs$/mu);
      assert.match(shown.stdout, /^  delivery store: .*state here.*deliveries \(outside the repository\)$/mu);
      assert.ok(shown.stdout.includes(SAFETY_STATEMENT));
      const json = await cli(["--json", "--cwd", root, "config"], dir, env);
      const document = JSON.parse(json.stdout) as { exitCode: number; config: { conversationPartner: { effective: string }; verification: { writerBuilds: string } } };
      assert.deepEqual([document.exitCode, document.config.conversationPartner.effective, document.config.verification.writerBuilds], [0, "reviewer", "supported"]);
      // An application-state variable pointing into the repository is shown as refused (the delivery service refuses it too).
      const inside = await cli(["--cwd", root, "config"], dir, { ...env, LOCALAPPDATA: join(root, "state"), XDG_STATE_HOME: join(root, "state") });
      assert.match(inside.stdout, /^  delivery store: .*\(REFUSED: overlaps the repository\)$/mu);
      // Without confined commands, Writer builds are reported unsupported, with the reason.
      await writeFile(join(root, "fusion.config.json"), JSON.stringify({ schemaVersion: 1, verification: { commands: [], platformRequirement: "windows-required" } }));
      const unsupported = await cli(["--cwd", root, "config"], dir, env);
      assert.match(unsupported.stdout, /^  Writer builds: unsupported — no verification\.confinedCommands/mu);
      const outside = await cli(["config"], dir, env);
      assert.equal(outside.code, 0, outside.stderr);
      assert.match(outside.stdout, /^Configuration: built-in defaults/mu);
      assert.match(outside.stdout, /^  run evidence: not in a Git repository$/mu);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
