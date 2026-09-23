import { failWith } from "../errors.js";
import { assessRisk, type RiskAssessment, type RiskLevel, type RiskSignal } from "./risk.js";
import { RISK_TEXT_LIMITS, scanRiskText } from "./risk-text.js";

/** Provider-neutral description of requested work. No model output is ever an input here. */
export type TaskOperation = "read" | "analyze" | "review" | "test" | "edit" | "implement" | "refactor" | "configure" |
  "delete" | "migrate" | "release";
export type MutationScope = "none" | "singleFile" | "multiFile" | "broad" | "unknown";
export interface TaskRequest {
  readonly operation: TaskOperation;
  /** Human request text; scanned only by fixed patterns that can raise, never lower, risk. Bounded, never truncated. */
  readonly summary: string;
  /** Repository-relative paths the task is expected to touch. */
  readonly paths: readonly string[];
  /** False when the caller cannot bound which files may change. */
  readonly scopeKnown: boolean;
  readonly expectedMutation: MutationScope;
  readonly requestedCapabilities: Readonly<{ write?: boolean; shell?: boolean; network?: boolean; externalSideEffects?: boolean }>;
  readonly verification: Readonly<{ required: boolean; planProvided: boolean }>;
  readonly indicators?: Readonly<{
    irreversible?: boolean; destructiveGit?: boolean; dependencyChange?: boolean; schemaChange?: boolean;
    architectureChange?: boolean; ambiguousArchitecture?: boolean; ambiguousCapabilityEnforcement?: boolean;
  }>;
}
export type PathClass = "gitInternals" | "credentialMaterial" | "fusionStorage" | "securitySensitive" | "ciOrRelease" |
  "dependencyManifest" | "migrationOrSchema" | "repositoryControl" | "verificationControl";
/** Structured signals derived from a task; `risk` is the gate's initial assessment of them. */
export interface TaskInspection {
  readonly operation: TaskOperation;
  readonly writes: boolean;
  readonly scope: MutationScope;
  readonly paths: readonly string[];
  readonly pathClasses: Readonly<Partial<Record<PathClass, readonly string[]>>>;
  readonly destructivePhrases: readonly string[];
  readonly risk: RiskAssessment;
}

const OPERATIONS = new Set<TaskOperation>(["read", "analyze", "review", "test", "edit", "implement", "refactor", "configure",
  "delete", "migrate", "release"]);
const READ_ONLY_OPERATIONS = new Set<TaskOperation>(["read", "analyze", "review", "test"]);
const SCOPES = new Set<MutationScope>(["none", "singleFile", "multiFile", "broad", "unknown"]);
const MAX_PATHS = 10_000;
const CAPABILITY_KEYS = new Set(["write", "shell", "network", "externalSideEffects"]);
const INDICATOR_KEYS = new Set(["irreversible", "destructiveGit", "dependencyChange", "schemaChange", "architectureChange",
  "ambiguousArchitecture", "ambiguousCapabilityEnforcement"]);
const REQUEST_KEYS = new Set(["operation", "summary", "paths", "scopeKnown", "expectedMutation", "requestedCapabilities",
  "verification", "indicators"]);
/** Beyond this many files a declared multi-file change is treated as broad. */
export const BROAD_SCOPE_FILE_COUNT = 20;

