/** Canonical diagnostic redaction used at persistence and presentation boundaries. */
const REDACTED = "[REDACTED]";
const MAX_REDACT_DEPTH = 64;
const SENSITIVE_KEY = /api.?key|access.?key|secret|password|passwd|passphrase|private.?key|token|credential|authorization|cookie|email|org(?:anization)?.?id|account.?id/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ORG_ID = /\borg[_-][A-Za-z0-9_-]+\b/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
/** Header credentials of any scheme, e.g. `Authorization: Basic <b64>`; the scheme word alone is not the secret. */
const AUTH_HEADER = /\b((?:proxy-)?authorization["']?\s*[:=]\s*["']?)(?:(?:basic|bearer|token|digest|negotiate|ntlm|aws4-hmac-sha256)\s+)?[^\s,;"'`]+/gi;
/** Cookie headers carry session credentials for their whole value. */
const COOKIE_HEADER = /\b((?:set-)?cookie\s*:\s*)[^\r\n]*/gi;
/** `scheme://user:password@host` — the userinfo segment is removed regardless of host shape. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi;
const TOKEN_ASSIGNMENT = /\b((?:api[_-]?key|access[_-]?token|oauth[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|client[_-]?secret|token|secret|password|passwd|authorization)["']?\s*[:=]\s*["']?)([^\s&#"'`]+)/gi;
/** Widely used credential formats that are recognizable without knowing their value in advance. */
const CREDENTIAL_SHAPES: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

export class DiagnosticRedactor {
  readonly #knownSecrets: readonly string[];

  constructor(secretValues: Iterable<string> = []) {
    this.#knownSecrets = [...secretValues].filter((value) => value.length > 0).sort((a, b) => b.length - a.length);
  }

  static fromEnvironment(env: NodeJS.ProcessEnv): DiagnosticRedactor {
    return new DiagnosticRedactor(Object.entries(env)
      .filter(([key, value]) => value !== undefined && (SENSITIVE_KEY.test(key) || /PROXY$/i.test(key)))
      .map(([, value]) => value as string));
  }

  redactText(input: string): string {
    let result = input;
    for (const secret of this.#knownSecrets) result = result.split(secret).join(REDACTED);
    for (const shape of CREDENTIAL_SHAPES) result = result.replace(shape, REDACTED);
    return result
      .replace(URL_USERINFO, (_match, scheme: string) => `${scheme}${REDACTED}@`)
      .replace(BEARER, `Bearer ${REDACTED}`)
      .replace(AUTH_HEADER, (_match, prefix: string) => `${prefix}${REDACTED}`)
      .replace(COOKIE_HEADER, (_match, prefix: string) => `${prefix}${REDACTED}`)
      .replace(TOKEN_ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`)
      .replace(EMAIL, REDACTED).replace(ORG_ID, REDACTED);
  }

  /** Nested values are redacted with a depth bound; cycles and excessive nesting are replaced, never copied. */
  redact(value: unknown): unknown {
    return this.#redact(value, 0, new WeakSet<object>());
  }

  #redact(value: unknown, depth: number, seen: WeakSet<object>): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (value === null || typeof value !== "object") return value;
    if (depth >= MAX_REDACT_DEPTH) return "[REDACTED_DEPTH]";
    if (seen.has(value)) return "[REDACTED_CYCLE]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return value.map((item) => this.#redact(item, depth + 1, seen));
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        output[key] = SENSITIVE_KEY.test(key) ? REDACTED : this.#redact(entry, depth + 1, seen);
      }
      return output;
    } finally {
      seen.delete(value);
    }
  }
}
