import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import type { AuthStatus, CapabilityRequirement, DelegationPacket, FusionError, StructuredTurnRequest, StructuredTurnResult,
  TurnResult, TurnResultBase } from "../../core/domain.js";
import { raceAbort } from "../../core/cancellation.js";
import { internalError } from "../../core/errors.js";
import { assertRuntimeEvidence } from "../../core/policy/billing-guard.js";
import { meetsCapabilities } from "../../core/capabilities.js";
import { structuredTurnPrompt, structuredTurnSchema } from "../../core/review/contract.js";
import { removeOwnedTemporary } from "../../platform/fs/temporary.js";
import { ProcessSupervisor, type ProcessOutcome } from "../../platform/process/supervisor.js";
import { DiagnosticRedactor } from "../../core/policy/redaction.js";
import { EXEC_CONTROL_FLAGS, MuseFailure, READ_ONLY_PROFILE, capability, fail, prepareLaunch, record, string, type MuseFixtureBinary,
  type MuseLaunchConfig } from "./types.js";
import { assertSupportedSchema, parsePacket, parseStructured, renderPrompt } from "./structured-output.js";

/** Default deadline for one Muse Exec attempt. */
export const MUSE_EXEC_TIMEOUT_MS = 120_000;

export interface ExecRequest {
  readonly packet: DelegationPacket;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly outputSchema?: unknown;
  readonly malformedOutputRetries?: 0 | 1;
  readonly signal?: AbortSignal;
  /** Caller-owned directory. If omitted, no evidence is written and the attempt directory is removed. */
  readonly evidenceDirectory?: string;
}
export interface StructuredExecRequest {
  readonly request: StructuredTurnRequest;
  readonly requiredCapabilities: CapabilityRequirement;
  readonly malformedOutputRetries?: 0 | 1;
  readonly signal?: AbortSignal;
  readonly evidenceDirectory?: string;
}
/** What one Exec attempt sends and how its terminal text becomes output; prompt fragments never enter evidence. */
interface ExecPayload<T> {
  readonly prompt: string;
  readonly schema?: unknown;
  readonly redact: readonly string[];
  readonly parse: (text: string) => T;
}
interface ExecOptions {
  readonly requiredCapabilities: CapabilityRequirement;
  readonly malformedOutputRetries?: 0 | 1;
  readonly signal?: AbortSignal;
  readonly evidenceDirectory?: string;
}
type ExecResult<T> = TurnResultBase & (
  | Readonly<{ status: "completed"; output: T; error?: never }>
  | Readonly<{ status: "failed" | "cancelled"; output?: T; error: FusionError }>);
const packetFragments = (packet: DelegationPacket): string[] =>
  [packet.task.goal, ...packet.task.constraints, ...packet.task.acceptanceCriteria, ...packet.openQuestions];
const evidenceFragments = (request: StructuredTurnRequest): string[] => [request.evidence.task.goal,
  ...request.evidence.task.constraints, ...request.evidence.task.acceptanceCriteria, request.evidence.change.text];

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

/** Delegated task and reviewed change text never enter evidence, even when a provider echoes it on stderr. */
function redactPromptText(text: string, fragments: readonly string[]): string {
  // Prompts carry the fragments JSON-encoded, so an echoed prompt is matched in both forms.
  const long = fragments.flatMap(fragment => typeof fragment === "string" ? [fragment, JSON.stringify(fragment).slice(1, -1)] : [])
    .filter(fragment => fragment.length >= 8).sort((a, b) => b.length - a.length);
  let result = text;
  for (const fragment of long) result = result.split(fragment).join("[REDACTED_PROMPT]");
  const goal = fragments[0];
  if (goal) result = result.split(goal).join("[REDACTED_PROMPT]");
  return result;
}

/** Process-level outcome classification runs before any evidence I/O, so I/O can never mask it. */
function classifyOutcome(outcome: ProcessOutcome, malformed: boolean): MuseFailure | undefined {
  const failure = (kind: MuseFailure["error"]["kind"], safeMessage: string, retryable = false): MuseFailure =>
    new MuseFailure({ kind, safeMessage, retryable });
  if (outcome.issue?.kind === "Timeout") return failure("Timeout", "Muse Exec exceeded its deadline.", true);
  if (outcome.issue?.kind === "Cancelled" || outcome.termination?.reason === "user") return failure("Cancelled", "Muse Exec was cancelled.");
  if (outcome.issue?.kind === "SpawnFailure") return failure("SpawnFailure", "Muse Exec could not start.", true);
  if (outcome.issue?.kind === "OutputLimit") return failure("ProtocolError", "Muse Exec output exceeded Fusion's size limit.");
  if (outcome.issue || malformed || outcome.observerIssues.length > 0) return failure("ProtocolError", "Muse Exec emitted invalid or incomplete JSONL.");
  return undefined;
}