const PATH_CLASS_LEVEL: Readonly<Record<PathClass, RiskLevel>> = {
  gitInternals: "critical", credentialMaterial: "critical", fusionStorage: "high", securitySensitive: "high",
  ciOrRelease: "high", dependencyManifest: "high", migrationOrSchema: "high", repositoryControl: "high",
  verificationControl: "medium",
};
/** Level when a class is only read: exposing credentials matters; reading control files does not. */
const READ_CLASS_LEVEL: Readonly<Partial<Record<PathClass, RiskLevel>>> = {
  credentialMaterial: "high", repositoryControl: "low", verificationControl: "low",
};
const SENSITIVE_SEGMENT = /(?:^|[._-])(?:auth|authn|authz|authentication|authorization|authorize|oauth2?|openid|saml|sso|jwt|login|logout|session|sessions|permission|permissions|acl|rbac|abac|policy|policies|security|crypto|cryptography|encryption|secret|secrets|credential|credentials|token|tokens|password|passwords|billing|payment|payments|invoice|invoices|license|licensing|guard|guards|sandbox)(?:$|[._-])/u;
const CREDENTIAL_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|crt|cer)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?)$/u;
const DEPENDENCY_FILE = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements(?:[-._].*)?\.txt|pyproject\.toml|poetry\.lock|pipfile(?:\.lock)?|setup\.py|setup\.cfg|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|.*\.csproj|packages\.config|directory\.packages\.props|composer\.(?:json|lock))$/u;
const CI_FILE = /^(?:\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile|codeowners|\.travis\.yml|dockerfile|release\.config\.[cm]?js)$/u;
const MIGRATION = /(?:^|\/)(?:migrations?|migrate|schema|schemas)(?:\/|$)|\.sql$|(?:^|\/)schema\.(?:prisma|graphql|sql)$/u;
/** Files that change how Git itself behaves for everyone using the repository (ignore rules, attributes, hooks). */
const REPOSITORY_CONTROL_FILE = /^(?:\.gitignore|\.gitattributes|\.gitmodules|\.?lefthook(?:-local)?\.(?:yml|yaml|json|toml)|\.pre-commit-config\.ya?ml)$/u;
const REPOSITORY_CONTROL_DIR = new Set([".husky", ".githooks"]);
/** Files that change how verification decides a pass: test-runner, compiler and build configuration. */
const VERIFICATION_CONTROL_FILE = new RegExp([
  "^(?:jest|vitest|playwright|cypress|karma|ava|wdio)\\.(?:config|conf|setup|workspace)(?:\\.[a-z0-9_-]+)+$",
  "^\\.(?:mocharc|nycrc|c8rc|babelrc)(?:\\.[a-z0-9]+)?$",
  "^tsconfig(?:\\.[a-z0-9_-]+)*\\.json$",
  "^(?:jsconfig\\.json|babel\\.config\\.[a-z0-9.]+|pytest\\.ini|conftest\\.py|tox\\.ini|noxfile\\.py|\\.coveragerc|makefile|justfile|taskfile\\.ya?ml|\\.nvmrc|\\.node-version)$",
].join("|"), "u");

function normalizePath(raw: string): { path: string; escapes: boolean } {
  const unified = raw.replace(/\\/gu, "/");
  const escapes = /^(?:[a-z]:|\/|\/\/)/iu.test(unified) || unified.split("/").some(part => part === "..");
  const path = unified.split("/").filter(part => part !== "" && part !== ".").join("/");
  return { path, escapes };
}

/** Case-insensitive comparison key for a repository-relative path, as used by scope checks. */
export function scopeKey(path: string): string {
  return normalizePath(path).path.toLowerCase();
}

/** Classifies one repository-relative path. Deterministic and case-insensitive. */
export function classifyPath(path: string): PathClass[] {
  const lower = normalizePath(path).path.toLowerCase();
  const segments = lower.split("/");
  const base = segments[segments.length - 1] ?? "";
  const classes = new Set<PathClass>();
  if (segments[0] === ".git") classes.add("gitInternals");
  if (segments[0] === ".fusion") classes.add("fusionStorage");
  if (CREDENTIAL_FILE.test(base)) classes.add("credentialMaterial");
  if (segments.some(segment => SENSITIVE_SEGMENT.test(segment.replace(/\.[a-z0-9]+$/u, "")))) classes.add("securitySensitive");
  if (lower.startsWith(".github/workflows/") || lower.startsWith(".github/actions/") || CI_FILE.test(base)) classes.add("ciOrRelease");
  if (DEPENDENCY_FILE.test(base)) classes.add("dependencyManifest");
  if (MIGRATION.test(lower)) classes.add("migrationOrSchema");
  if (REPOSITORY_CONTROL_FILE.test(base) || segments.slice(0, -1).some(segment => REPOSITORY_CONTROL_DIR.has(segment)))
    classes.add("repositoryControl");
  if (VERIFICATION_CONTROL_FILE.test(base)) classes.add("verificationControl");
  return [...classes].sort();
}

const signal = (code: string, level: RiskLevel, source: RiskSignal["source"], evidence: string): RiskSignal =>
  ({ code, level, source, evidence });

const plainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
/** Security-relevant flags are exactly booleans; an unknown key or any other value is refused, never ignored. */
function booleanFlags(value: unknown, keys: ReadonlySet<string>, what: string): void {
  if (!plainObject(value)) failWith("InvalidInput", `Task ${what} must be an object.`);
  for (const [key, flag] of Object.entries(value))
    if (!keys.has(key) || (flag !== undefined && typeof flag !== "boolean"))
      failWith("InvalidInput", `Task ${what} must contain only known boolean flags.`);
}

