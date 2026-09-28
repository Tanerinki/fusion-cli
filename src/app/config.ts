import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AGENT_ROLES, type AgentRole, type VerificationCommand, type VerificationPlan } from "../core/domain.js";
import { failWith } from "../core/errors.js";
import { isPlatformRequirement, type PlatformRequirement } from "../core/policy/platform.js";
import { TOURNAMENT_LIMITS } from "../core/tournament/contracts.js";
import { NO_EXPERIMENTS, type ExperimentSpecs, type GeneratedSpec, type ProbeExpectation, type ProbeSpec } from "../core/tournament/profile.js";
import { readBoundedFile } from "../platform/fs/bounded-read.js";
import { parseStrictJson } from "../platform/process/strict-json.js";
import { protectedPathsOf } from "../platform/workspace/ignored-monitor.js";

/** Project configuration file, looked up at the repository root. It may be committed: it must never hold secrets. */
export const CONFIG_FILE = "fusion.config.json";
export const CONFIG_LIMITS = Object.freeze({
  maxBytes: 256 * 1024, maxBindings: 32, maxOptionDepth: 4, maxOptionKeys: 64, maxString: 4_096, maxCommands: 64,
  defaultRunTimeoutMs: 30 * 60 * 1000, maxRunTimeoutMs: 24 * 60 * 60 * 1000,
});

export type ConfigValue = string | number | boolean | null | readonly ConfigValue[] | { readonly [key: string]: ConfigValue };
/**
 * Role → provider/model mapping as data. `adapter` names a registered adapter kind; `options` are adapter-specific and
 * validated by that adapter's factory. The control plane never interprets either.
 */
export interface BindingConfig {
  readonly role: AgentRole;
  readonly adapter: string;
  readonly model: string;
  readonly effort: string;
  readonly maxTurns?: number;
  readonly options: Readonly<Record<string, ConfigValue>>;
}
export interface FusionConfig {
  readonly schemaVersion: 1;
  readonly bindings: readonly BindingConfig[];
  /**
   * Read-only verification of the primary workspace for review and read-only builds; may be empty. The optional
   * `platformRequirement` is the host's declaration of which OS semantics verification must demonstrate; absent means
   * `unknown`, which no confined backend accepts (autonomous Writer verification then fails closed).
   */
  readonly verification: VerificationPlan & Readonly<{ platformRequirement?: PlatformRequirement;
    /**
     * The Writer's read-only plan for the CONFINED backend: executables are absolute paths inside the confined runtime
     * (e.g. `/usr/local/bin/node`), never host executables. Absent: a Writer task has no plan and cannot run.
     */
    confinedCommands?: readonly VerificationCommand[];
    /** The dependency lane of confined verification; `none` when absent. */
    dependencies?: "none" | "npm-lockfile";
    /**
     * v0.5: the repository owner's experiments for candidate tournaments, run by Fusion in confinement: probes with a
     * host-owned expectation, bounded property and fuzz runs of the repository's own harness, and the budget of Fusion's
     * mutations. Absent: no experiment beyond the confined checks.
     */
    experiments?: ExperimentSpecs }>;
  readonly limits: Readonly<{ runTimeoutMs: number }>;
  /** Primary-checkout paths monitored by content during autonomous runs even when ignored (e.g. `config/local.yaml`). */
  readonly protection?: Readonly<{ ignoredPaths: readonly string[] }>;
  /** v0.1: the default partner of `fusion chat` / `fusion analyze` (a role such as `lead` or `reviewer`, or a provider id). */
  readonly conversation?: Readonly<{ partner: string }>;
}
export interface LoadedConfig {
  readonly config: FusionConfig;
  /** `defaults`: no configuration file exists; the registry's default bindings apply. */
  readonly source: "file" | "defaults";
  readonly path?: string;
}

