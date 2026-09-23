import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { AuthStatus, CapabilityRequirement, DelegationPacket, TurnResult } from "../../core/domain.js";
import { assertRuntimeEvidence } from "../../core/policy/billing-guard.js";
import { meetsCapabilities } from "../../core/capabilities.js";
import { ProcessSupervisor } from "../../platform/process/supervisor.js";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { MuseFailure, READ_ONLY_FLAGS, READ_ONLY_PROFILE, capability, fail, prepareLaunch, record, string, type MuseFixtureBinary, type MuseLaunchConfig } from "./types.js";
import { assertSupportedSchema, parsePacket, renderPrompt } from "./structured-output.js";

export interface ExecRequest {
  readonly packet: DelegationPacket;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly outputSchema?: unknown;
  readonly malformedOutputRetries?: 0 | 1;
  readonly signal?: AbortSignal;
  /** Caller-owned directory. If omitted, per-attempt evidence is deleted before return. */
  readonly evidenceDirectory?: string;
}

function evidenceJsonl(stdout: string): string {
  return stdout.split(/\r?\n/u).filter(Boolean).map(line => {
    try {
      const frame = record(JSON.parse(line) as unknown), payload = record(frame?.payload);
      if (!frame || typeof frame.payload_type !== "string") throw new Error("invalid");
      return JSON.stringify({ payload_type: frame.payload_type,
        ...(frame.payload_type === "run.model.configured" ? { provider_id: payload?.provider_id, model_id: payload?.model_id } : {}),
        ...(frame.payload_type.startsWith("run.terminal.") ? { terminal: payload?.terminal,
          textSha256: createHash("sha256").update(String(payload?.text ?? "")).digest("hex") } : {}) });
    } catch { return JSON.stringify({ kind: "malformedLine", sha256: createHash("sha256").update(line).digest("hex") }); }
  }).join("\n") + "\n";
}

/** One-shot JSONL transport. Auth is freshly attested through account/read before launch. */
export class MuseExecTransport {
  constructor(readonly config: MuseLaunchConfig, private readonly authAttestor: () => Promise<AuthStatus>,
    private readonly supervisor = new ProcessSupervisor(), private readonly fixtureBinary?: MuseFixtureBinary) {}

  async run(request: ExecRequest): Promise<TurnResult> {
    const attempts = 1 + (request.malformedOutputRetries ?? 0);
    let last: TurnResult | undefined;
    const refs: string[] = [];
    for (let n = 0; n < attempts; n++) {
      last = await this.runOnce(request);
      refs.push(...last.artifactRefs);
      if (last.status !== "failed" || last.error.kind !== "MalformedOutput") return { ...last, artifactRefs: refs };
    }
    return { ...last!, artifactRefs: refs };
  }

