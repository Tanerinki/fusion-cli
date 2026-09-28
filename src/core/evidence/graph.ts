import { failWith } from "../errors.js";

/**
 * v0.4 — THE EVIDENCE GRAPH: what Fusion holds about the claims of one task, and why. Models may PROPOSE claims (a finding,
 * a hypothesis, a diagnosis, a counterexample) and may REPORT judgements about them; they never decide what is true. Fusion
 * owns the graph and derives every claim's status from the evidence attached to it, with one fixed rule:
 *
 *   - a claim is CONTRADICTED when any fresh DETERMINISTIC evidence contradicts it (one failed test of a claim is enough);
 *   - otherwise SUPPORTED when fresh deterministic evidence supports it;
 *   - otherwise STALE when its only deterministic evidence was observed against a state that is no longer current;
 *   - otherwise UNVERIFIED — however many models agree.
 *
 * Deterministic evidence is what Fusion itself executed or observed: a verification command's result (on the change or on
 * the unchanged baseline), a file check it evaluated on the shared copy, the changed paths it observed, the protected-material
 * state it checked. A host-checked citation only says the named file exists and was shared. A model's judgement (an
 * investigator's verdict, a reviewer's or falsifier's finding, the lead's conclusion, a worker's report) is recorded and
 * counted — it can make a claim CHALLENGED or show a conflict — but it never moves a claim to SUPPORTED or CONTRADICTED.
 * A human decision is recorded as such; it grants a gate, it is not evidence that a claim is true.
 *
 * Nothing is overwritten: evidence is appended in order, so a claim's history (claimed → challenged → tested → contradicted)
 * stays visible. The graph is bounded; when a bound is hit it says so, and no claim of an overflowed graph is reported
 * SUPPORTED (a dropped contradiction could otherwise hide). Pure and provider-neutral.
 */
export const EVIDENCE_GRAPH_FORMAT = "fusion.evidenceGraph" as const;
export const EVIDENCE_GRAPH_VERSION = 1 as const;
export const EVIDENCE_LIMITS = Object.freeze({
  maxClaims: 48,
  maxEvidence: 256,
  maxStatementChars: 400,
  maxDetailChars: 300,
  maxLabelChars: 80,
  maxRefChars: 64,
  maxSubjectChars: 120,
  maxBasisChars: 120,
  maxFiles: 8,
  maxPathChars: 300,
});

/**
 * - `task`: the change a human asked for. `finding`: a claim from an analysis the user asks about, or the user's own claim.
 * - `hypothesis`: an investigator's explanation. `diagnosis`: the conclusion a route reached. `rootCause`: what a fix assumes.
 * - `fixEffect`: that a change resolves the reproduced defect. `counterexample`: a challenge to another claim.
 */
export const CLAIM_KINDS = ["task", "finding", "hypothesis", "diagnosis", "rootCause", "fixEffect", "counterexample"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];
/** Who proposed a claim. Provenance only: no origin grants authority. */
export const CLAIM_ORIGINS = ["user", "fusion", "lead", "investigator", "reviewer", "falsifier", "worker"] as const;
export type ClaimOrigin = (typeof CLAIM_ORIGINS)[number];
/** What produced a piece of evidence. Its authority follows from this, never from the caller. */
export const EVIDENCE_SOURCES = ["verification", "reproduction", "fileCheck", "diff", "protection", "citation",
  "investigator", "reviewer", "falsifier", "lead", "worker", "human"] as const;
export type EvidenceSource = (typeof EVIDENCE_SOURCES)[number];
export const EVIDENCE_RELATIONS = ["supports", "contradicts", "neutral"] as const;
export type EvidenceRelation = (typeof EVIDENCE_RELATIONS)[number];
export const CLAIM_STATUSES = ["SUPPORTED", "CONTRADICTED", "UNVERIFIED", "STALE"] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
/** `deterministic`: Fusion executed or observed it. `citation`: a host-checked file reference. `model`: an opinion. `human`: a decision. */
export type EvidenceAuthority = "deterministic" | "citation" | "model" | "human";

