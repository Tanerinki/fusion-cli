import { parseStrictJson, StrictJsonError, type StrictJsonFailure } from "./strict-json.js";

/**
 * O5.5B10 — the ENVELOPE of one structured provider reply: how the whole reply text relates to the one JSON value Fusion
 * expects from it. Two policies, chosen by the provider layer per turn kind:
 *
 *  - `rawOnly` (the default): the whole text must be one strict JSON value, with nothing but JSON whitespace
 *    (space, tab, LF, CR) around it.
 *  - `rawOrSingleJsonFence`: additionally exactly this, and nothing else:
 *
 *        ws* OPEN LF BODY LF CLOSE ws*      (each LF may be preceded by CR)
 *        ws    := U+0020 | U+0009 | U+000A | U+000D
 *        OPEN  := "```" [ \t]* ( "json" [ \t]* )?
 *        CLOSE := [ \t]* "```"
 *
 *    OPEN and CLOSE are the only two lines of the text whose first non-blank characters are a fence marker (``` or ~~~);
 *    BODY is the exact text between them and must be one strict JSON OBJECT that satisfies the caller's expected schema.
 *    The object is then handed on exactly like a raw value: the core contract validators stay authoritative.
 *
 * Nothing is ever extracted from prose, repaired, completed or chosen among candidates, and no text outside the one
 * fence pair is ever ignored. A line-based reading suffices because a strict JSON document can never contain a line
 * that starts with a backtick or a tilde (a JSON string cannot span a line), so any third fence line is a second fence,
 * never data.
 *
 * Whatever the outcome, the reader also returns a STRUCTURE-ONLY diagnostic: fixed classes, booleans and counts that
 * describe the text's shape. It never contains any part of the text — no content, no fence tag, no key — so a refused
 * reply can be explained without being persisted.
 */

export type EnvelopePolicy = "rawOnly" | "rawOrSingleJsonFence";
export const ENVELOPE_POLICIES: readonly EnvelopePolicy[] = Object.freeze(["rawOnly", "rawOrSingleJsonFence"]);

/** Stable classification of one reply text, independent of the policy (the policy decides `accepted`). */
export const STRUCTURED_OUTPUT_CLASSES = Object.freeze([
  "RAW_VALID_JSON", "SINGLE_FENCED_VALID_JSON", "RAW_INVALID_JSON", "SINGLE_FENCED_INVALID_JSON", "EXTRA_TEXT",
  "MULTIPLE_FENCES", "MULTIPLE_VALUES", "UNCLOSED_FENCE", "UNSUPPORTED_FENCE", "INVALID_SCHEMA", "EMPTY", "OVERSIZED",
  "OTHER_MALFORMED"] as const);
export type StructuredOutputClass = (typeof STRUCTURED_OUTPUT_CLASSES)[number];

/** Upper bound of a reply text Fusion inspects at all (a provider's stream framing may bound it further). */
export const STRUCTURED_TEXT_MAX_BYTES = 1_048_576;

type JsonType = "object" | "array" | "string" | "number" | "boolean" | "null";
/**
 * Facts about the SHAPE of one reply. Only fixed enumerations, booleans and non-negative integers: no part of the reply
 * (content, keys, fence tag, prose) is ever represented. `n/a` marks a fact the shape does not define.
 */
export interface StructuredOutputDiagnostic {
  readonly schemaVersion: 1;
  /** Where the value came from: the reply text, or a provider's separate structured-output field. */
  readonly channel: "resultText" | "structuredOutputField";
  readonly policy: EnvelopePolicy;
  readonly classification: StructuredOutputClass;
  /** Whether the envelope handed a value on. Acceptance here is never acceptance of the contract. */
  readonly accepted: boolean;
  readonly outputBytes: number;
  readonly lines: number;
  readonly lineEndings: "none" | "lf" | "crlf" | "cr" | "mixed" | "n/a";
  readonly leadingByteOrderMark: boolean;
  /** C0 controls other than tab, LF and CR, DEL or C1 controls anywhere in the text (never valid raw JSON text). */
  readonly rawControlCharacters: boolean;
  readonly beginsWithFence: boolean;
  readonly fenceMarker: "backticks" | "tildes" | "none";
  readonly fenceLanguage: "json" | "none" | "other" | "n/a";
  readonly fenceLines: number;
  readonly exactlyOneFencePair: boolean;
  readonly fenceClosed: boolean;
  readonly whitespaceOnlyBeforeFence: boolean | "n/a";
  readonly whitespaceOnlyAfterFence: boolean | "n/a";
  readonly multipleFencesDetected: boolean;
  readonly extraTextPresent: boolean;
  readonly extraTextLocation: "none" | "beforeFence" | "afterFence" | "insideFence" | "afterValue" | "notDeterminable";
  /** Which text the JSON facts below describe: the whole reply, the first fence pair's body, or none. */
  readonly body: "rawText" | "fenceBody" | "none";
  readonly bodyParsesAsJson: boolean | "n/a";
  readonly bodyJsonFailure: StrictJsonFailure | "none" | "n/a";
  readonly bodyTopLevelType: JsonType | "n/a";
  readonly bodyMatchesExpectedSchema: boolean | "notChecked" | "n/a";
  /** After the first complete JSON container, another value starts (lexical scan; `notDeterminable` otherwise). */
  readonly multipleTopLevelValuesDetected: boolean | "notDeterminable" | "n/a";
}
export interface EnvelopeOptions {
  readonly policy: EnvelopePolicy;
  /** The expected decoding schema as a predicate (never authoritative); absent means `notChecked`. */
  readonly conforms?: (value: unknown) => boolean;
}
export type EnvelopeReading =
  | Readonly<{ accepted: true; value: unknown; diagnostic: StructuredOutputDiagnostic }>
  | Readonly<{ accepted: false; diagnostic: StructuredOutputDiagnostic }>;

