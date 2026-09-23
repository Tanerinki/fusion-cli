/** Narrow diagnostic redaction used at M6 persistence boundaries. */
const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /api.?key|access.?key|secret|password|token|credential|authorization|cookie|email|org(?:anization)?.?id|account.?id/i;
const EMAIL = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const ORG_ID = /\borg[_-][A-Za-z0-9_-]+\b/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const TOKEN_ASSIGNMENT = /\b((?:api[_-]?key|access[_-]?token|oauth[_-]?token|refresh[_-]?token|token|secret|authorization)\s*[:=]\s*)([^\s&#"'`]+)/gi;

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
    return result.replace(BEARER, `Bearer ${REDACTED}`)
      .replace(TOKEN_ASSIGNMENT, (_match, prefix: string) => `${prefix}${REDACTED}`)
      .replace(EMAIL, REDACTED).replace(ORG_ID, REDACTED);
  }

  redact(value: unknown): unknown {
    if (typeof value === "string") return this.redactText(value);
    if (Array.isArray(value)) return value.map((item) => this.redact(item));
    if (value !== null && typeof value === "object") {
      const output: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        output[key] = SENSITIVE_KEY.test(key) ? REDACTED : this.redact(entry);
      }
      return output;
    }
    return value;
  }
}
