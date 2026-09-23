import { failWith } from "../errors.js";
import { assessRisk, type RiskAssessment, type RiskLevel, type RiskSignal } from "./risk.js";

/** Provider-neutral description of requested work. No model output is ever an input here. */
export type TaskOperation = "read" | "analyze" | "review" | "test" | "edit" | "implement" | "refactor" | "configure" |
  "delete" | "migrate" | "release";
export type MutationScope = "none" | "singleFile" | "multiFile" | "broad" | "unknown";
export interface TaskRequest {
  readonly operation: TaskOperation;
  /** Human request text; scanned only by fixed patterns that can raise, never lower, risk. */
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
  "dependencyManifest" | "migrationOrSchema";
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
const MAX_SUMMARY_CHARS = 16_384;
/** Beyond this many files a declared multi-file change is treated as broad. */
export const BROAD_SCOPE_FILE_COUNT = 20;

const PATH_CLASS_LEVEL: Readonly<Record<PathClass, RiskLevel>> = {
  gitInternals: "critical", credentialMaterial: "critical", fusionStorage: "high", securitySensitive: "high",
  ciOrRelease: "high", dependencyManifest: "high", migrationOrSchema: "high",
};
const SENSITIVE_SEGMENT = /(?:^|[._-])(?:auth|authn|authz|authentication|authorization|authorize|oauth2?|openid|saml|sso|jwt|login|logout|session|sessions|permission|permissions|acl|rbac|abac|policy|policies|security|crypto|cryptography|encryption|secret|secrets|credential|credentials|token|tokens|password|passwords|billing|payment|payments|invoice|invoices|license|licensing|guard|guards|sandbox)(?:$|[._-])/u;
const CREDENTIAL_FILE = /^(?:\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|jks|keystore|crt|cer)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.npmrc|\.pypirc|\.netrc|\.git-credentials|credentials(?:\.json)?)$/u;
const DEPENDENCY_FILE = /^(?:package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|requirements(?:[-._].*)?\.txt|pyproject\.toml|poetry\.lock|pipfile(?:\.lock)?|setup\.py|setup\.cfg|cargo\.toml|cargo\.lock|go\.mod|go\.sum|gemfile(?:\.lock)?|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|.*\.csproj|packages\.config|directory\.packages\.props|composer\.(?:json|lock))$/u;
const CI_FILE = /^(?:\.gitlab-ci\.yml|azure-pipelines\.yml|jenkinsfile|codeowners|\.travis\.yml|dockerfile|release\.config\.[cm]?js)$/u;
const MIGRATION = /(?:^|\/)(?:migrations?|migrate|schema|schemas)(?:\/|$)|\.sql$|(?:^|\/)schema\.(?:prisma|graphql|sql)$/u;
/** Fixed high-impact phrases. Matching can only escalate; absence proves nothing. */
const DESTRUCTIVE_PHRASES: ReadonlyArray<readonly [string, RegExp, RiskLevel]> = [
  ["forcePush", /\bforce[- ]?push|push\s+(?:-f\b|--force)/u, "critical"],
  ["hardReset", /reset\s+--hard/u, "critical"],
  ["gitClean", /\bgit\s+clean\s+-[a-z]*f/u, "critical"],
  ["historyRewrite", /rewrite\s+(?:the\s+)?history|filter-(?:branch|repo)|\brebase\s+(?:-i\b|--interactive|onto)/u, "critical"],
  ["recursiveDelete", /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\brmdir\s+\/s|remove-item\b.*-recurse/u, "critical"],
  ["dataDestruction", /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b|\bwipe\b|\bpurge\b/u, "critical"],
  ["production", /\b(?:deploy|publish|release)\b.*\b(?:prod|production|registry|live)\b|\bnpm\s+publish\b/u, "critical"],
  ["credentialHandling", /\b(?:rotate|revoke|leak|exfiltrate|print|dump)\b.*\b(?:secret|token|credential|password|api\s*key)s?\b/u, "high"],
];

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
  return [...classes].sort();
}

const signal = (code: string, level: RiskLevel, source: RiskSignal["source"], evidence: string): RiskSignal =>
  ({ code, level, source, evidence });

function validate(request: TaskRequest): void {
  if (request === null || typeof request !== "object") failWith("InvalidInput", "Task request must be an object.");
  if (!OPERATIONS.has(request.operation)) failWith("InvalidInput", "Unknown task operation.");
  if (typeof request.summary !== "string") failWith("InvalidInput", "Task summary must be a string.");
  if (!Array.isArray(request.paths) || request.paths.length > MAX_PATHS ||
      !request.paths.every(path => typeof path === "string" && path.length > 0 && path.length <= 1024 && !path.includes("\0")))
    failWith("InvalidInput", "Task paths must be a bounded list of non-empty repository paths.");
  if (typeof request.scopeKnown !== "boolean" || !SCOPES.has(request.expectedMutation))
    failWith("InvalidInput", "Task scope must be declared.");
  if (request.requestedCapabilities === null || typeof request.requestedCapabilities !== "object" ||
      request.verification === null || typeof request.verification !== "object" ||
      typeof request.verification.required !== "boolean" || typeof request.verification.planProvided !== "boolean")
    failWith("InvalidInput", "Task capabilities and verification requirements must be declared.");
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
    const level: RiskLevel = writes ? PATH_CLASS_LEVEL[cls] : cls === "credentialMaterial" ? "high" : "medium";
    signals.push(signal(code, level, "scope", `${list.length} ${cls} path(s) in scope`));
  }

  const summary = request.summary.slice(0, MAX_SUMMARY_CHARS).toLowerCase();
  const destructivePhrases: string[] = [];
  for (const [code, pattern, level] of DESTRUCTIVE_PHRASES) {
    if (pattern.test(summary)) { destructivePhrases.push(code); signals.push(signal(`${code}Requested`, level, "task", `request text mentions ${code}`)); }
  }
  return Object.freeze({ operation: request.operation, writes, scope, paths: Object.freeze(paths),
    pathClasses: Object.freeze(Object.fromEntries(Object.entries(pathClasses).map(([k, v]) => [k, Object.freeze([...v])]))),
    destructivePhrases: Object.freeze(destructivePhrases.sort()), risk: assessRisk(signals) });
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