const AUTHORITY: Readonly<Record<EvidenceSource, EvidenceAuthority>> = Object.freeze({
  verification: "deterministic", reproduction: "deterministic", fileCheck: "deterministic", diff: "deterministic", protection: "deterministic",
  citation: "citation", investigator: "model", reviewer: "model", falsifier: "model", lead: "model", worker: "model", human: "human",
});
/** The fixed authority of a source. */
export const authorityOf = (source: EvidenceSource): EvidenceAuthority => AUTHORITY[source];

export interface ClaimRecord {
  /** Stable within the graph: a host-chosen key (`claim`, `h1`, `root-cause`) or `c<n>`. */
  readonly id: string;
  readonly kind: ClaimKind;
  readonly origin: ClaimOrigin;
  /** A safe label of where it came from: a packet id, a review cycle, `session`. */
  readonly ref: string;
  /** What it is about, in Fusion's words: `finding 1`, `task`, `configuration.yaml`. */
  readonly subject: string;
  /** The claim as proposed (bounded; model text when a model proposed it, and never evidence by itself). */
  readonly statement: string;
  /** Repository-relative files the claim rests on, as the host checked them. */
  readonly files: readonly string[];
  /** The earlier claim this one challenges (a counterexample or an alternative explanation). */
  readonly challenges?: string;
  readonly order: number;
}
export interface EvidenceRecord {
  readonly id: string;
  readonly claim: string;
  readonly source: EvidenceSource;
  readonly relation: EvidenceRelation;
  /** A safe label: a command id, a check id, a packet id. */
  readonly label: string;
  /** Bounded: Fusion's own account for deterministic evidence; the model's words (untrusted) for a judgement. */
  readonly detail: string;
  /** The state it was observed against (`baseline:<commit>`, `view:<digest>`): evidence of an older state is stale. */
  readonly basis?: string;
  readonly order: number;
}
export interface EvidenceGraphRecord {
  readonly format: typeof EVIDENCE_GRAPH_FORMAT;
  readonly version: typeof EVIDENCE_GRAPH_VERSION;
  readonly claims: readonly ClaimRecord[];
  readonly evidence: readonly EvidenceRecord[];
  /** A bound was hit and something was not recorded. */
  readonly overflowed: boolean;
}
export interface ClaimInput {
  readonly kind: ClaimKind;
  readonly origin: ClaimOrigin;
  readonly ref: string;
  readonly subject: string;
  readonly statement: string;
  readonly files?: readonly string[];
  readonly challenges?: string;
  /** A host-chosen stable id; `c<n>` when absent. */
  readonly key?: string;
}
export interface EvidenceInput {
  readonly claim: string;
  readonly source: EvidenceSource;
  readonly relation: EvidenceRelation;
  readonly label: string;
  readonly detail: string;
  readonly basis?: string;
}
/** A claim as Fusion judges it now. The counts are corroboration only; `status` is the decision. */
export interface ClaimAssessment {
  readonly id: string;
  readonly status: ClaimStatus;
  readonly deterministic: Readonly<{ supports: number; contradicts: number; stale: number }>;
  readonly models: Readonly<{ supports: number; contradicts: number }>;
  readonly citations: number;
  readonly human: number;
  /** A model disputes it: a model's contradiction, or a counterexample that Fusion has not refuted. */
  readonly challenged: boolean;
  /** Models disagree about it. */
  readonly modelConflict: boolean;
}

const ID = /^[a-z][a-z0-9-]{0,31}$/u;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._:@/+-]*$/u;
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f‪-‮⁦-⁩]/gu;
const HAS_CONTROL = /[\x00-\x1f\x7f-\x9f‪-‮⁦-⁩]/u;
const has = <T extends string>(list: readonly T[], value: unknown): value is T => typeof value === "string" && (list as readonly string[]).includes(value);