/** Unknown keys fail: a misspelled security setting must never be silently ignored. */
const TOP_KEYS = new Set(["schemaVersion", "bindings", "verification", "limits", "protection", "conversation"]);
const BINDING_KEYS = new Set(["role", "adapter", "model", "effort", "maxTurns", "options"]);
const COMMAND_KEYS = new Set(["id", "executable", "args", "cwd", "timeoutMs", "mutationPolicy"]);
const ADAPTER_KIND = /^[a-z][a-z0-9-]{0,63}$/u;
const OPTION_KEY = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
/** Secrets belong in the provider's own login or environment, never in a project file. */
const SECRET_KEY = /api.?key|access.?key|secret|password|passwd|passphrase|private.?key|token|credential|authorization|cookie/iu;
const roles = new Set<unknown>(AGENT_ROLES);

const invalid = (message: string): never => failWith("InvalidInput", `Invalid Fusion configuration: ${message}`);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const label = (value: unknown, max = 128): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
function onlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, where: string): void {
  for (const key of Object.keys(value))
    if (!allowed.has(key)) invalid(`unknown key ${JSON.stringify(key.slice(0, 64))} in ${where}.`);
}

function optionValue(value: unknown, depth: number, where: string): ConfigValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) invalid(`non-finite number in ${where}.`); return value; }
  if (typeof value === "string") {
    if (value.length > CONFIG_LIMITS.maxString || value.includes("\0")) invalid(`oversized or invalid text in ${where}.`);
    return value;
  }
  if (depth >= CONFIG_LIMITS.maxOptionDepth) invalid(`${where} is nested too deeply.`);
  if (Array.isArray(value)) {
    if (value.length > CONFIG_LIMITS.maxOptionKeys) invalid(`${where} has too many items.`);
    return value.map((item, index) => optionValue(item, depth + 1, `${where}[${index}]`));
  }
  if (!isRecord(value)) return invalid(`unsupported value in ${where}.`);
  const entries = Object.entries(value);
  if (entries.length > CONFIG_LIMITS.maxOptionKeys) invalid(`${where} has too many keys.`);
  const out: Record<string, ConfigValue> = {};
  for (const [key, item] of entries) {
    if (!OPTION_KEY.test(key)) invalid(`invalid option key in ${where}.`);
    if (SECRET_KEY.test(key)) invalid(`${where} contains a credential-like key; secrets never belong in Fusion configuration.`);
    out[key] = optionValue(item, depth + 1, `${where}.${key}`);
  }
  return out;
}

function parseBinding(value: unknown, index: number): BindingConfig {
  const where = `bindings[${index}]`;
  if (!isRecord(value)) return invalid(`${where} must be an object.`);
  onlyKeys(value, BINDING_KEYS, where);
  if (!roles.has(value.role)) invalid(`${where}.role must be one of ${AGENT_ROLES.join(", ")}.`);
  if (typeof value.adapter !== "string" || !ADAPTER_KIND.test(value.adapter)) invalid(`${where}.adapter must be an adapter kind.`);
  if (!label(value.model) || !label(value.effort)) invalid(`${where} needs a model and an effort.`);
  if (value.maxTurns !== undefined && (!Number.isSafeInteger(value.maxTurns) || (value.maxTurns as number) < 1 ||
      (value.maxTurns as number) > 100))
    invalid(`${where}.maxTurns must be an integer from 1 to 100.`);
  const options = value.options === undefined ? {} : optionValue(value.options, 0, `${where}.options`);
  if (!isRecord(options)) return invalid(`${where}.options must be an object.`);
  return Object.freeze({ role: value.role as AgentRole, adapter: value.adapter as string, model: value.model as string,
    effort: value.effort as string, ...(value.maxTurns === undefined ? {} : { maxTurns: value.maxTurns as number }),
    options: Object.freeze(options as Record<string, ConfigValue>) });
}

function parseCommand(value: unknown, index: number): VerificationCommand {
  return parseCommandAt(value, `verification.commands[${index}]`);
}
function parseCommandAt(value: unknown, where: string): VerificationCommand {
  if (!isRecord(value)) return invalid(`${where} must be an object.`);
  onlyKeys(value, COMMAND_KEYS, where);
  const { id, executable, args, cwd, timeoutMs, mutationPolicy } = value;
  if (!label(id, 64) || !label(executable, 1024) || !isAbsolute(executable as string) || !Array.isArray(args) ||
      args.length > 256 || !args.every(arg => typeof arg === "string" && arg.length <= CONFIG_LIMITS.maxString && !arg.includes("\0")) ||
      !label(cwd, 512) || !Number.isSafeInteger(timeoutMs) || (mutationPolicy !== "readOnly" && mutationPolicy !== "allowMutation"))
    return invalid(`${where} needs an id, an absolute executable, string args, a cwd, a timeout and a mutation policy.`);
  return Object.freeze({ id: id as string, executable: executable as string, args: Object.freeze([...args as string[]]),
    cwd: cwd as string, timeoutMs: timeoutMs as number, mutationPolicy });
}

