import type { FusionError } from "../../core/domain.js";

export type ProviderDiagnostic = NonNullable<FusionError["providerDiagnostic"]>;
export interface SafeTerminalFailure {
  readonly diagnostic: ProviderDiagnostic;
  readonly safeMessage: string;
}

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
  return { diagnostic, safeMessage: classification === "providerFailure" ? "Muse Exec reported a failed turn." :
    `Muse Exec reported a failed turn (${detail[classification]}).` };
}
