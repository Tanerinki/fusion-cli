import { basename } from "node:path";

/**
 * v0.2 — WHAT A PROVIDER MAY READ. A host-controlled policy applied to every file Fusion copies into a provider's view for a
 * conversation or an analysis, before the view's identity is taken: the provider never receives more than this decides.
 *
 *   - excluded   never copied: credentials and key material, authentication stores (Home Assistant `.storage/`, `.ssh/`,
 *                cloud CLI state), databases, binaries and oversized files. Their existence may be reported, never their bytes.
 *   - redacted   copied with every secret value replaced: `secrets.yaml` and `.env` files keep their key NAMES only (so a model
 *                can still see which secrets exist and are referenced), and any other text file keeps its content with each
 *                high-confidence secret (tokens, API keys, JWTs, private-key blocks, URL passwords, password assignments)
 *                replaced by a marker.
 *   - included   copied unchanged.
 *
 * The patterns are deliberately conservative: a false positive costs a marker, a false negative leaks a value. This is one
 * layer; the view boundary, the read-only provider posture and the evidence redactor remain in force.
 */
export type ProviderInputStatus = "included" | "redacted" | "excluded";
export interface ProviderInputDecision {
  readonly status: ProviderInputStatus;
  /** The bytes a provider may read (absent when excluded). */
  readonly content?: Buffer;
  /** Why a file was excluded or redacted, in plain words. */
  readonly reason?: string;
  /** How many values were replaced (redacted files). */
  readonly redactions?: number;
}
export interface SensitivePathClass {
  readonly treatment: "exclude" | "keysOnly";
  readonly reason: string;
}

export const PROVIDER_INPUT_LIMITS = Object.freeze({ maxTextBytes: 1024 * 1024, binaryProbeBytes: 8000 });

/** Directories whose whole content is authentication or machine-local state. */
const SENSITIVE_DIRECTORIES: ReadonlyMap<string, string> = new Map([
  [".storage", "authentication and integration store"], [".ssh", "SSH keys"], [".gnupg", "GPG keys"], [".aws", "cloud credentials"],
  [".azure", "cloud credentials"], [".kube", "cluster credentials"], [".docker", "registry credentials"], [".cloud", "cloud account data"],
]);
const EXCLUDED_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\.(pem|key|p12|pfx|jks|keystore|kdbx|ppk|gpg|asc)$/iu, "key material"],
  [/^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/iu, "SSH key"],
  [/^\.(netrc|npmrc|pypirc|htpasswd|pgpass|git-credentials)$/iu, "stored credentials"],
  [/^credentials?$|credential[\w.-]*\.(json|ya?ml|ini|txt|xml|cfg|conf|toml|csv)$/iu, "stored credentials"],
  [/^(service[-_]?account|tokens?|auth|authorization)[\w.-]*\.(json|ya?ml|txt|ini)$/iu, "tokens"],
  [/^secrets?[\w.-]*\.(json|ini|toml|txt)$/iu, "secrets"],
  [/^ip_bans\.ya?ml$/iu, "personal network data"],
  [/\.(db|db3|sqlite|sqlite3)(-wal|-shm|-journal)?$/iu, "database"],
];
const KEYS_ONLY_NAMES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^secrets?[\w.-]*\.ya?ml$/iu, "secret values"],
  [/^\.env$/iu, "environment secrets"],
  [/^\.env\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+$/iu, "environment secrets"],
];

/** The path-based part of the policy (used by the inventory too; no file content needed). */
export function classifySensitivePath(relPath: string): SensitivePathClass | undefined {
  const segments = relPath.split("/");
  for (const segment of segments.slice(0, -1)) {
    const reason = SENSITIVE_DIRECTORIES.get(segment.toLowerCase());
    if (reason !== undefined) return { treatment: "exclude", reason };
  }
  const name = basename(relPath);
  for (const [pattern, reason] of KEYS_ONLY_NAMES) if (pattern.test(name)) return { treatment: "keysOnly", reason };
  for (const [pattern, reason] of EXCLUDED_NAMES) if (pattern.test(name)) return { treatment: "exclude", reason };
  return undefined;
}

