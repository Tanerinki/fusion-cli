/**
 * Which operating-system semantics a task's verification must demonstrate — explicit, inspectable product data with a
 * conservative default. This is NOT universal platform classification: the requirement is DECLARED by the host (the
 * project configuration or the human), deterministic signals may only ESCALATE it, and a model suggestion may only
 * escalate it too. Nothing — least of all model text — can lower it. A missing or invalid declaration is `unknown`,
 * which no confined backend accepts, so autonomous Writer verification fails closed.
 *
 * Escalation order (strictest wins): platform-neutral < linux-compatible < windows-required < unknown.
 */
export const PLATFORM_REQUIREMENTS = Object.freeze(["platform-neutral", "linux-compatible", "windows-required", "unknown"] as const);
export type PlatformRequirement = typeof PLATFORM_REQUIREMENTS[number];
const STRICTNESS: Readonly<Record<PlatformRequirement, number>> = Object.freeze({
  "platform-neutral": 0, "linux-compatible": 1, "windows-required": 2, unknown: 3 });

export const isPlatformRequirement = (value: unknown): value is PlatformRequirement =>
  (PLATFORM_REQUIREMENTS as readonly unknown[]).includes(value);
const stricter = (a: PlatformRequirement, b: PlatformRequirement): PlatformRequirement => STRICTNESS[b] > STRICTNESS[a] ? b : a;

export interface PlatformSignal {
  /** Stable signal code, e.g. `powershellScript`. */
  readonly code: string;
  readonly requirement: "windows-required";
  /** Bounded, path-or-name evidence (a repository path or package name); never file content. */
  readonly evidence: string;
}

/** File kinds whose presence means the project's behavior involves Windows-only tooling. */
const WINDOWS_FILE_SIGNALS: readonly (readonly [RegExp, string])[] = [
  [/\.(?:ps1|psm1|psd1)$/iu, "powershellScript"],
  [/\.(?:bat|cmd)$/iu, "windowsBatchScript"],
  [/\.(?:vbs|wsf|wsh)$/iu, "windowsScriptHost"],
  [/\.reg$/iu, "registryFile"],
  [/\.vcxproj$/iu, "msbuildNativeProject"],
  [/\.(?:exe|dll|msi|sys)$/iu, "windowsBinary"],
];
/** npm packages that only work on Windows (registry, services, COM, PowerShell, Windows process APIs). */
export const WINDOWS_ONLY_PACKAGES = Object.freeze(["winreg", "regedit", "native-reg", "registry-js", "windows-registry",
  "@vscode/windows-registry", "node-windows", "winax", "edge-js", "electron-edge-js", "node-powershell",
  "windows-process-tree", "@vscode/windows-process-tree", "win32-api", "win-ca", "windows-foreground-love",
  "node-windows-service", "@primno/dpapi", "wmi-client", "node-wmi"]);
/** Source patterns for Win32/registry/ACL/service/COM/PowerShell behavior. Escalation only; false positives fail closed. */
const WINDOWS_CONTENT_SIGNALS: readonly (readonly [RegExp, string])[] = [
  [/\bHKEY_(?:LOCAL_MACHINE|CURRENT_USER|CLASSES_ROOT|USERS|CURRENT_CONFIG)\b|\bHK(?:LM|CU):/u, "registryAccess"],
  [/\b(?:powershell|pwsh)(?:\.exe)?\b/iu, "powershellInvocation"],
  [/\b(?:icacls|cacls|takeown)(?:\.exe)?\b|\b(?:Get|Set)-Acl\b/iu, "ntfsAclSemantics"],
  [/\bsc(?:\.exe)?\s+(?:create|start|stop|config|delete)\b|\bNew-Service\b|\bCreateService[AW]?\b|\bwindows-service\b/iu, "windowsService"],
  [/\bnew\s+ActiveXObject\b|\bCoCreateInstance\b|\bwinax\b/u, "comAutomation"],
  [/\b(?:cmd|wmic|reg|sc|schtasks|netsh|mklink|icacls|robocopy|bcdedit)\.exe\b/iu, "windowsOnlyBinary"],
  [/\bkernel32(?:\.dll)?\b|\badvapi32(?:\.dll)?\b|\buser32(?:\.dll)?\b/iu, "win32Api"],
];
export const PLATFORM_SIGNAL_LIMITS = Object.freeze({ maxPaths: 100_000, maxFiles: 2_000, maxFileChars: 512 * 1024, maxSignals: 64 });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const boundedEvidence = (text: string): string => text.replace(/[\u0000-\u001f\u007f-\u009f]/gu, "?").slice(0, 200);