const isWs = (c: number): boolean => c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
const isBlank = (c: number): boolean => c === 0x20 || c === 0x09;
const onlyWs = (text: string, from: number, to = text.length): boolean => {
  for (let i = from; i < to; i++) if (!isWs(text.charCodeAt(i))) return false;
  return true;
};
const jsonType = (value: unknown): JsonType => value === null ? "null" : Array.isArray(value) ? "array"
  : typeof value === "object" ? "object" : typeof value === "string" ? "string" : typeof value === "number" ? "number" : "boolean";
const isObject = (value: unknown): boolean => value !== null && typeof value === "object" && !Array.isArray(value);

type Parsed = Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; failure: StrictJsonFailure }>;
function strict(text: string): Parsed {
  try { return { ok: true, value: parseStrictJson(text) }; }
  catch (error) { return { ok: false, failure: error instanceof StrictJsonError ? error.reason : "invalidJson" }; }
}

/**
 * What follows the first complete JSON container starting at `from`: another value (`value`), anything else (`text`),
 * only whitespace (`none`), or `notDeterminable` when no container starts there or it never closes. A lexical scan of
 * strings, escapes and bracket depth for the DIAGNOSTIC only: it extracts nothing and its answer never accepts anything.
 */
function trailingAfterFirstContainer(text: string, from: number, to: number): "value" | "text" | "none" | "notDeterminable" {
  if (from >= to) return "notDeterminable";
  const first = text.charCodeAt(from);
  if (first !== 0x7b && first !== 0x5b) return "notDeterminable";
  let depth = 0, i = from;
  for (; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x22) {
      for (i++; i < to; i++) {
        const d = text.charCodeAt(i);
        if (d === 0x5c) { i++; continue; }
        if (d === 0x22) break;
      }
      if (i >= to) return "notDeterminable";
    } else if (c === 0x7b || c === 0x5b) depth++;
    else if ((c === 0x7d || c === 0x5d) && --depth === 0) break;
  }
  if (i >= to) return "notDeterminable";
  let j = i + 1;
  while (j < to && isWs(text.charCodeAt(j))) j++;
  if (j >= to) return "none";
  const next = text.charCodeAt(j);
  return next === 0x7b || next === 0x5b ? "value" : "text";
}

interface Line { readonly start: number; readonly end: number; readonly marker: number }
/** Lines split at LF only (a CR stays part of its line); `marker` is where a fence marker starts, or -1. */
function scanLines(text: string): Readonly<{ lines: number; fences: Line[]; endings: StructuredOutputDiagnostic["lineEndings"] }> {
  const fences: Line[] = [];
  let lines = 0, crlf = 0, lf = 0, cr = 0;
  for (let start = 0; start <= text.length;) {
    let end = text.indexOf("\n", start);
    if (end < 0) end = text.length;
    lines++;
    let m = start;
    while (m < end && isBlank(text.charCodeAt(m))) m++;
    if (text.startsWith("```", m) || text.startsWith("~~~", m)) fences.push({ start, end, marker: m });
    if (end < text.length) { if (end > start && text.charCodeAt(end - 1) === 0x0d) crlf++; else lf++; }
    for (let i = start; i < end - 1; i++) if (text.charCodeAt(i) === 0x0d) cr++;
    if (end === text.length && end > start && text.charCodeAt(end - 1) === 0x0d) cr++;
    start = end + 1;
  }
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  const endings = kinds === 0 ? "none" : kinds > 1 ? "mixed" : crlf > 0 ? "crlf" : lf > 0 ? "lf" : "cr";
  return { lines, fences, endings };
}
/** The fence line's text after its marker, without a trailing CR, trimmed of blanks. */
function info(text: string, line: Line): string {
  let end = line.end;
  if (end > line.marker + 3 && text.charCodeAt(end - 1) === 0x0d) end--;
  let from = line.marker + 3;
  while (from < end && isBlank(text.charCodeAt(from))) from++;
  while (end > from && isBlank(text.charCodeAt(end - 1))) end--;
  return text.slice(from, end);
}
const isBareClose = (text: string, line: Line): boolean => text.startsWith("```", line.marker) && info(text, line) === "";
const hasRawControl = (text: string): boolean => {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
};