/** High-confidence secret shapes inside ordinary text; each match (or its captured value) is replaced by a marker. */
const SECRET_PATTERNS: ReadonlyArray<readonly [string, RegExp]> = [
  ["github-token", /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36}\b|\bgithub_pat_[A-Za-z0-9_]{40,}/gu],
  ["api-key", /\bsk-ant-[A-Za-z0-9_-]{16,}|\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}|\b[sr]k_live_[A-Za-z0-9]{16,}|\bAIza[0-9A-Za-z_-]{35}\b/gu],
  ["aws-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu],
  ["slack-token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gu],
  ["bearer-token", /(?<=\b[Bb]earer\s+)[A-Za-z0-9._~+/=-]{20,}/gu],
  ["url-password", /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@'"]{1,64}:)[^\s/@'"]{1,128}(?=@)/gu],
  // A secret-named key assigned a quoted literal (any file, source code included).
  ["password", /(?<=\b(?:password|passwd|pwd|passphrase|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|token)\b["']?\s*[:=]\s*["'])(?![!$<{%])[^\s"']{6,}(?=["'])/giu],
];
/** In configuration files a secret-named key's plain value counts too (`password: hunter22`), unless it is a reference. */
const CONFIG_ASSIGNMENT: readonly [string, RegExp] = ["password",
  /(?<=^\s*["']?(?:[\w.-]*[_-])?(?:password|passwd|pwd|passphrase|api[_-]?key|apikey|access[_-]?token|auth[_-]?token|client[_-]?secret|secret[_-]?key|token)["']?\s*[:=]\s*)(?![!$<{%"'])[^\s"',;}#]{6,}/gimu];
const CONFIG_FILE = /\.(ya?ml|json|ini|toml|conf|cfg|properties|env|xml|txt)$|^\.env/iu;
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u;

export interface RedactedText {
  readonly text: string;
  readonly redactions: number;
  /** v0.2.1: the replaced values in marker order (marker N stands for `values[N - 1]`). Host-side only; never shown. */
  readonly values: readonly Readonly<{ kind: string; value: string }>[];
}
/**
 * `text` with every high-confidence secret replaced by `<redacted:kind>` (v0.2.1, `numbered`: `<redacted:kind:N>`, so
 * Fusion can put exactly that value back when a proposal keeps the marker), and how many were replaced. `config` also
 * masks a secret-named key's plain value, as configuration files write them.
 */
export function redactSecrets(text: string, config = false, numbered = false): RedactedText {
  const values: Array<{ kind: string; value: string }> = [];
  let out = text;
  for (const [kind, pattern] of config ? [...SECRET_PATTERNS, CONFIG_ASSIGNMENT] : SECRET_PATTERNS)
    out = out.replace(pattern, value => { values.push({ kind, value }); return numbered ? `<redacted:${kind}:${values.length}>` : `<redacted:${kind}>`; });
  return { text: out, redactions: values.length, values };
}

/** A YAML file reduced to its key names: every value, list item, scalar and comment is removed. */
export function keysOnlyYaml(text: string): string {
  const lines = ["# Fusion: values redacted; only the key names of this file are shared."];
  for (const line of text.split(/\r?\n/u)) {
    if (line.trim().length === 0 || line.trimStart().startsWith("#")) continue;
    const key = /^(\s*)(-\s+)?([A-Za-z0-9_.-]{1,120})\s*:(\s|$)/u.exec(line);
    lines.push(key ? `${key[1]}${key[2] ?? ""}${key[3]}: <redacted>` : `${/^\s*/u.exec(line)![0]}<redacted>`);
  }
  return `${lines.join("\n")}\n`;
}
/** An environment file reduced to its variable names. */
export function keysOnlyEnv(text: string): string {
  const lines = ["# Fusion: values redacted; only the variable names of this file are shared."];
  for (const line of text.split(/\r?\n/u)) {
    const name = /^\s*(export\s+)?([A-Za-z_][A-Za-z0-9_.-]{0,120})\s*=/u.exec(line);
    if (name) lines.push(`${name[1] ?? ""}${name[2]}=<redacted>`);
  }
  return `${lines.join("\n")}\n`;
}

const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, PROVIDER_INPUT_LIMITS.binaryProbeBytes).includes(0);

/** The decision for one file (path relative to the source root, `/`-separated) and its bytes. */
export function prepareProviderInput(relPath: string, bytes: Buffer): ProviderInputDecision {
  const byPath = classifySensitivePath(relPath);
  if (byPath?.treatment === "exclude") return { status: "excluded", reason: byPath.reason };
  if (isBinary(bytes)) return { status: "excluded", reason: "binary file" };
  if (bytes.length > PROVIDER_INPUT_LIMITS.maxTextBytes) return { status: "excluded", reason: "too large to share" };
  const text = bytes.toString("utf8");
  if (PRIVATE_KEY_BLOCK.test(text)) return { status: "excluded", reason: "contains a private key" };
  if (byPath?.treatment === "keysOnly") {
    const reduced = /\.ya?ml$/iu.test(relPath) ? keysOnlyYaml(text) : keysOnlyEnv(text);
    // Key names are kept; a key name that is itself secret-shaped is still masked.
    const masked = redactSecrets(reduced);
    return { status: "redacted", content: Buffer.from(masked.text, "utf8"), reason: `${byPath.reason}: key names only`,
      redactions: (reduced.match(/<redacted>/gu) ?? []).length + masked.redactions };
  }
  const redacted = redactSecrets(text, CONFIG_FILE.test(basename(relPath)), true);
  if (redacted.redactions === 0) return { status: "included", content: bytes };
  return { status: "redacted", content: Buffer.from(redacted.text, "utf8"), reason: "secret values masked", redactions: redacted.redactions };
}

// ---------------------------------------------------------------- v0.2.1: the build (mutation) path

/**
 * v0.2.1 — the same policy on the BUILD path. A build's providers (Lead, Explorer, Change Author, Reviewer) read the same
 * filtered views as a conversation, so a task that turns into a change never exposes more than an analysis did:
 *
 *   - A file the policy withholds or reduces to key names (credentials, key material, `.storage/`, `secrets.yaml`, `.env`,
 *     private-key blocks, binaries, oversized files) is PROTECTED: it can never be part of a build's write scope. Fusion
 *     stops before any model turn and tells the human why (`buildScopeProtection`).
 *   - A normal file with secret VALUES inside (an inline password in `configuration.yaml`) stays editable: the Change
 *     Author sees numbered markers (`<redacted:password:1>`) and keeps them in its proposal; Fusion puts back exactly the
 *     value each marker stands for, host-side, before applying (`restoreProtectedContent`). A marker that does not belong
 *     to the file, a marker in a new file, or any marker Fusion cannot restore exactly refuses the proposal.
 *   - Every review diff masks secret values line by line (`redactUnifiedDiff`).
 */
export interface ScopeProtection {
  readonly reason: string;
  /** True when the file holds secret material (credentials, keys, secret values); false when it is only unreadable (binary, size). */
  readonly secret: boolean;
}
/** Why a file can never be written by a build (undefined: it may be). `bytes`: its current content, when it exists. */
export function buildScopeProtection(relPath: string, bytes?: Buffer): ScopeProtection | undefined {
  const byPath = classifySensitivePath(relPath);
  if (byPath !== undefined)
    return { reason: byPath.treatment === "keysOnly" ? `${byPath.reason}; AI models only ever see its key names` : byPath.reason, secret: true };
  if (bytes === undefined) return undefined;
  const decision = prepareProviderInput(relPath, bytes);
  if (decision.status !== "excluded") return undefined;
  return { reason: decision.reason ?? "withheld from AI models", secret: decision.reason === "contains a private key" };
}
/** What a provider's view shows of a file: the bytes after the input policy (undefined: withheld). */
export function providerFacingContent(relPath: string, bytes: Buffer): Buffer | undefined {
  const decision = prepareProviderInput(relPath, bytes);
  return decision.status === "excluded" ? undefined : decision.content;
}

const NUMBERED_MARKER = /<redacted:([a-z][a-z-]{0,39}):(\d{1,5})>/gu;
const ANY_MARKER = /<redacted[:>]/u;
export type Restoration = Readonly<{ status: "restored"; content: string; restored: number }> | Readonly<{ status: "refused"; reason: string }>;
/**
 * The host form of a proposed file content: `original` is the file as it is in the baseline (undefined: a new file).
 * Numbered markers are replaced by the exact values they stand for in that file; nothing else changes. Refused when the
 * file is protected, when a marker does not stand for a value of this file (or appears in a new file or in a file whose
 * view had no markers), or when any Fusion marker would be left in the content.
 */
export function restoreProtectedContent(relPath: string, original: Buffer | undefined, proposed: string): Restoration {
  const refused = (reason: string): Restoration => Object.freeze({ status: "refused", reason });
  const protection = buildScopeProtection(relPath, original);
  if (protection !== undefined) return refused(`${relPath} is protected (${protection.reason}); a build never writes it`);
  const markers = [...proposed.matchAll(NUMBERED_MARKER)].map(match => match[0]);
  if (original === undefined)
    return markers.length > 0 ? refused(`the new file ${relPath} contains a Fusion redaction marker`)
      : Object.freeze({ status: "restored", content: proposed, restored: 0 });
  const text = original.toString("utf8");
  const decision = prepareProviderInput(relPath, original);
  if (decision.status === "included") {
    // The provider saw this file as it is: a numbered marker can only be text the file already had.
    const foreign = markers.find(marker => !text.includes(marker));
    return foreign !== undefined ? refused(`${relPath} had no masked values, but the proposal contains a Fusion redaction marker`)
      : Object.freeze({ status: "restored", content: proposed, restored: 0 });
  }
  if (ANY_MARKER.test(text))
    return refused(`${relPath} already contains text that looks like a Fusion redaction marker, so its masked values cannot be restored unambiguously`);
  const { values } = redactSecrets(text, CONFIG_FILE.test(basename(relPath)), true);
  // Reasons name a marker by number and kind only: the marker text itself reads like a secret assignment to redactors.
  let foreign: string | undefined, restored = 0;
  const content = proposed.replace(NUMBERED_MARKER, (marker, kind: string, n: string) => {
    const value = values[Number(n) - 1];
    if (value === undefined || value.kind !== kind) { foreign ??= `number ${Number(n)} (${kind})`; return marker; }
    restored++;
    return value.value;
  });
  if (foreign !== undefined) return refused(`the proposal for ${relPath} uses redaction marker ${foreign}, which does not stand for a value of this file`);
  if (ANY_MARKER.test(content)) return refused(`the proposal for ${relPath} contains a redaction marker Fusion cannot restore`);
  return Object.freeze({ status: "restored", content, restored });
}

const DIFF_FILE = /^diff --git a\/.* b\/(.+)$/u;
const KEY_LINE = /^(\s*)(-\s+)?([A-Za-z0-9_.-]{1,120})\s*[:=]/u;
const PRIVATE_KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/u;
/**
 * A unified diff with every secret value masked, line by line: a protected file's lines keep at most their key names, a
 * private-key block is masked whole, and every other line passes `redactSecrets` (with configuration assignments for
 * configuration files). Headers and hunk markers are kept, so the diff stays readable.
 */
export function redactUnifiedDiff(text: string): Readonly<{ text: string; redactions: number }> {
  let file = "", inKey = false, redactions = 0;
  const out: string[] = [];
  for (const line of text.split("\n")) {
    const header = DIFF_FILE.exec(line);
    if (header !== null) { file = header[1]!; inKey = false; out.push(line); continue; }
    const prefix = line[0];
    if ((prefix !== "+" && prefix !== "-" && prefix !== " ") || line.startsWith("+++ ") || line.startsWith("--- ")) { out.push(line); continue; }
    const body = line.slice(1);
    const sensitive = classifySensitivePath(file);
    if (sensitive !== undefined) {
      const key = sensitive.treatment === "keysOnly" ? KEY_LINE.exec(body) : null;
      out.push(`${prefix}${key ? `${key[1]}${key[2] ?? ""}${key[3]}: <redacted>` : "<redacted>"}`);
      if (body.trim().length > 0) redactions++;
      continue;
    }
    if (inKey || PRIVATE_KEY_BLOCK.test(body)) {
      out.push(`${prefix}<redacted:private-key>`);
      redactions++;
      inKey = !PRIVATE_KEY_END.test(body);
      continue;
    }
    const masked = redactSecrets(body, CONFIG_FILE.test(basename(file)));
    redactions += masked.redactions;
    out.push(`${prefix}${masked.text}`);
  }
  return { text: out.join("\n"), redactions };
}