function validate(request: TaskRequest): void {
  if (!plainObject(request)) failWith("InvalidInput", "Task request must be an object.");
  if (Object.keys(request).some(key => !REQUEST_KEYS.has(key))) failWith("InvalidInput", "Task request has unknown fields.");
  if (!OPERATIONS.has(request.operation)) failWith("InvalidInput", "Unknown task operation.");
  if (typeof request.summary !== "string") failWith("InvalidInput", "Task summary must be a string.");
  if (request.summary.length > RISK_TEXT_LIMITS.maxChars)
    failWith("InvalidInput", `Task summary exceeds ${RISK_TEXT_LIMITS.maxChars} characters; it is refused, not truncated.`);
  if (!Array.isArray(request.paths) || request.paths.length > MAX_PATHS ||
      !request.paths.every(path => typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.includes("\0")))
    failWith("InvalidInput", "Task paths must be a bounded list of non-empty repository paths.");
  if (typeof request.scopeKnown !== "boolean" || !SCOPES.has(request.expectedMutation))
    failWith("InvalidInput", "Task scope must be declared.");
  booleanFlags(request.requestedCapabilities, CAPABILITY_KEYS, "capabilities");
  if (request.indicators !== undefined) booleanFlags(request.indicators, INDICATOR_KEYS, "indicators");
  const verification: unknown = request.verification;
  if (!plainObject(verification) || Object.keys(verification).some(key => key !== "required" && key !== "planProvided") ||
      typeof verification.required !== "boolean" || typeof verification.planProvided !== "boolean")
    failWith("InvalidInput", "Task verification requirements must be declared as booleans.");
}

/**
 * Derives structured signals and the initial risk assessment. Identical input always yields an identical
 * result: paths are normalized and sorted, and no clock, randomness or environment is consulted.
 */
export function inspectTask(request: TaskRequest): TaskInspection {
  validate(request);
  const signals: RiskSignal[] = [];
  const normalized = request.paths.map(normalizePath);
  const paths = [...new Set(normalized.map(entry => entry.path).filter(Boolean))].sort();
  for (const entry of normalized) {
    if (entry.escapes) signals.push(signal("outOfRepositoryScope", "critical", "scope", "a task path is absolute or climbs out of the repository"));
  }
  const writes = !READ_ONLY_OPERATIONS.has(request.operation) || request.requestedCapabilities.write === true ||
    (request.expectedMutation !== "none");
  let scope: MutationScope = request.expectedMutation;
  if (writes && (!request.scopeKnown || scope === "unknown")) scope = "unknown";
  else if (writes && scope === "none") scope = paths.length <= 1 ? "singleFile" : "multiFile";
  if (writes && scope !== "unknown" && paths.length > BROAD_SCOPE_FILE_COUNT) scope = "broad";
  if (writes && scope === "singleFile" && paths.length > 1) scope = "multiFile";

  if (!writes) signals.push(signal("readOnlyTask", "low", "task", `operation ${request.operation} without writes`));
  else if (scope === "singleFile") signals.push(signal("narrowWriteScope", "low", "scope", "one known file may change"));
  else if (scope === "multiFile") signals.push(signal("multiFileWriteScope", "medium", "scope", `${paths.length} known files may change`));
  else if (scope === "broad") signals.push(signal("broadWriteScope", "high", "scope", `more than ${BROAD_SCOPE_FILE_COUNT} files may change`));
  else signals.push(signal("unknownWriteScope", "high", "scope", "the set of files that may change is not bounded"));
  if (writes && paths.length === 0 && scope !== "unknown")
    signals.push(signal("unknownWriteScope", "high", "scope", "a writing task declared no paths"));

  if (request.operation === "delete") signals.push(signal("deletionRequested", "high", "task", "files or data are to be deleted"));
  if (request.operation === "migrate") signals.push(signal("migrationRequested", "high", "task", "a migration was requested"));
  if (request.operation === "release") signals.push(signal("releaseRequested", "critical", "task", "a release has external effects"));
  if (request.operation === "configure") signals.push(signal("configurationChange", "medium", "task", "configuration is to change"));

  const caps = request.requestedCapabilities;
  if (caps.shell === true) signals.push(signal("shellRequested", "medium", "capability", "shell execution was requested"));
  if (caps.network === true) signals.push(signal("networkRequested", "high", "capability", "network access was requested"));
  if (caps.externalSideEffects === true) signals.push(signal("externalSideEffects", "critical", "capability", "the task has effects outside the repository"));
  if (writes && !request.verification.planProvided)
    signals.push(signal("verificationMissing", "medium", "verification", "a writing task has no deterministic verification plan"));
  if (request.verification.required && !request.verification.planProvided)
    signals.push(signal("requiredVerificationMissing", "high", "verification", "verification is required but no plan was provided"));

  const indicators = request.indicators ?? {};
  const flags: ReadonlyArray<readonly [keyof NonNullable<TaskRequest["indicators"]>, string, RiskLevel, string]> = [
    ["irreversible", "irreversibleOperation", "critical", "the operation cannot be undone"],
    ["destructiveGit", "destructiveGitOperation", "critical", "a destructive Git operation was requested"],
    ["dependencyChange", "dependencyChange", "high", "dependencies are to change"],
    ["schemaChange", "schemaChange", "high", "a schema or data migration is involved"],
    ["architectureChange", "architectureChange", "high", "the change is architecture-wide"],
    ["ambiguousArchitecture", "ambiguousArchitecture", "high", "the architecture decision is ambiguous"],
    ["ambiguousCapabilityEnforcement", "ambiguousCapabilityEnforcement", "high", "capability enforcement cannot be confirmed"],
  ];
  for (const [key, code, level, evidence] of flags) if (indicators[key] === true) signals.push(signal(code, level, "task", evidence));

  const pathClasses: Partial<Record<PathClass, string[]>> = {};
  for (const path of paths) for (const cls of classifyPath(path)) (pathClasses[cls] ??= []).push(path);
  for (const [cls, list] of Object.entries(pathClasses) as Array<[PathClass, string[]]>) {
    const code = cls === "dependencyManifest" ? "dependencyChange" : cls === "migrationOrSchema" ? "schemaChange" : `${cls}Path`;
    // Reading credential material exposes it to whichever provider reads it, even without writes.
    const level: RiskLevel = writes ? PATH_CLASS_LEVEL[cls] : READ_CLASS_LEVEL[cls] ?? "medium";
    signals.push(signal(code, level, "scope", `${list.length} ${cls} path(s) in scope`));
  }

  const text = scanRiskText([request.summary], "task");
  signals.push(...text.signals);
  const destructivePhrases = [...text.codes];
  return Object.freeze({ operation: request.operation, writes, scope, paths: Object.freeze(paths),
    pathClasses: Object.freeze(Object.fromEntries(Object.entries(pathClasses).map(([k, v]) => [k, Object.freeze([...v])]))),
    destructivePhrases: Object.freeze(destructivePhrases.sort()), risk: assessRisk(signals) });
}