const NOT_APPLICABLE = Object.freeze({ lineEndings: "n/a", leadingByteOrderMark: false, rawControlCharacters: false,
  beginsWithFence: false, fenceMarker: "none", fenceLanguage: "n/a", fenceLines: 0, exactlyOneFencePair: false, fenceClosed: false,
  whitespaceOnlyBeforeFence: "n/a", whitespaceOnlyAfterFence: "n/a", multipleFencesDetected: false, extraTextPresent: false,
  extraTextLocation: "none", body: "none", bodyParsesAsJson: "n/a", bodyJsonFailure: "n/a", bodyTopLevelType: "n/a",
  bodyMatchesExpectedSchema: "n/a", multipleTopLevelValuesDetected: "n/a" } as const);

/** Reads one reply text under `options.policy`; see the module comment for the exact grammar. */
export function readStructuredEnvelope(text: string, options: EnvelopeOptions): EnvelopeReading {
  const policy = options.policy;
  if (!ENVELOPE_POLICIES.includes(policy)) throw new RangeError("unknown envelope policy");
  const refuse = (diagnostic: StructuredOutputDiagnostic): EnvelopeReading => ({ accepted: false, diagnostic: Object.freeze(diagnostic) });
  const outputBytes = Buffer.byteLength(text, "utf8");
  if (outputBytes > STRUCTURED_TEXT_MAX_BYTES)
    return refuse({ schemaVersion: 1, channel: "resultText", policy, classification: "OVERSIZED", accepted: false, outputBytes, lines: 0, ...NOT_APPLICABLE });

  const scanned = scanLines(text);
  let lo = 0;
  while (lo < text.length && isWs(text.charCodeAt(lo))) lo++;
  const base = { schemaVersion: 1 as const, channel: "resultText" as const, policy, outputBytes, lines: scanned.lines,
    lineEndings: scanned.endings, leadingByteOrderMark: text.charCodeAt(0) === 0xfeff, rawControlCharacters: hasRawControl(text) };
  if (lo === text.length)
    return refuse({ ...NOT_APPLICABLE, ...base, classification: "EMPTY", accepted: false });
  const conforms = (value: unknown): boolean | "notChecked" => options.conforms === undefined ? "notChecked" : options.conforms(value);

  // The fence facts, whether or not the raw reading succeeds (a strict JSON text never has a fence line).
  const fences = scanned.fences;
  const first = fences[0], second = fences[1];
  const beginsWithFence = first !== undefined && first.marker === lo;
  const marker = first === undefined ? "none" as const : text.startsWith("```", first.marker) ? "backticks" as const : "tildes" as const;
  const tag = first === undefined ? undefined : info(text, first);
  const fenceLanguage = first === undefined ? "n/a" as const : marker === "backticks" && tag === "json" ? "json" as const
    : marker === "backticks" && tag === "" ? "none" as const : "other" as const;
  const fenceClosed = first !== undefined && second !== undefined && marker === "backticks" && isBareClose(text, second);
  const beforeClean = first === undefined ? "n/a" as const : onlyWs(text, 0, first.marker);
  const afterClean = !fenceClosed ? "n/a" as const : onlyWs(text, second!.marker + 3);
  const fenceFacts = { beginsWithFence, fenceMarker: marker, fenceLanguage, fenceLines: fences.length,
    exactlyOneFencePair: fences.length === 2 && fenceClosed, fenceClosed, whitespaceOnlyBeforeFence: beforeClean,
    whitespaceOnlyAfterFence: afterClean, multipleFencesDetected: fences.length > 2 };

  // 1. Raw: the whole text is one strict JSON value (the pre-O5.5B10 contract, unchanged; the core validates the value).
  const raw = strict(text);
  if (raw.ok) {
    const matches = isObject(raw.value) ? conforms(raw.value) : false;
    const diagnostic: StructuredOutputDiagnostic = Object.freeze({ ...base, ...fenceFacts, classification: matches === false ? "INVALID_SCHEMA" : "RAW_VALID_JSON",
      accepted: true, extraTextPresent: false, extraTextLocation: "none", body: "rawText", bodyParsesAsJson: true, bodyJsonFailure: "none",
      bodyTopLevelType: jsonType(raw.value), bodyMatchesExpectedSchema: matches, multipleTopLevelValuesDetected: false });
    return { accepted: true, value: raw.value, diagnostic };
  }

  // 2. The first fence pair's body, when there is one: described for the diagnostic, accepted only in the exact grammar.
  let bodyFacts: Pick<StructuredOutputDiagnostic, "body" | "bodyParsesAsJson" | "bodyJsonFailure" | "bodyTopLevelType" |
    "bodyMatchesExpectedSchema" | "multipleTopLevelValuesDetected"> = { body: "none", bodyParsesAsJson: "n/a", bodyJsonFailure: "n/a",
    bodyTopLevelType: "n/a", bodyMatchesExpectedSchema: "n/a", multipleTopLevelValuesDetected: "n/a" };
  let bodyValue: Parsed | undefined, bodyTrailing: ReturnType<typeof trailingAfterFirstContainer> | undefined;
  if (fenceClosed && first!.end < text.length) {
    const from = first!.end + 1, to = second!.start;
    bodyValue = strict(text.slice(from, to));
    let start = from;
    while (start < to && isWs(text.charCodeAt(start))) start++;
    bodyTrailing = bodyValue.ok ? "none" : trailingAfterFirstContainer(text, start, to);
    bodyFacts = bodyValue.ok
      ? { body: "fenceBody", bodyParsesAsJson: true, bodyJsonFailure: "none", bodyTopLevelType: jsonType(bodyValue.value),
        bodyMatchesExpectedSchema: isObject(bodyValue.value) ? conforms(bodyValue.value) : false, multipleTopLevelValuesDetected: false }
      : { body: "fenceBody", bodyParsesAsJson: false, bodyJsonFailure: bodyValue.failure, bodyTopLevelType: "n/a",
        bodyMatchesExpectedSchema: "n/a", multipleTopLevelValuesDetected: bodyTrailing === "value" ? true
          : bodyTrailing === "notDeterminable" ? "notDeterminable" : false };
  }
  const describe = (classification: StructuredOutputClass, extraTextLocation: StructuredOutputDiagnostic["extraTextLocation"],
    body = bodyFacts): StructuredOutputDiagnostic => Object.freeze({ ...base, ...fenceFacts, ...body, classification, accepted: false,
    extraTextPresent: extraTextLocation !== "none" && extraTextLocation !== "notDeterminable", extraTextLocation });

  if (first === undefined) {
    // 3. No fence at all: a raw text that is not strict JSON. Described, never searched for a value.
    const trailing = trailingAfterFirstContainer(text, lo, text.length);
    const rawBody = { body: "rawText" as const, bodyParsesAsJson: false, bodyJsonFailure: raw.failure, bodyTopLevelType: "n/a" as const,
      bodyMatchesExpectedSchema: "n/a" as const, multipleTopLevelValuesDetected: trailing === "value" ? true
        : trailing === "notDeterminable" ? "notDeterminable" as const : false };
    const opens = text.charCodeAt(lo) === 0x7b || text.charCodeAt(lo) === 0x5b;
    return refuse(!opens ? describe("OTHER_MALFORMED", "notDeterminable", rawBody)
      : trailing === "value" ? describe("MULTIPLE_VALUES", "none", rawBody)
      : trailing === "text" ? describe("EXTRA_TEXT", "afterValue", rawBody)
      : describe("RAW_INVALID_JSON", "none", rawBody));
  }
  if (fences.length > 2) return refuse(describe("MULTIPLE_FENCES", beforeClean ? "afterFence" : "beforeFence"));
  if (!beginsWithFence) return refuse(describe("EXTRA_TEXT", "beforeFence"));
  if (fenceLanguage === "other") return refuse(describe("UNSUPPORTED_FENCE", afterClean === false ? "afterFence" : "none"));
  if (!fenceClosed) return refuse(describe("UNCLOSED_FENCE", "none"));
  if (afterClean === false) return refuse(describe("EXTRA_TEXT", "afterFence"));
  // Exactly one json/bare fence pair with only whitespace outside it.
  if (bodyValue === undefined || !bodyValue.ok)
    return refuse(bodyTrailing === "value" ? describe("MULTIPLE_VALUES", "none")
      : bodyTrailing === "text" ? describe("EXTRA_TEXT", "insideFence") : describe("SINGLE_FENCED_INVALID_JSON", "none"));
  if (bodyFacts.bodyMatchesExpectedSchema === false) return refuse(describe("INVALID_SCHEMA", "none"));
  if (!isObject(bodyValue.value)) return refuse(describe("INVALID_SCHEMA", "none"));
  const diagnostic = Object.freeze({ ...describe("SINGLE_FENCED_VALID_JSON", "none"), accepted: policy === "rawOrSingleJsonFence" });
  return diagnostic.accepted ? { accepted: true, value: bodyValue.value, diagnostic } : { accepted: false, diagnostic };
}