const EXPERIMENT_ID = /^[a-z][a-z0-9-]{0,31}$/u;
const EXPERIMENT_ARG = /^-{1,2}[A-Za-z][A-Za-z0-9-]{0,31}$/u;
/**
 * v0.5: `verification.experiments`, strictly: every command is a confined, read-only command whose id Fusion derives from the
 * experiment (`probe-<id>`, `property-<id>`, `fuzz-<id>`), so no experiment can shadow a configured check; counts within the
 * tournament's hard limits.
 */
function parseExperiments(value: unknown): ExperimentSpecs {
  const where = "verification.experiments";
  if (!isRecord(value)) return invalid(`${where} must be an object.`);
  onlyKeys(value, new Set(["probes", "property", "fuzz", "mutation"]), where);
  const list = (key: string, max: number): unknown[] => {
    const raw = value[key] ?? [];
    if (!Array.isArray(raw) || raw.length > max) invalid(`${where}.${key} must be an array of at most ${max}.`);
    return raw as unknown[];
  };
  const command = (raw: unknown, kind: string, id: string, at: string): VerificationCommand => {
    if (!isRecord(raw)) return invalid(`${at}.command must be an object.`);
    if (raw.id !== undefined) invalid(`${at}.command takes its id from the experiment; remove its id.`);
    const parsed = parseCommandAt({ ...raw, id: `${kind}-${id}` }, `${at}.command`);
    if (!parsed.executable.startsWith("/") || parsed.mutationPolicy !== "readOnly")
      invalid(`${at}.command must name an absolute executable inside the confined runtime and be read-only.`);
    return parsed;
  };
  const ids = new Set<string>();
  const idOf = (raw: Record<string, unknown>, at: string): string => {
    if (typeof raw.id !== "string" || !EXPERIMENT_ID.test(raw.id)) invalid(`${at}.id must be a short lowercase id.`);
    if (ids.has(raw.id as string)) invalid(`${at}.id is used twice.`);
    ids.add(raw.id as string);
    return raw.id as string;
  };
  const probes = list("probes", TOURNAMENT_LIMITS.maxProbes).map((raw, index): ProbeSpec => {
    const at = `${where}.probes[${index}]`;
    if (!isRecord(raw)) return invalid(`${at} must be an object.`);
    onlyKeys(raw, new Set(["id", "command", "expect"]), at);
    const id = idOf(raw, at);
    let expect: ProbeExpectation;
    if (raw.expect === "baseline" || raw.expect === "compare") expect = Object.freeze({ kind: raw.expect });
    else if (isRecord(raw.expect)) {
      onlyKeys(raw.expect, new Set(["exitCode", "stdout"]), `${at}.expect`);
      const { exitCode, stdout } = raw.expect;
      if (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0 || (exitCode as number) > 255 ||
          (stdout !== undefined && (typeof stdout !== "string" || stdout.length > 8_192)))
        invalid(`${at}.expect needs an exit code (0-255) and at most 8 KiB of expected output.`);
      expect = Object.freeze({ kind: "output", exitCode: exitCode as number, ...(stdout === undefined ? {} : { stdout: stdout as string }) });
    } else return invalid(`${at}.expect must be "baseline", "compare" or { "exitCode", "stdout" }.`);
    return Object.freeze({ id, command: command(raw.command, "probe", id, at), expect });
  });
  const generated = (key: "property" | "fuzz", max: number, maxCases: number): GeneratedSpec[] => list(key, max).map((raw, index) => {
    const at = `${where}.${key}[${index}]`;
    if (!isRecord(raw)) return invalid(`${at} must be an object.`);
    onlyKeys(raw, new Set(["id", "command", "seedArg", "casesArg", "cases"]), at);
    const id = idOf(raw, at);
    if (typeof raw.seedArg !== "string" || !EXPERIMENT_ARG.test(raw.seedArg) || typeof raw.casesArg !== "string" || !EXPERIMENT_ARG.test(raw.casesArg))
      invalid(`${at} needs a seedArg and a casesArg such as --seed and --cases.`);
    if (!Number.isSafeInteger(raw.cases) || (raw.cases as number) < 1 || (raw.cases as number) > maxCases)
      invalid(`${at}.cases must be between 1 and ${maxCases}.`);
    return Object.freeze({ id, command: command(raw.command, key, id, at), seedArg: raw.seedArg as string, casesArg: raw.casesArg as string,
      cases: raw.cases as number });
  });
  const property = generated("property", TOURNAMENT_LIMITS.maxPropertyRuns, TOURNAMENT_LIMITS.maxPropertyCases);
  const fuzz = generated("fuzz", TOURNAMENT_LIMITS.maxFuzzRuns, TOURNAMENT_LIMITS.maxFuzzCases);
  let mutation = NO_EXPERIMENTS.mutation;
  if (value.mutation !== undefined) {
    if (!isRecord(value.mutation)) return invalid(`${where}.mutation must be an object.`);
    onlyKeys(value.mutation, new Set(["maxPerCandidate"]), `${where}.mutation`);
    const max = value.mutation.maxPerCandidate;
    if (!Number.isSafeInteger(max) || (max as number) < 0 || (max as number) > TOURNAMENT_LIMITS.maxMutationsPerCandidate)
      invalid(`${where}.mutation.maxPerCandidate must be between 0 and ${TOURNAMENT_LIMITS.maxMutationsPerCandidate}.`);
    mutation = Object.freeze({ enabled: (max as number) > 0, maxPerCandidate: max as number });
  }
  return Object.freeze({ probes: Object.freeze(probes), property: Object.freeze(property), fuzz: Object.freeze(fuzz), mutation });
}

