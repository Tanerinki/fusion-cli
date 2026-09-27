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

/**
 * `text` with every high-confidence secret replaced by `<redacted:kind>`, and how many were replaced. `config` also masks a
 * secret-named key's plain value, as configuration files write them.
 */
export function redactSecrets(text: string, config = false): Readonly<{ text: string; redactions: number }> {
  let redactions = 0, out = text;
  for (const [kind, pattern] of config ? [...SECRET_PATTERNS, CONFIG_ASSIGNMENT] : SECRET_PATTERNS)
    out = out.replace(pattern, () => { redactions++; return `<redacted:${kind}>`; });
  return { text: out, redactions };
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
  const redacted = redactSecrets(text, CONFIG_FILE.test(basename(relPath)));
  if (redacted.redactions === 0) return { status: "included", content: bytes };
  return { status: "redacted", content: Buffer.from(redacted.text, "utf8"), reason: "secret values masked", redactions: redacted.redactions };
}