/**
 * The diagnostic of a value a provider delivered in a separate structured-output field (no reply text to describe): only
 * its top-level type and schema conformance. The raw envelope rules do not apply to it; the core still validates it.
 */
export function describeStructuredField(value: unknown, options: EnvelopeOptions): StructuredOutputDiagnostic {
  const matches = !isObject(value) ? false : options.conforms === undefined ? "notChecked" as const : options.conforms(value);
  return Object.freeze({ schemaVersion: 1, channel: "structuredOutputField", policy: options.policy, ...NOT_APPLICABLE,
    classification: matches === false ? "INVALID_SCHEMA" : "RAW_VALID_JSON", accepted: true, outputBytes: 0, lines: 0,
    body: "none", bodyParsesAsJson: true, bodyJsonFailure: "none", bodyTopLevelType: jsonType(value), bodyMatchesExpectedSchema: matches });
}

// ---------------------------------------------------------------- evidence

const ENUMS: Readonly<Record<string, readonly unknown[]>> = Object.freeze({
  schemaVersion: [1], channel: ["resultText", "structuredOutputField"], policy: ENVELOPE_POLICIES, classification: STRUCTURED_OUTPUT_CLASSES,
  accepted: [true, false], lineEndings: ["none", "lf", "crlf", "cr", "mixed", "n/a"], leadingByteOrderMark: [true, false],
  rawControlCharacters: [true, false], beginsWithFence: [true, false], fenceMarker: ["backticks", "tildes", "none"],
  fenceLanguage: ["json", "none", "other", "n/a"], exactlyOneFencePair: [true, false], fenceClosed: [true, false],
  whitespaceOnlyBeforeFence: [true, false, "n/a"], whitespaceOnlyAfterFence: [true, false, "n/a"], multipleFencesDetected: [true, false],
  extraTextPresent: [true, false], extraTextLocation: ["none", "beforeFence", "afterFence", "insideFence", "afterValue", "notDeterminable"],
  body: ["rawText", "fenceBody", "none"], bodyParsesAsJson: [true, false, "n/a"],
  bodyJsonFailure: ["invalidJson", "tooDeep", "duplicateKey", "none", "n/a"],
  bodyTopLevelType: ["object", "array", "string", "number", "boolean", "null", "n/a"],
  bodyMatchesExpectedSchema: [true, false, "notChecked", "n/a"], multipleTopLevelValuesDetected: [true, false, "notDeterminable", "n/a"],
});
const COUNTS = Object.freeze(["outputBytes", "lines", "fenceLines"]);
const DIAGNOSTIC_KEYS = Object.freeze([...Object.keys(ENUMS), ...COUNTS]);

/**
 * The structure-only diagnostic as evidence may record it: rebuilt from the fixed key set, each value checked against its
 * enumeration or as a bounded non-negative integer. Anything else — an extra key, a string outside an enumeration, a
 * getter — makes the whole record `"invalid"`, so no provider-controlled text can ever reach evidence through it.
 * `null` when no diagnostic was reported.
 */
export function structureOnlyDiagnostic(candidate: unknown): StructuredOutputDiagnostic | "invalid" | null {
  if (candidate === undefined || candidate === null) return null;
  let copy: unknown;
  try { copy = structuredClone(candidate); } catch { return "invalid"; }
  if (!isObject(copy)) return "invalid";
  const source = copy as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length !== DIAGNOSTIC_KEYS.length || !DIAGNOSTIC_KEYS.every(key => Object.hasOwn(source, key))) return "invalid";
  const out: Record<string, unknown> = {};
  for (const key of DIAGNOSTIC_KEYS) {
    const value = source[key];
    const valid = COUNTS.includes(key) ? Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 1_000_000_000
      : ENUMS[key]!.includes(value);
    if (!valid) return "invalid";
    out[key] = value;
  }
  return Object.freeze(out) as unknown as StructuredOutputDiagnostic;
}
