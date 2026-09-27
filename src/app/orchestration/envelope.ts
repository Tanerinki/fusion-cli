import { readStructuredEnvelope } from "../../platform/process/structured-envelope.js";

/**
 * v0.3 — how Fusion reads a reply that must be ONE JSON object (a routing decision, an investigation report): raw, or inside
 * exactly one outer json/bare fence with only whitespace around it (the envelope of the Writer route's plan; prose is never
 * cut away). A refusal names a structural category only, never any of the reply's text.
 */
export type EnvelopeRejection = "empty reply" | "oversized reply" | "invalid JSON" | "prose around the JSON" | "more than one JSON value or fence" |
  "malformed fence" | "schema mismatch";
const ENVELOPE_REJECTION: Readonly<Record<string, EnvelopeRejection>> = Object.freeze({ EMPTY: "empty reply", OVERSIZED: "oversized reply",
  RAW_INVALID_JSON: "invalid JSON", SINGLE_FENCED_INVALID_JSON: "invalid JSON", OTHER_MALFORMED: "invalid JSON", EXTRA_TEXT: "prose around the JSON",
  MULTIPLE_FENCES: "more than one JSON value or fence", MULTIPLE_VALUES: "more than one JSON value or fence", UNCLOSED_FENCE: "malformed fence",
  UNSUPPORTED_FENCE: "malformed fence", INVALID_SCHEMA: "schema mismatch" });

export type JsonReply = Readonly<{ accepted: true; value: unknown }> | Readonly<{ accepted: false; category: EnvelopeRejection }>;
export function readJsonReply(reply: string): JsonReply {
  const reading = readStructuredEnvelope(reply, { policy: "rawOrSingleJsonFence" });
  if (reading.accepted) return Object.freeze({ accepted: true, value: reading.value });
  const classification = reading.diagnostic.classification, trimmed = reply.trim();
  // Unfenced prose before or after an object reads as invalid raw JSON; a structural look (never kept) names it better.
  if ((classification === "RAW_INVALID_JSON" || classification === "OTHER_MALFORMED") && !trimmed.startsWith("{") && trimmed.includes("{"))
    return Object.freeze({ accepted: false, category: "prose around the JSON" });
  return Object.freeze({ accepted: false, category: ENVELOPE_REJECTION[classification] ?? "invalid JSON" });
}