  private async runOnce(request: ExecRequest): Promise<TurnResult> {
    let effectiveProvider = "";
    let effectiveModel = "";
    let artifact = "";
    let evidenceWritten = false;
    let promptPath = "";
    let schemaPath = "";
    try {
      if (request.signal?.aborted) fail("Cancelled", "Muse Exec was cancelled before launch.");
      if (request.outputSchema !== undefined) assertSupportedSchema(request.outputSchema);
      const launch = await prepareLaunch(this.config, this.fixtureBinary);
      const version = basename(launch.executable).match(/^muse-bin-(.+)\.exe$/i)?.[1] ?? "fixture";
      const caps = capability(this.config, "muse-exec", version, undefined, false);
      if (!meetsCapabilities(caps, request.requiredCapabilities)) fail("CapabilityUnavailable", "Muse Exec lacks a required capability.");
      const auth = await this.authAttestor();
      if (auth.state !== "authenticated" || auth.lane !== "subscription") fail("AuthMismatch", "Muse account login is not active.");
      const dir = await mkdtemp(join(request.evidenceDirectory ?? tmpdir(),
        request.evidenceDirectory ? "attempt-" : "fusion-muse-exec-"));
      artifact = dir;
      promptPath = join(dir, "prompt.txt");
      schemaPath = join(dir, "schema.json");
      const prompt = renderPrompt(request.packet);
      await writeFile(promptPath, prompt, { encoding: "utf8", flag: "wx" });
      if (request.outputSchema !== undefined) await writeFile(schemaPath, JSON.stringify(request.outputSchema), { encoding: "utf8", flag: "wx" });
      if (this.config.maxModelSteps !== undefined && (!Number.isSafeInteger(this.config.maxModelSteps) || this.config.maxModelSteps < 1))
        fail("InvalidInput", "Muse model-step limit must be a positive integer.");
      const args = [...launch.argvPrefix, "exec", "--json", "--prompt-file", promptPath,
        "--provider", this.config.provider, "--model", this.config.model.id,
        "--reasoning-effort", this.config.model.effort, "--workspace", this.config.workspace,
        "--approval-mode", "never", ...READ_ONLY_FLAGS,
        ...(this.config.maxModelSteps === undefined ? [] : ["--max-model-steps", String(this.config.maxModelSteps)]),
        ...(request.outputSchema === undefined ? [] : ["--output-schema", schemaPath])];
      let terminal: { status: "completed" | "failed" | "cancelled"; text: string } | undefined;
      let malformed = false;
      const child = this.supervisor.start({ executable: launch.executable, args, cwd: this.config.workspace, env: launch.env,
        timeoutMs: this.config.timeoutMs ?? 120_000, ...(request.signal ? { signal: request.signal } : {}), maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: 2 * 1024 * 1024, onJsonl: value => {
          const envelope = record(value), payload = record(envelope?.payload);
          if (!envelope || !payload || typeof envelope.payload_type !== "string" || envelope.schema_version !== 1) { malformed = true; return; }
          if (envelope.payload_type === "run.model.configured") {
            const p = string(payload.provider_id), m = string(payload.model_id);
            if (!p || !m || (effectiveProvider && effectiveProvider !== p) || (effectiveModel && effectiveModel !== m)) malformed = true;
            else { effectiveProvider = p; effectiveModel = m; }
          }
          if (envelope.payload_type.startsWith("run.terminal.")) {
            const status = envelope.payload_type.slice("run.terminal.".length);
            if (!(["completed", "failed", "cancelled"] as string[]).includes(status) || terminal || payload.terminal !== status) { malformed = true; return; }
            terminal = { status: status as "completed" | "failed" | "cancelled", text: typeof payload.text === "string" ? payload.text : "" };
          }
        } });
      const outcome = await child.result;
      // Persist bounded metadata and redacted stderr; prompt and model text stay out of artifacts.
      const redactor = DiagnosticRedactor.fromEnvironment(this.config.sourceEnvironment ?? process.env);
      await writeFile(join(dir, "stdout.jsonl"), evidenceJsonl(outcome.stdout), "utf8");
      const stderr = redactor.redactText(outcome.stderr);
      await writeFile(join(dir, "stderr.txt"), request.packet.task.goal ?
        stderr.replaceAll(request.packet.task.goal, "[REDACTED_PROMPT]") : stderr, "utf8");
      evidenceWritten = true;
      if (outcome.issue?.kind === "Timeout") fail("Timeout", "Muse Exec exceeded its deadline.", true);
      if (outcome.termination?.reason === "user") fail("Cancelled", "Muse Exec was cancelled.");
      if (outcome.issue?.kind === "SpawnFailure") fail("SpawnFailure", "Muse Exec could not start.", true);
      if (outcome.issue || malformed || outcome.observerIssues.length > 0) fail("ProtocolError", "Muse Exec emitted invalid or incomplete JSONL.");
      const authAfter = await this.authAttestor();
      if (authAfter.state !== "authenticated" || authAfter.lane !== "subscription")
        fail("AuthMismatch", "Muse account login changed during Exec.");
      const observedCaps = capability(this.config, "muse-exec", version, undefined, false);
      const asserted = assertRuntimeEvidence({ provider: this.config.provider, model: this.config.model.id,
        authLane: "subscription", posture: "readOnly", permissionProfileId: READ_ONLY_PROFILE,
        requiredCapabilities: request.requiredCapabilities }, { auth, effectiveProvider: effectiveProvider || null,
        effectiveModel: effectiveModel || null, permission: { posture: "readOnly", profileId: READ_ONLY_PROFILE,
          source: "hostEnforcement", mechanicallyEnforced: true }, capabilities: observedCaps });
      if (!asserted.ok) throw new MuseFailure(asserted.error);
      if (!terminal) fail("ProtocolError", "Muse Exec ended without a terminal event.");
      const state = terminal.status;
      if (state === "cancelled") fail("Cancelled", "Muse Exec reported cancellation.");
      if (state === "failed") fail("ProcessFailure", "Muse Exec reported a failed turn.", true);
      if (outcome.exitCode !== 0) fail("ProcessFailure", "Muse Exec completed but exited unsuccessfully.", true);
      const output = parsePacket(terminal.text, request.outputSchema);
      return { status: "completed", effectiveProvider, effectiveModel, output,
        artifactRefs: request.evidenceDirectory ? [join(dir, "stdout.jsonl"), join(dir, "stderr.txt")] : [] };
    } catch (error) {
      const e = error instanceof MuseFailure ? error.error : { kind: "InternalError" as const, safeMessage: "Muse Exec could not complete safely.", retryable: false };
      return { status: e.kind === "Cancelled" ? "cancelled" : "failed", effectiveProvider, effectiveModel,
        error: e, artifactRefs: artifact && request.evidenceDirectory && evidenceWritten ?
          [join(artifact, "stdout.jsonl"), join(artifact, "stderr.txt")] : [] };
    } finally {
      if (promptPath) await unlink(promptPath).catch(() => {});
      if (schemaPath) await unlink(schemaPath).catch(() => {});
      if (artifact && !request.evidenceDirectory) {
        await unlink(join(artifact, "stdout.jsonl")).catch(() => {});
        await unlink(join(artifact, "stderr.txt")).catch(() => {});
        await rmdir(artifact).catch(() => {});
      }
    }
  }
}