/** One-shot JSONL transport. Auth is freshly attested through account/read before launch. */
export class MuseExecTransport {
  constructor(readonly config: MuseLaunchConfig, private readonly authAttestor: () => Promise<AuthStatus>,
    private readonly supervisor = new ProcessSupervisor(), private readonly fixtureBinary?: MuseFixtureBinary) {}

  async run(request: ExecRequest): Promise<TurnResult> {
    const schema = request.outputSchema;
    return this.attempts({ prompt: renderPrompt(request.packet), ...(schema === undefined ? {} : { schema }),
      redact: packetFragments(request.packet), parse: text => parsePacket(text, schema) }, request);
  }
  /**
   * A structured review or adjudication under exactly the same launch controls and attestations as `run`, decoded
   * with the contract's schema. A failed or cancelled turn hands back no output.
   */
  async runStructured(request: StructuredExecRequest): Promise<StructuredTurnResult> {
    const schema = structuredTurnSchema(request.request);
    const turn = await this.attempts({ prompt: structuredTurnPrompt(request.request), schema,
      redact: evidenceFragments(request.request), parse: text => parseStructured(text, schema) }, request);
    if (turn.status === "completed") return turn;
    return { status: turn.status, effectiveProvider: turn.effectiveProvider, effectiveModel: turn.effectiveModel,
      error: turn.error, artifactRefs: turn.artifactRefs };
  }

  private async attempts<T>(payload: ExecPayload<T>, options: ExecOptions): Promise<ExecResult<T>> {
    const attempts = 1 + (options.malformedOutputRetries ?? 0);
    let last: ExecResult<T> | undefined;
    const refs: string[] = [];
    for (let n = 0; n < attempts; n++) {
      last = await this.runOnce(payload, options);
      refs.push(...last.artifactRefs);
      if (last.status !== "failed" || last.error.kind !== "MalformedOutput") return { ...last, artifactRefs: refs };
    }
    return { ...last!, artifactRefs: refs };
  }

  private attest(signal: AbortSignal | undefined): Promise<AuthStatus> {
    return raceAbort(this.authAttestor(), signal, () => new MuseFailure({ kind: "Cancelled",
      safeMessage: "Muse Exec was cancelled during account attestation.", retryable: false }));
  }

  private async writeEvidence(dir: string, outcome: ProcessOutcome, fragments: readonly string[]): Promise<string[]> {
    const redactor = DiagnosticRedactor.fromEnvironment(this.config.sourceEnvironment ?? process.env);
    const stdoutPath = join(dir, "stdout.jsonl"), stderrPath = join(dir, "stderr.txt");
    await writeFile(stdoutPath, evidenceJsonl(outcome.stdout), { encoding: "utf8", flag: "wx" });
    await writeFile(stderrPath, redactPromptText(redactor.redactText(outcome.stderr), fragments), { encoding: "utf8", flag: "wx" });
    return [stdoutPath, stderrPath];
  }

  /** Prompt and schema files contain delegated task text; they must not outlive the attempt. */
  private async cleanup(dir: string, callerOwned: boolean): Promise<void> {
    if (!callerOwned) { await removeOwnedTemporary(dir); return; }
    for (const name of ["prompt.txt", "schema.json"])
      await rm(join(dir, name), { force: true, maxRetries: 5, retryDelay: 50 });
  }