/** Strict validation of parsed configuration. */
export function parseConfig(value: unknown): FusionConfig {
  if (!isRecord(value)) return invalid("the file must contain a JSON object.");
  onlyKeys(value, TOP_KEYS, "the top level");
  if (value.schemaVersion !== 1) invalid("schemaVersion must be 1.");
  const bindings = value.bindings === undefined ? [] : value.bindings;
  if (!Array.isArray(bindings) || bindings.length > CONFIG_LIMITS.maxBindings) invalid("bindings must be a bounded array.");
  const verification = value.verification === undefined ? { commands: [] } : value.verification;
  if (!isRecord(verification)) return invalid("verification must be an object.");
  onlyKeys(verification, new Set(["commands", "platformRequirement", "confinedCommands", "dependencies", "experiments"]), "verification");
  if (verification.platformRequirement !== undefined && !isPlatformRequirement(verification.platformRequirement))
    invalid("verification.platformRequirement must be platform-neutral, linux-compatible, windows-required or unknown.");
  const commands = verification.commands ?? [];
  if (!Array.isArray(commands) || commands.length > CONFIG_LIMITS.maxCommands) invalid("verification.commands must be a bounded array.");
  const confined = verification.confinedCommands;
  if (confined !== undefined && (!Array.isArray(confined) || confined.length > CONFIG_LIMITS.maxCommands))
    invalid("verification.confinedCommands must be a bounded array.");
  const confinedCommands = (confined as unknown[] | undefined)?.map((command, index) => {
    const parsed = parseCommand(command, index);
    // Inside the confined runtime: an absolute POSIX path, never a host drive path, and never a mutating command.
    if (!parsed.executable.startsWith("/") || parsed.mutationPolicy !== "readOnly")
      invalid(`verification.confinedCommands[${index}] must name an absolute executable inside the confined runtime and be read-only.`);
    return parsed;
  });
  if (verification.dependencies !== undefined && verification.dependencies !== "none" && verification.dependencies !== "npm-lockfile")
    invalid("verification.dependencies must be none or npm-lockfile.");
  const experiments = verification.experiments === undefined ? undefined : parseExperiments(verification.experiments);
  if (experiments !== undefined) {
    const checks = new Set((confinedCommands ?? []).map(command => command.id));
    const shadowing = [...experiments.probes, ...experiments.property, ...experiments.fuzz].find(spec => checks.has(spec.command.id));
    if (shadowing !== undefined) invalid(`verification.experiments: ${shadowing.command.id} is already a confined command id.`);
  }
  const protection = value.protection;
  if (protection !== undefined) {
    if (!isRecord(protection)) return invalid("protection must be an object.");
    onlyKeys(protection, new Set(["ignoredPaths"]), "protection");
  }
  let ignoredPaths: readonly string[] | undefined;
  try { ignoredPaths = protection === undefined ? undefined : protectedPathsOf((protection as Record<string, unknown>).ignoredPaths ?? []); }
  catch { return invalid("protection.ignoredPaths must list canonical repository-relative paths (directories end with /)."); }
  const conversation = value.conversation;
  if (conversation !== undefined) {
    if (!isRecord(conversation)) return invalid("conversation must be an object.");
    onlyKeys(conversation, new Set(["partner"]), "conversation");
    if (typeof conversation.partner !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(conversation.partner))
      invalid("conversation.partner must name a role (such as lead or reviewer) or a provider id.");
  }
  const limits = value.limits === undefined ? {} : value.limits;
  if (!isRecord(limits)) return invalid("limits must be an object.");
  onlyKeys(limits, new Set(["runTimeoutMs"]), "limits");
  const runTimeoutMs = limits.runTimeoutMs ?? CONFIG_LIMITS.defaultRunTimeoutMs;
  if (!Number.isSafeInteger(runTimeoutMs) || (runTimeoutMs as number) < 1_000 || (runTimeoutMs as number) > CONFIG_LIMITS.maxRunTimeoutMs)
    invalid("limits.runTimeoutMs must be between 1 second and 24 hours.");
  return Object.freeze({ schemaVersion: 1, bindings: Object.freeze((bindings as unknown[]).map(parseBinding)),
    verification: Object.freeze({ commands: Object.freeze((commands as unknown[]).map(parseCommand)),
      ...(verification.platformRequirement === undefined ? {} : { platformRequirement: verification.platformRequirement as PlatformRequirement }),
      ...(confinedCommands === undefined ? {} : { confinedCommands: Object.freeze(confinedCommands) }),
      ...(verification.dependencies === undefined ? {} : { dependencies: verification.dependencies as "none" | "npm-lockfile" }),
      ...(experiments === undefined ? {} : { experiments }) }),
    limits: Object.freeze({ runTimeoutMs: runTimeoutMs as number }),
    ...(ignoredPaths === undefined ? {} : { protection: Object.freeze({ ignoredPaths }) }),
    ...(conversation === undefined ? {} : { conversation: Object.freeze({ partner: (conversation as Record<string, string>).partner! }) }) });
}