/** Text as the graph keeps it: one line, control and direction characters removed, bounded with an ellipsis. */
export function evidenceText(value: string, max: number): string {
  const text = value.replace(CONTROL, " ").replace(/\s+/gu, " ").trim();
  if (text.length === 0) return "(empty)";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** A repository-relative, `/`-separated path, or undefined (absolute, `..`, backslash, a URL, too long). */
export function evidencePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > EVIDENCE_LIMITS.maxPathChars) return undefined;
  if (/^[\\/]|^[A-Za-z]:|\\|^[a-z]+:\/\//iu.test(value) || HAS_CONTROL.test(value)) return undefined;
  const segments = value.split("/");
  return segments.some(s => s === "" || s === "." || s === "..") ? undefined : value;
}
function label(value: string, max: number, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max || !LABEL.test(value))
    failWith("InternalError", `The evidence graph was given an invalid ${what}.`);
  return value;
}

export class EvidenceGraph {
  readonly #claims: ClaimRecord[] = [];
  readonly #evidence: EvidenceRecord[] = [];
  #order = 0;
  #overflowed = false;

  get claims(): readonly ClaimRecord[] { return [...this.#claims]; }
  get evidence(): readonly EvidenceRecord[] { return [...this.#evidence]; }
  /** A bound was hit: something was not recorded, so no claim is reported SUPPORTED. */
  get overflowed(): boolean { return this.#overflowed; }
  claim(id: string): ClaimRecord | undefined { return this.#claims.find(c => c.id === id); }
  evidenceFor(id: string): readonly EvidenceRecord[] { return this.#evidence.filter(e => e.claim === id); }

  /** Records a claim; returns its id, or undefined when the claim bound is reached (the graph is then marked overflowed). */
  addClaim(input: ClaimInput): string | undefined {
    if (!has(CLAIM_KINDS, input.kind) || !has(CLAIM_ORIGINS, input.origin)) failWith("InternalError", "The evidence graph was given an invalid claim.");
    if (this.#claims.length >= EVIDENCE_LIMITS.maxClaims) { this.#overflowed = true; return undefined; }
    const id = input.key ?? `c${this.#claims.length + 1}`;
    if (!ID.test(id) || this.claim(id) !== undefined) failWith("InternalError", "The evidence graph was given a duplicate or invalid claim id.");
    if (input.challenges !== undefined && this.claim(input.challenges) === undefined)
      failWith("InternalError", "A claim can only challenge a claim recorded before it.");
    const files = [...new Set((input.files ?? []).map(evidencePath).filter((p): p is string => p !== undefined))].slice(0, EVIDENCE_LIMITS.maxFiles);
    this.#claims.push(Object.freeze({ id, kind: input.kind, origin: input.origin, ref: label(input.ref, EVIDENCE_LIMITS.maxRefChars, "claim reference"),
      subject: evidenceText(input.subject, EVIDENCE_LIMITS.maxSubjectChars), statement: evidenceText(input.statement, EVIDENCE_LIMITS.maxStatementChars),
      files: Object.freeze(files), ...(input.challenges === undefined ? {} : { challenges: input.challenges }), order: ++this.#order }));
    return id;
  }

  /** Appends evidence about a recorded claim; returns its id, or undefined when the evidence bound is reached. */
  addEvidence(input: EvidenceInput): string | undefined {
    if (this.claim(input.claim) === undefined) failWith("InternalError", "Evidence must be about a recorded claim.");
    if (!has(EVIDENCE_SOURCES, input.source) || !has(EVIDENCE_RELATIONS, input.relation)) failWith("InternalError", "The evidence graph was given invalid evidence.");
    if (this.#evidence.length >= EVIDENCE_LIMITS.maxEvidence) { this.#overflowed = true; return undefined; }
    const id = `e${this.#evidence.length + 1}`;
    this.#evidence.push(Object.freeze({ id, claim: input.claim, source: input.source, relation: input.relation,
      label: label(input.label, EVIDENCE_LIMITS.maxLabelChars, "evidence label"), detail: evidenceText(input.detail, EVIDENCE_LIMITS.maxDetailChars),
      ...(input.basis === undefined ? {} : { basis: evidenceText(input.basis, EVIDENCE_LIMITS.maxBasisChars) }), order: ++this.#order }));
    return id;
  }

  /**
   * The claim's status and corroboration, derived by the fixed rule. `fresh` says whether evidence observed against a basis is
   * still current (default: every basis is); deterministic evidence of a stale basis never settles a claim.
   */
  assess(id: string, fresh: (basis: string) => boolean = () => true): ClaimAssessment {
    if (this.claim(id) === undefined) failWith("InternalError", "Only a recorded claim can be assessed.");
    const items = this.evidenceFor(id);
    const current = (e: EvidenceRecord) => e.basis === undefined || fresh(e.basis);
    const det = items.filter(e => authorityOf(e.source) === "deterministic");
    const supports = det.filter(e => current(e) && e.relation === "supports").length;
    const contradicts = det.filter(e => current(e) && e.relation === "contradicts").length;
    const stale = det.filter(e => !current(e) && e.relation !== "neutral").length;
    const models = items.filter(e => authorityOf(e.source) === "model");
    const modelSupports = models.filter(e => e.relation === "supports").length, modelContradicts = models.filter(e => e.relation === "contradicts").length;
    let status: ClaimStatus = contradicts > 0 ? "CONTRADICTED" : supports > 0 ? "SUPPORTED" : stale > 0 ? "STALE" : "UNVERIFIED";
    if (status === "SUPPORTED" && this.#overflowed) status = "UNVERIFIED";
    // A counterexample challenges its target until Fusion's own evidence refutes it.
    const openCounterexample = this.#claims.some(c => c.challenges === id && c.kind === "counterexample" &&
      !this.evidenceFor(c.id).some(e => authorityOf(e.source) === "deterministic" && current(e) && e.relation === "contradicts"));
    return Object.freeze({ id, status, deterministic: Object.freeze({ supports, contradicts, stale }),
      models: Object.freeze({ supports: modelSupports, contradicts: modelContradicts }),
      citations: items.filter(e => authorityOf(e.source) === "citation").length, human: items.filter(e => authorityOf(e.source) === "human").length,
      challenged: modelContradicts > 0 || openCounterexample, modelConflict: modelSupports > 0 && modelContradicts > 0 });
  }

  /** The claim's history in order: its evidence and the claims that challenge it. */
  timeline(id: string): readonly Readonly<{ order: number; entry: EvidenceRecord | ClaimRecord }>[] {
    const claim = this.claim(id);
    if (claim === undefined) return [];
    const entries: Array<EvidenceRecord | ClaimRecord> = [claim, ...this.evidenceFor(id), ...this.#claims.filter(c => c.challenges === id)];
    return Object.freeze(entries.sort((a, b) => a.order - b.order).map(entry => Object.freeze({ order: entry.order, entry })));
  }

  record(): EvidenceGraphRecord {
    return Object.freeze({ format: EVIDENCE_GRAPH_FORMAT, version: EVIDENCE_GRAPH_VERSION, claims: Object.freeze([...this.#claims]),
      evidence: Object.freeze([...this.#evidence]), overflowed: this.#overflowed });
  }

  /** A graph from a persisted record, validated strictly first (`parseEvidenceGraph`). */
  static from(value: unknown): EvidenceGraph {
    const record = parseEvidenceGraph(value);
    const graph = new EvidenceGraph();
    graph.#claims.push(...record.claims);
    graph.#evidence.push(...record.evidence);
    graph.#order = Math.max(0, ...record.claims.map(c => c.order), ...record.evidence.map(e => e.order));
    graph.#overflowed = record.overflowed;
    return graph;
  }
}

const own = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean =>
  required.every(k => Object.hasOwn(value, k)) && Object.keys(value).every(k => required.includes(k) || optional.includes(k));
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max &&
  evidenceText(value, max) === value;

/**
 * Validates a persisted graph exactly: format and version, every field's type and bound, known vocabularies, unique ids,
 * strictly increasing order, evidence only about earlier claims, challenges only of earlier claims. Anything else is refused
 * (`InvalidInput`): a malformed record is never read as a smaller, cleaner one.
 */
export function parseEvidenceGraph(value: unknown): EvidenceGraphRecord {
  const bad = (what: string): never => failWith("InvalidInput", `The evidence record is malformed (${what}).`);
  if (!own(value) || !keys(value, ["format", "version", "claims", "evidence", "overflowed"])) return bad("fields");
  if (value.format !== EVIDENCE_GRAPH_FORMAT || value.version !== EVIDENCE_GRAPH_VERSION) return bad("format or version");
  if (typeof value.overflowed !== "boolean" || !Array.isArray(value.claims) || !Array.isArray(value.evidence) ||
      value.claims.length > EVIDENCE_LIMITS.maxClaims || value.evidence.length > EVIDENCE_LIMITS.maxEvidence) return bad("bounds");
  const L = EVIDENCE_LIMITS;
  const seen = new Map<string, number>();
  let last = 0;
  const claims: ClaimRecord[] = value.claims.map((c: unknown) => {
    if (!own(c) || !keys(c, ["id", "kind", "origin", "ref", "subject", "statement", "files", "order"], ["challenges"])) return bad("claim");
    if (typeof c.id !== "string" || !ID.test(c.id) || seen.has(c.id) || !has(CLAIM_KINDS, c.kind) || !has(CLAIM_ORIGINS, c.origin) ||
        typeof c.ref !== "string" || c.ref.length > L.maxRefChars || !LABEL.test(c.ref) || !bounded(c.subject, L.maxSubjectChars) ||
        !bounded(c.statement, L.maxStatementChars) || !Array.isArray(c.files) || c.files.length > L.maxFiles ||
        !c.files.every(f => evidencePath(f) === f) || !Number.isSafeInteger(c.order) || (c.order as number) <= last ||
        (c.challenges !== undefined && (typeof c.challenges !== "string" || !seen.has(c.challenges)))) return bad("claim");
    last = c.order as number;
    seen.set(c.id, last);
    return Object.freeze({ id: c.id, kind: c.kind, origin: c.origin, ref: c.ref, subject: c.subject, statement: c.statement,
      files: Object.freeze([...(c.files as string[])]), ...(c.challenges === undefined ? {} : { challenges: c.challenges as string }), order: last });
  });
  const ids = new Set<string>();
  let lastEvidence = 0;
  const evidence: EvidenceRecord[] = value.evidence.map((e: unknown, index: number) => {
    if (!own(e) || !keys(e, ["id", "claim", "source", "relation", "label", "detail", "order"], ["basis"])) return bad("evidence");
    if (e.id !== `e${index + 1}` || ids.has(e.id as string) || typeof e.claim !== "string" || !seen.has(e.claim) ||
        !has(EVIDENCE_SOURCES, e.source) || !has(EVIDENCE_RELATIONS, e.relation) || typeof e.label !== "string" ||
        e.label.length > L.maxLabelChars || !LABEL.test(e.label) || !bounded(e.detail, L.maxDetailChars) ||
        (e.basis !== undefined && !bounded(e.basis, L.maxBasisChars)) || !Number.isSafeInteger(e.order) ||
        (e.order as number) <= lastEvidence || (e.order as number) <= seen.get(e.claim)!) return bad("evidence");
    lastEvidence = e.order as number;
    ids.add(e.id as string);
    return Object.freeze({ id: e.id as string, claim: e.claim, source: e.source, relation: e.relation, label: e.label, detail: e.detail,
      ...(e.basis === undefined ? {} : { basis: e.basis as string }), order: lastEvidence });
  });
  return Object.freeze({ format: EVIDENCE_GRAPH_FORMAT, version: EVIDENCE_GRAPH_VERSION, claims: Object.freeze(claims),
    evidence: Object.freeze(evidence), overflowed: value.overflowed });
}
