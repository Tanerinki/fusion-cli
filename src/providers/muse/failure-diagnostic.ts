import type { FusionError, TurnFailureCategory } from "../../core/domain.js";

export type ProviderDiagnostic = NonNullable<FusionError["providerDiagnostic"]>;
/**
 * v0.3: Fusion's own label for WHY Muse ended a turn as failed, read from its reason in memory (the reason itself is never
 * kept): an HTTP status class, the step limit, an oversized input, a rate limit, the network, a timeout or cancellation;
 * `unclassified` when the reason matches none of them, `absent` when there is none.
 */
export type MuseReasonClass = "absent" | "http400" | "http401" | "http403" | "http413" | "http429" | "http5xx" | "httpOther" |
  "stepLimit" | "contextOverflow" | "rateLimit" | "network" | "timeout" | "cancelled" | "unclassified";
export interface SafeTerminalFailure {
  readonly diagnostic: ProviderDiagnostic;
  readonly safeMessage: string;
  readonly reasonClass: MuseReasonClass;
  /** The reason's length in characters (a number, never its text). */
  readonly reasonChars: number;
  /** The provider-neutral category of the classes that have one (see `FusionError.failureCategory`). */
  readonly category?: TurnFailureCategory;
}
const STEP_LIMIT = /\b(?:max(?:imum)?[\s_-]*(?:number[\s_-]*of[\s_-]*)?(?:model[\s_-]*)?steps?|max_model_steps|step[\s_-]*(?:limit|budget|cap)|too many (?:model )?steps|steps? (?:exhausted|exceeded|reached))\b/iu;
const CONTEXT_OVERFLOW = /\b(?:context[\s_-]*(?:length|window|limit|size|overflow)|too many (?:input )?tokens|token[\s_-]*limit|maximum context|(?:prompt|input|request|message)s? (?:is |was )?too (?:long|large))\b/iu;
const RATE_LIMIT = /\b(?:rate[\s_-]*limit(?:ed)?|quota|too many requests|usage limit)\b/iu;
const NETWORK = /\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPIPE|socket hang up|network (?:error|failure|unreachable)|connection (?:reset|refused|closed|error|lost))\b/iu;
function reasonClassOf(reason: unknown, prefix: string): MuseReasonClass {
  if (typeof reason !== "string" || reason.trim().length === 0) return "absent";
  const status = /\bHTTP\s+(\d{3})\b/iu.exec(prefix)?.[1];
  if (status !== undefined) {
    if (status === "413" || CONTEXT_OVERFLOW.test(prefix)) return status === "413" ? "http413" : "contextOverflow";
    if (status === "400" || status === "401" || status === "403" || status === "429") return `http${status}` as MuseReasonClass;
    return status.startsWith("5") ? "http5xx" : "httpOther";
  }
  if (STEP_LIMIT.test(prefix)) return "stepLimit";
  if (CONTEXT_OVERFLOW.test(prefix)) return "contextOverflow";
  if (RATE_LIMIT.test(prefix)) return "rateLimit";
  if (NETWORK.test(prefix)) return "network";
  if (/^(?:(?:provider|request|run)\s+)?(?:timed?\s*out|timeout)\b/iu.test(prefix)) return "timeout";
  if (/^(?:(?:provider|request|run)\s+)?cancell?ed\b/iu.test(prefix)) return "cancelled";
  return "unclassified";
}
const CATEGORY: Partial<Record<MuseReasonClass, TurnFailureCategory>> = { stepLimit: "turnLimit", contextOverflow: "inputTooLarge",
  http413: "inputTooLarge", http429: "rateLimited", rateLimit: "rateLimited", http5xx: "providerApiError", network: "providerApiError" };

/** The raw reason is inspected in memory only. No provider-supplied substring enters the result. */
export function classifyMuseTerminalFailure(reason: unknown, configuredProvider: string): SafeTerminalFailure {
  const prefix = typeof reason === "string" ? reason.slice(0, 512) : "";
  const httpMatch = /\bHTTP\s+(400|401|403|429|5\d\d)\b/iu.exec(prefix);
  const httpStatus = httpMatch === null ? undefined : Number(httpMatch[1]);
  let classification: ProviderDiagnostic["classification"] = "providerFailure";
  if (httpStatus === 400 && /\b(schema|structured|strict|required|additionalProperties|properties)\b/iu.test(prefix))
    classification = "schemaRejected";
  else if (httpStatus === 401 || httpStatus === 403) classification = "authorizationRejected";
  else if (httpStatus === 429) classification = "rateLimited";
  else if (httpStatus !== undefined && httpStatus >= 500) classification = "providerUnavailable";
  else if (/^(?:(?:provider|request|run)\s+)?(?:timed?\s*out|timeout)\b/iu.test(prefix)) classification = "timeout";
  else if (/^(?:(?:provider|request|run)\s+)?cancell?ed\b/iu.test(prefix)) classification = "cancelled";
  const diagnostic: ProviderDiagnostic = {
    provider: configuredProvider === "meta" ? "meta" : "unknown",
    transport: "muse-exec", classification,
    ...(httpStatus === undefined ? {} : { httpStatus }),
  };
  const detail: Record<ProviderDiagnostic["classification"], string> = {
    schemaRejected: "provider HTTP 400: output schema rejected",
    authorizationRejected: `provider HTTP ${httpStatus}: authorization rejected`,
    rateLimited: "provider HTTP 429: rate limited",
    providerUnavailable: `provider HTTP ${httpStatus}: unavailable`,
    timeout: "provider timeout", cancelled: "provider cancellation", providerFailure: "provider failure",
  };
  const reasonClass = reasonClassOf(reason, prefix);
  const category = CATEGORY[reasonClass];
  return { diagnostic, safeMessage: classification === "providerFailure" ? "Muse Exec reported a failed turn." :
    `Muse Exec reported a failed turn (${detail[classification]}).`, reasonClass,
    reasonChars: typeof reason === "string" ? Math.min(reason.length, 1_000_000) : 0, ...(category === undefined ? {} : { category }) };
}