/**
 * Workspace paths a verification plan names explicitly: every relative, path-like argument (or `--flag=value`
 * value), resolved against its step's cwd. A glob contributes its directory prefix. Flags, URLs, script text
 * containing whitespace and escaping paths are ignored.
 */
export function verificationPlanReferences(commands: ReadonlyArray<Readonly<{ args: readonly string[]; cwd: string }>>): string[] {
  const references = new Set<string>();
  for (const command of commands) for (const arg of command.args) {
    let value = arg;
    if (arg.startsWith("-")) { const eq = arg.indexOf("="); if (eq < 0) continue; value = arg.slice(eq + 1); }
    if (value.length === 0 || /\s|:\/\/|^\$|^[a-z]:/iu.test(value)) continue;
    const glob = value.search(/[*?[{]/u);
    if (glob >= 0) { value = value.slice(0, glob); value = value.slice(0, value.lastIndexOf("/") + 1); }
    const { path, escapes } = normalizePath(`${command.cwd}/${value}`);
    if (!escapes && path.length > 0) references.add(path.toLowerCase());
  }
  return [...references].sort();
}

/** A writer changing a file the verifier explicitly runs or reads can steer its own verification. */
export function verificationReferenceSignals(taskPaths: readonly string[], references: readonly string[]): RiskSignal[] {
  const hits = taskPaths.map(scopeKey).filter(path => references.some(ref => path === ref || path.startsWith(`${ref}/`)));
  return hits.length === 0 ? [] : [signal("verificationReferencedPath", "medium", "verification",
    `${hits.length} task path(s) are named by the verification plan`)];
}

/** A verifier failure is evidence the change is riskier than planned; it can only raise the level. */
export function verificationFailureSignal(commandId: string): RiskSignal {
  return signal("verificationFailed", "high", "verification", `Fusion verification ${commandId} did not pass`);
}

/** Paths changed outside the delegated scope; a sensitive unexpected path is critical. */
export function unexpectedScopeSignals(allowedPaths: readonly string[], changedPaths: readonly string[]): RiskSignal[] {
  const allowed = new Set(allowedPaths.map(scopeKey));
  const unexpected = [...new Set(changedPaths.map(path => normalizePath(path).path))]
    .filter(path => path && !allowed.has(path.toLowerCase())).sort();
  if (unexpected.length === 0) return [];
  const sensitive = unexpected.filter(path => classifyPath(path).length > 0);
  return [signal("unexpectedScope", sensitive.length > 0 ? "critical" : "high", "diff",
    `${unexpected.length} changed path(s) outside the delegated scope${sensitive.length ? `, ${sensitive.length} sensitive` : ""}`)];
}