  private async runOnce<T>(payload: ExecPayload<T>, request: ExecOptions): Promise<ExecResult<T>> {
    let effectiveProvider = "";
    let effectiveModel = "";
    let dir = "";
    let refs: string[] = [];
    let turn: ExecResult<T>;
    try {
      if (request.signal?.aborted) fail("Cancelled", "Muse Exec was cancelled before launch.");
      if (payload.schema !== undefined) assertSupportedSchema(payload.schema);
      if (this.config.maxModelSteps !== undefined && (!Number.isSafeInteger(this.config.maxModelSteps) || this.config.maxModelSteps < 1))
        fail("InvalidInput", "Muse model-step limit must be a positive integer.");
      const launch = await prepareLaunch(this.config, this.fixtureBinary);
      const version = basename(launch.executable).match(/^muse-bin-(.+)\.exe$/i)?.[1] ?? "fixture";
      const caps = capability(this.config, "muse-exec", version, undefined, false);
      if (!meetsCapabilities(caps, request.requiredCapabilities)) fail("CapabilityUnavailable", "Muse Exec lacks a required capability.");
      const auth = await this.attest(request.signal);
      if (auth.state !== "authenticated" || auth.lane !== "subscription") fail("AuthMismatch", "Muse account login is not active.");
      if (request.signal?.aborted) fail("Cancelled", "Muse Exec was cancelled before launch.");
      dir = await mkdtemp(join(request.evidenceDirectory ?? tmpdir(),
        request.evidenceDirectory ? "attempt-" : "fusion-muse-exec-"));
      const promptPath = join(dir, "prompt.txt");
      const schemaPath = join(dir, "schema.json");
      await writeFile(promptPath, payload.prompt, { encoding: "utf8", flag: "wx" });
      if (payload.schema !== undefined) await writeFile(schemaPath, JSON.stringify(payload.schema), { encoding: "utf8", flag: "wx" });
      // The launch-time posture (`capability`) is derived from exactly these control flags.
      const args = [...launch.argvPrefix, "exec", "--json", "--prompt-file", promptPath,
        "--provider", this.config.provider, "--model", this.config.model.id,
        "--reasoning-effort", this.config.model.effort, "--workspace", this.config.workspace,
        ...EXEC_CONTROL_FLAGS,
        ...(this.config.maxModelSteps === undefined ? [] : ["--max-model-steps", String(this.config.maxModelSteps)]),
        ...(payload.schema === undefined ? [] : ["--output-schema", schemaPath])];
      let terminal: { status: "completed" | "failed" | "cancelled"; text: string } | undefined;
      let malformed = false;
      const child = this.supervisor.start({ executable: launch.executable, args, cwd: this.config.workspace, env: launch.env,
        timeoutMs: this.config.timeoutMs ?? MUSE_EXEC_TIMEOUT_MS, ...(request.signal ? { signal: request.signal } : {}),
        maxStdoutBytes: 8 * 1024 * 1024, maxStderrBytes: 2 * 1024 * 1024, onJsonl: value => {
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
      const processFailure = classifyOutcome(outcome, malformed);
      // Persist bounded metadata and redacted stderr only for a caller-owned evidence directory.
      if (request.evidenceDirectory) {
        try { refs = await this.writeEvidence(dir, outcome, payload.redact); }
        catch (error) {
          if (processFailure === undefined) throw new MuseFailure(internalError("Muse Exec evidence could not be recorded.", error));
        }
      }
      if (processFailure) throw processFailure;
      const authAfter = await this.attest(request.signal);
      if (authAfter.state !== "authenticated" || authAfter.lane !== "subscription")
        fail("AuthMismatch", "Muse account login changed during Exec.");
      const observedCaps = capability(this.config, "muse-exec", version, undefined, false);
      const asserted = assertRuntimeEvidence({ provider: this.config.provider, model: this.config.model.id,
        authLane: "subscription", posture: "readOnly", permissionProfileId: READ_ONLY_PROFILE,
        requiredCapabilities: request.requiredCapabilities }, { auth, effectiveProvider: effectiveProvider || null,
        effectiveModel: effectiveModel || null, permission: { posture: "readOnly", profileId: READ_ONLY_PROFILE,
          source: "hostEnforcement", mechanicallyEnforced: true }, capabilities: observedCaps });
      if (!asserted.ok) throw new MuseFailure(asserted.error);
      const final = terminal as { status: "completed" | "failed" | "cancelled"; text: string } | undefined;
      if (!final) fail("ProtocolError", "Muse Exec ended without a terminal event.");
      if (final.status === "cancelled") fail("Cancelled", "Muse Exec reported cancellation.");
      if (final.status === "failed") fail("ProcessFailure", "Muse Exec reported a failed turn.", true);
      if (outcome.exitCode !== 0) fail("ProcessFailure", "Muse Exec completed but exited unsuccessfully.", true);
      const output = payload.parse(final.text);
      // Cancellation observed before the result is handed back wins; the finished packet stays inspectable.
      turn = request.signal?.aborted ?
        { status: "cancelled", effectiveProvider, effectiveModel, output, artifactRefs: refs,
          error: { kind: "Cancelled", safeMessage: "Muse Exec was cancelled before its result was delivered.", retryable: false } } :
        { status: "completed", effectiveProvider, effectiveModel, output, artifactRefs: refs };
    } catch (error) {
      const e = error instanceof MuseFailure ? error.error : internalError("Muse Exec could not complete safely.", error);
      turn = { status: e.kind === "Cancelled" ? "cancelled" : "failed", effectiveProvider, effectiveModel, error: e, artifactRefs: refs };
    }
    if (dir) {
      try { await this.cleanup(dir, request.evidenceDirectory !== undefined); }
      catch (error) {
        // The primary failure stays the reported kind; leftover task text is never hidden either way.
        if (turn.status === "completed") turn = { status: "failed", effectiveProvider, effectiveModel, artifactRefs: refs,
          error: internalError("Temporary Muse prompt files could not be removed.", error) };
        else turn = { ...turn, error: { ...turn.error,
          safeMessage: `${turn.error.safeMessage} Temporary prompt files could not be removed.` } };
      }
    }
    return turn;
  }
}