export interface PlatformSignalInput {
  /** Repository-relative paths (e.g. tracked files, or a ChangeSet's changed paths). */
  readonly paths?: readonly string[];
  /** The parsed root package.json, if any. */
  readonly packageJson?: unknown;
  /** Bounded text of selected files (e.g. a candidate's changed files). */
  readonly files?: readonly Readonly<{ path: string; text: string }>[];
}

/** Deterministic Windows-requirement signals from paths, the package manifest and optional file text. */
export function detectPlatformSignals(input: PlatformSignalInput): PlatformSignal[] {
  const signals: PlatformSignal[] = [];
  const seen = new Set<string>();
  const add = (code: string, evidence: string): void => {
    const key = `${code}\0${evidence}`;
    if (seen.has(key) || signals.length >= PLATFORM_SIGNAL_LIMITS.maxSignals) return;
    seen.add(key);
    signals.push(Object.freeze({ code, requirement: "windows-required", evidence: boundedEvidence(evidence) }));
  };
  for (const path of (input.paths ?? []).slice(0, PLATFORM_SIGNAL_LIMITS.maxPaths)) {
    if (typeof path !== "string") continue;
    for (const [pattern, code] of WINDOWS_FILE_SIGNALS) if (pattern.test(path)) add(code, path);
  }
  const pkg = input.packageJson;
  if (isRecord(pkg)) {
    const os = pkg.os;
    if (Array.isArray(os) && os.some(entry => entry === "win32") && !os.some(entry => entry === "linux"))
      add("packageOsWin32Only", "package.json os");
    for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
      const specs = pkg[field];
      if (!isRecord(specs)) continue;
      for (const name of Object.keys(specs)) if (WINDOWS_ONLY_PACKAGES.includes(name)) add("windowsOnlyDependency", name);
    }
  }
  for (const file of (input.files ?? []).slice(0, PLATFORM_SIGNAL_LIMITS.maxFiles)) {
    if (typeof file?.text !== "string" || typeof file.path !== "string") continue;
    const text = file.text.slice(0, PLATFORM_SIGNAL_LIMITS.maxFileChars);
    for (const [pattern, code] of WINDOWS_CONTENT_SIGNALS) if (pattern.test(text)) add(code, file.path);
  }
  return signals;
}

export interface PlatformAssessment {
  /** What the host declared; `missing`/`invalid` are recorded as such and treated as `unknown`. */
  readonly declared: PlatformRequirement | "missing" | "invalid";
  readonly effective: PlatformRequirement;
  readonly signals: readonly PlatformSignal[];
  /** A model's suggestion and whether it changed anything (it can only escalate). */
  readonly modelSuggestion?: Readonly<{ value: string; applied: boolean }>;
  readonly reasons: readonly string[];
}

/**
 * Combines the host declaration, deterministic signals and an optional model suggestion. Deterministic and
 * order-independent; the result is never less strict than the declaration or any signal.
 */
export function assessPlatformRequirement(input: Readonly<{ declared?: unknown; signals?: readonly PlatformSignal[];
  modelSuggestion?: unknown }>): PlatformAssessment {
  const reasons: string[] = [];
  const declared: PlatformAssessment["declared"] = input.declared === undefined ? "missing"
    : isPlatformRequirement(input.declared) ? input.declared : "invalid";
  let effective: PlatformRequirement = declared === "missing" || declared === "invalid" ? "unknown" : declared;
  if (declared === "missing") reasons.push("no platform requirement was declared; it defaults to unknown (fail closed)");
  if (declared === "invalid") reasons.push("the declared platform requirement is not a known value; it is treated as unknown");
  const signals = Object.freeze([...(input.signals ?? [])]);
  for (const signal of signals) {
    const before = effective;
    effective = stricter(effective, signal.requirement);
    if (effective !== before) reasons.push(`escalated to ${effective} by deterministic signal ${signal.code} (${signal.evidence})`);
  }
  let modelSuggestion: PlatformAssessment["modelSuggestion"];
  if (input.modelSuggestion !== undefined) {
    const value = typeof input.modelSuggestion === "string" ? input.modelSuggestion.slice(0, 32) : "invalid";
    const valid = isPlatformRequirement(value);
    const applied = valid && STRICTNESS[value] > STRICTNESS[effective];
    if (applied) { effective = value; reasons.push(`escalated to ${value} by a model suggestion (escalation only)`); }
    else reasons.push(valid ? "a model suggestion was ignored: models cannot lower a platform requirement"
      : "an invalid model suggestion was ignored");
    modelSuggestion = Object.freeze({ value, applied });
  }
  return Object.freeze({ declared, effective, signals, ...(modelSuggestion ? { modelSuggestion } : {}), reasons: Object.freeze(reasons) });
}