/**
 * Loads `--config <path>` or `<repository>/fusion.config.json`; without a file, `defaults` apply (typically the
 * registry's default bindings). Files are read bounded, never through a link, and parsed as strict JSON.
 */
export async function loadConfig(repositoryRoot: string | undefined, explicitPath: string | undefined, cwd: string,
  defaults: FusionConfig): Promise<LoadedConfig> {
  const path = explicitPath !== undefined ? resolve(cwd, explicitPath)
    : repositoryRoot !== undefined ? join(repositoryRoot, CONFIG_FILE) : undefined;
  if (path === undefined) return { config: defaults, source: "defaults" };
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && explicitPath === undefined) return { config: defaults, source: "defaults" };
    return invalid(explicitPath === undefined ? "the configuration file is unreadable." : "the --config file does not exist.");
  }
  if (!info.isFile() || info.isSymbolicLink()) invalid("the configuration path is not a regular file.");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(await readBoundedFile(path, CONFIG_LIMITS.maxBytes)); }
  catch { return invalid("the configuration file is unreadable, not UTF-8, or larger than 256 KiB."); }
  let parsed: unknown;
  try { parsed = parseStrictJson(text, 16); } catch { return invalid("the file is not strict JSON (duplicate keys are rejected)."); }
  return { config: parseConfig(parsed), source: "file", path };
}
