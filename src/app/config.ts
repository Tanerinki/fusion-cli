import { lstat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { AGENT_ROLES, type AgentRole, type VerificationCommand, type VerificationPlan } from "../core/domain.js";
import { failWith } from "../core/errors.js";
import { isPlatformRequirement, type PlatformRequirement } from "../core/policy/platform.js";
import { readBoundedFile } from "../platform/fs/bounded-read.js";
import { parseStrictJson } from "../platform/process/strict-json.js";

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
  readonly verification: VerificationPlan & Readonly<{ platformRequirement?: PlatformRequirement }>;
  readonly limits: Readonly<{ runTimeoutMs: number }>;
}
export interface LoadedConfig {
  readonly config: FusionConfig;
  /** `defaults`: no configuration file exists; the registry's default bindings apply. */
  readonly source: "file" | "defaults";
  readonly path?: string;
}

/** Unknown keys fail: a misspelled security setting must never be silently ignored. */
const TOP_KEYS = new Set(["schemaVersion", "bindings", "verification", "limits"]);
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
  const where = `verification.commands[${index}]`;
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

/** Strict validation of parsed configuration. */
export function parseConfig(value: unknown): FusionConfig {
  if (!isRecord(value)) return invalid("the file must contain a JSON object.");
  onlyKeys(value, TOP_KEYS, "the top level");
  if (value.schemaVersion !== 1) invalid("schemaVersion must be 1.");
  const bindings = value.bindings === undefined ? [] : value.bindings;
  if (!Array.isArray(bindings) || bindings.length > CONFIG_LIMITS.maxBindings) invalid("bindings must be a bounded array.");
  const verification = value.verification === undefined ? { commands: [] } : value.verification;
  if (!isRecord(verification)) return invalid("verification must be an object.");
  onlyKeys(verification, new Set(["commands", "platformRequirement"]), "verification");
  if (verification.platformRequirement !== undefined && !isPlatformRequirement(verification.platformRequirement))
    invalid("verification.platformRequirement must be platform-neutral, linux-compatible, windows-required or unknown.");
  const commands = verification.commands ?? [];
  if (!Array.isArray(commands) || commands.length > CONFIG_LIMITS.maxCommands) invalid("verification.commands must be a bounded array.");
  const limits = value.limits === undefined ? {} : value.limits;
  if (!isRecord(limits)) return invalid("limits must be an object.");
  onlyKeys(limits, new Set(["runTimeoutMs"]), "limits");
  const runTimeoutMs = limits.runTimeoutMs ?? CONFIG_LIMITS.defaultRunTimeoutMs;
  if (!Number.isSafeInteger(runTimeoutMs) || (runTimeoutMs as number) < 1_000 || (runTimeoutMs as number) > CONFIG_LIMITS.maxRunTimeoutMs)
    invalid("limits.runTimeoutMs must be between 1 second and 24 hours.");
  return Object.freeze({ schemaVersion: 1, bindings: Object.freeze((bindings as unknown[]).map(parseBinding)),
    verification: Object.freeze({ commands: Object.freeze((commands as unknown[]).map(parseCommand)),
      ...(verification.platformRequirement === undefined ? {} : { platformRequirement: verification.platformRequirement as PlatformRequirement }) }),
    limits: Object.freeze({ runTimeoutMs: runTimeoutMs as number }) });
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
