/**
 * v0.2 — WHAT A SHELL TURN ASKS FOR, decided by the host. `fusion` without a command takes natural language; every line is
 * classified here, deterministically and without any model, into one intent kind, and the kind — not the text, not a model
 * reply — decides what the turn may do (`grantFor`):
 *
 *   - Talking, analysing, investigating and planning are READ-ONLY turns: providers run only in Fusion-owned read-only views
 *     and the primary source is proven unchanged around them. A read-only turn can never become a write turn.
 *   - Only a `change` (or `create`) turn may ENTER the Writer route, and only after the human confirmed the shown plan; the
 *     route itself keeps every gate (private candidate, confined verification, fresh review, delivery, human approval).
 *   - A request to bypass those gates is recognised and refused; an unbounded destructive request is sent back as a question.
 *
 * A model may still PROPOSE a task in its reply (`Proposed build task:`), but that only fills in what a later change turn
 * would build; it never grants anything. English and German phrasings are recognised (German umlauts are matched in their
 * transliterated form); anything unrecognised is conversation.
 */
export type IntentKind = "empty" | "help" | "exit" | "conversation" | "analysis" | "investigation" | "plan" | "change" | "create" | "history" |
  "undo" | "bypass" | "clarify";
/** A follow-up's reference to earlier results: the last one discussed, one by position (0-based; -1 the last), or all. */
export type IntentReference = Readonly<{ kind: "previous" }> | Readonly<{ kind: "index"; index: number }> | Readonly<{ kind: "all" }>;
export interface TurnIntent {
  readonly kind: IntentKind;
  /** The line as typed (trimmed, control characters removed, bounded). */
  readonly text: string;
  /** analysis: the whole project rather than one area or file. */
  readonly broad: boolean;
  readonly reference?: IntentReference;
  /**
   * v0.3: a read-only line that asks whether something is TRUE ("is that really a bug?", "check whether the first finding
   * holds"). With a finding to refer to, the host may investigate it as a claim; it never grants anything more.
   */
  readonly verification?: boolean;
  /**
   * v0.4: the user's OWN claim, when the line states one to check ("is it true that <claim>?", "check whether <claim>",
   * "stimmt es, dass <claim>?") and the claim itself refers to no earlier finding. Untrusted text; it grants nothing.
   */
  readonly claim?: string;
  /**
   * v0.4: a read-only line that asks for the CAUSE of a failure ("why does … fail?", "what causes …", "debug …"): the host may
   * diagnose it with independent hypotheses. It never grants anything more.
   */
  readonly diagnosis?: boolean;
  /** Why the host classified it this way (tests and `--debug`). */
  readonly reason: string;
}
/** What the host grants a turn of one kind. There is no stronger grant than `afterConfirmation`. */
export interface TurnGrant {
  /** `none`: no provider runs. `readOnly`: providers run only in read-only views. */
  readonly providers: "none" | "readOnly";
  /** `never`: nothing is written. `afterConfirmation`: the confirmed Writer route may start (it still ends at human approval). */
  readonly mutation: "never" | "afterConfirmation";
}

const NONE: TurnGrant = Object.freeze({ providers: "none", mutation: "never" });
const READ: TurnGrant = Object.freeze({ providers: "readOnly", mutation: "never" });
const CONFIRMED: TurnGrant = Object.freeze({ providers: "readOnly", mutation: "afterConfirmation" });
const GRANTS: Readonly<Record<IntentKind, TurnGrant>> = Object.freeze({
  empty: NONE, help: NONE, exit: NONE, history: NONE, undo: NONE, bypass: NONE, clarify: NONE,
  conversation: READ, analysis: READ, investigation: READ, plan: READ, change: CONFIRMED, create: CONFIRMED,
});
export function grantFor(kind: IntentKind): TurnGrant { return GRANTS[kind]; }
export const MAX_INTENT_CHARS = 8_000;

const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/gu;
/** Terminal escape sequences (colours, cursor movement) pasted with a line: removed whole, not just their ESC. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/gu;
/** Lower case, single spaces, German umlauts transliterated (JavaScript's `\b` only knows ASCII word characters). */
function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/gu, " ").replace(/ä/gu, "ae").replace(/ö/gu, "oe").replace(/ü/gu, "ue").replace(/ß/gu, "ss");
}

const HELP = /^(?:\/?help|\/?\?|\/?hilfe|what can you do|what can i do|was kannst du(?: alles)?(?: tun| machen)?)$/u;
const EXIT = /^(?:\/?exit|\/?quit|\/q|:q|bye|goodbye|tschuess|ciao|beenden|ende)$/u;
const HISTORY = /^(?:\/?history|\/?status|verlauf|\/?runs)$|\b(?:show|list)\b.{0,20}\b(?:runs|deliveries|history)\b|\bwhat (?:did|have) (?:you|fusion) (?:do|done|change|changed)\b|\bwas hast du (?:gemacht|geaendert|getan)\b|\bzeig(?:e)? .{0,20}(?:verlauf|laeufe|lieferungen)\b/u;
const UNDO = /\b(?:undo|revert|roll ?back)\b|rueckgaengig|zuruecksetzen/u;
/** Requests to leave out Fusion's safety gates: refused whatever else the line says. */
const BYPASS: readonly RegExp[] = [
  /\bwithout (?:all |any )?(?:(?:of )?(?:that|the|this|those|these|your) )?(?:\w+ )?(?:safety|security|checks?|reviews?|verification|approvals?|confirmation|sandbox|docker|gates?)\b/u,
  /\b(?:skip|bypass|disable|turn off|switch off|ignore|circumvent|avoid)\b.{0,25}\b(?:safety|security|checks?|reviews?|verification|approvals?|confirmation|sandbox|docker|gates?|tests?)\b/u,
  /\bno (?:safety|security|checks|review|verification|approval|confirmation|sandbox)\b/u,
  /\bdirectly (?:edit|change|modify|write|patch|overwrite)\b|\b(?:edit|change|modify|write|patch|overwrite)\b.{0,60}\bdirectly\b/u,
  /(?:^|\s)--?(?:force|no-verify|yolo)\b|\bdangerously\b|\bforce[- ](?:push|write|apply)\b/u,
  /\bohne (?:den |die |das |all |alle |jede |diese |diesen )?(?:\w+ )?(?:sicherheit\w*|pruefung\w*|ueberpruefung\w*|review\w*|bestaetigung\w*|freigabe\w*|tests?|kontrolle\w*)\b/u,
  /\bdirekt (?:\w+ ){0,3}(?:aendern|bearbeiten|schreiben|editieren|ueberschreiben|reinschreiben)\b|\b(?:ueberspring|umgeh)\w*\b/u,
];
/** Unbounded destructive requests: asked back, never started. */
const DESTRUCTIVE = /\b(?:delete|remove|wipe|erase|purge|nuke)\b.{0,20}\b(?:everything|all(?: the)? files|the (?:whole|entire) (?:repo|repository|project|folder|codebase|config(?:uration)?))\b|\brewrite (?:the )?(?:whole|entire|everything)\b|\b(?:loesch|entfern)\w*\b.{0,20}\b(?:alles|alle dateien|das ganze|den ganzen)\b/u;
const CREATE = /\b(?:create|start|scaffold|set up|setup|bootstrap|make|build|generate|erstell\w*|leg\w*|bau\w*|mach\w*)\b.{0,30}\b(?:new|neue[snmr]?|fresh)\b.{0,20}\b(?:project|projekt|app|application|anwendung|library|bibliothek|cli|api|service|repo|repository)(?:\s+(?:for|that|which|called|named|in|to|with|mit|fuer|der|die|das|zum|zur|an)\b|[\s.,!?]*$)/u;
const QUESTION_START = /^(?:what|what's|how|why|which|where|when|who|whose|is|are|does|do|should|shall|was|wie|warum|wieso|weshalb|welche[srnm]?|wo|wann|wer|ist|sind|gibt es|sollte[n]?|soll)\b/u;
const POLITE_QUESTION = /^(?:please |bitte )?(?:can|could|would|will) you\b|^(?:kannst|koenntest|wuerdest) du\b/u;
const PLAN = /\b(?:what|how|which) would you\b|\bwhat (?:should|shall|could|can) (?:i|we)\b|\b(?:make|give me|write|draft|create) (?:me )?(?:a |an )?plan\b|\bplan (?:for|to|how)\b|\bpropos\w*|\bsuggest\w*|\brecommend\w*|\bnext steps?\b|\bwas wuerdest du\b|\bwie wuerdest du\b|\bwas (?:sollte|soll|koennte|kann)(?:n)? (?:ich|wir)\b|\bvorschlag\w*|\bschlag\w* .{0,30}vor\b|\bempfiehl\w*|\bempfehl\w*|\bplan\b|\bplane\b/u;
/** Change verbs, as an imperative (optionally after a politeness phrase). */
const CHANGE_VERB = "(?:fix|repair|correct|change|modify|edit|update|refactor|rename|implement|add|remove|delete|replace|apply|write|create|build|resolve|improve|clean up|cleanup|migrate|upgrade|bump|adjust|patch|convert|move|split|behebe?|fixe?|repariere?|korrigiere?|aendere?|aender|passe?|aktualisiere?|fuege?|entferne?|loesche?|ersetze?|implementiere?|baue?|schreibe?|verbessere?|raeume?|stelle?|setze?|uebernimm|uebernehmen|anwenden)";
const POLITE = "(?:(?:ok(?:ay)?|yes|ja|gut|super|cool|alright|then|dann|jetzt|now|and|und)[,!. ]+)*(?:please |pls |bitte |(?:can|could|would|will) you (?:please )?|kannst du (?:bitte )?|koenntest du (?:bitte )?|wuerdest du (?:bitte )?|let'?s |lass uns |go ahead and |just |einfach |dann |jetzt )?";
const CHANGE = new RegExp(`^${POLITE}${CHANGE_VERB}\\b`, "u");
const GO_AHEAD = /^(?:(?:ok(?:ay)?|yes|ja|gut|super)[,!. ]+)*(?:do it|go ahead|go for it|make it so|ship it|make (?:that|this|the) change|mach(?:e)? (?:das|es|mal|die aenderung)|leg los|los geht'?s|setz(?:e)? (?:das|es) um|umsetzen|mach weiter)\b/u;
/** A "write/create a summary" is talk, not a change. */
const NARRATIVE = /^.{0,50}\b(?:summary|summarize|explanation|overview|description|report|list|table|diagram|zusammenfassung|erklaerung|uebersicht|beschreibung|bericht|liste|tabelle)\b/u;
const ANALYSIS = /\b(?:analy[sz]e|analysis|analysiere\w*|analyse\w*|audit|scan|inspect|review|untersuch\w*|pruef\w*|ueberpruef\w*|check|look (?:at|through|over|into)|go through|durchsuch\w*|durchgeh\w*|schau\w* .{0,40}(?:an|durch|nach))\b|\b(?:find|search for|look for|spot|such\w*|find\w*)\b.{0,40}\b(?:errors?|issues?|problems?|bugs?|improvements?|mistakes?|risks?|fehler\w*|problem\w*|verbesserung\w*|schwachstelle\w*)\b|\b(?:are there|any|gibt es|have|has|hat|haben)\b.{0,30}\b(?:errors?|issues?|problems?|bugs?|fehler\w*|problem\w*)\b/u;
const NARROW = /\b(?:auth\w*|security|sicherheit|tests?|ci|docker|api|database|db|ui|frontend|backend|performance|automations?|automationen|scripts?|skripte?|scenes?|szenen|packages?|pakete|integrations?|integrationen|dependencies|abhaengigkeiten)\b/u;
const BROAD = /\b(?:whole|entire|all|every|complete|overall|ganze[nrsm]?|gesamte[nrsm]?|alle[sn]?|komplett\w*|repo|repository|project|projekt|folder|ordner|directory|verzeichnis|codebase|code base|config(?:uration)?s?|konfiguration|setup|installation|home ?assistant)\b/u;
const PATH_TOKEN = /(?:^|[\s"'`(])(?:[\w.-]+\/)+[\w.-]+|(?:^|[\s"'`(])[\w-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|ya?ml|json|md|go|rs|java|kt|cs|rb|php|toml|ini|cfg|conf|sh|ps1|sql|html|css)\b/u;
/** v0.3: asks whether something holds (English and German, transliterated). */
const VERIFY = /\b(?:whether|really|actually|truly|verify|confirm|double[- ]?check|is (?:it|that|this) (?:true|correct|right|real)|(?:real|genuine|actual) (?:bug|issue|problem|error)|wirklich|tatsaechlich|stimmt (?:das|es)|ob (?:das|es|dies\w*))\b/u;
const LOCATE = /\bwhere (?:is|are|do|does|did)\b|\bwhich file\b|\btrace\b|\bwo (?:ist|sind|wird|werden)\b|\bin welche[rm]? datei\b/u;
/** v0.4: asks for the cause of a failure (English and German, transliterated). */
const DIAGNOSIS = /\bwhy (?:does|do|did|is|are|was|were|isn'?t|aren'?t|doesn'?t|don'?t|won'?t|can'?t)\b.{0,80}\b(?:fail\w*|break\w*|broke|broken|crash\w*|errors?|throw\w*|reject\w*|refus\w*|not work\w*|wrong|hang\w*|time ?out\w*)\b|\bwhat (?:causes|caused|is causing)\b|\broot[- ]cause\b|\bdebug\b|\bdiagnose\b|\bwarum (?:schlaegt|scheitert|geht|funktioniert|stuerzt|bricht|kommt)\b.{0,80}\b(?:fehl\w*|nicht|ab|kaputt|fehler\w*)\b|\bworan liegt (?:es|das)\b|\bfehlerursache\b/u;
/** v0.4: a claim the user states to check. Matched on the line as typed (the claim keeps its own spelling). */
const CLAIM_CLAUSE = /\b(?:is it (?:true|correct|right|the case)|is it really (?:true|the case)) that\s+(.+?)[\s?.!]*$|\b(?:check|verify|confirm|double[- ]?check) (?:whether|if|that)\s+(.+?)[\s?.!]*$|\bstimmt es,? dass\s+(.+?)[\s?.!]*$|\b(?:pr(?:ü|ue)fe?|ueberpr(?:ü|ue)fe?|überprüfe?),? ob\s+(.+?)[\s?.!]*$/iu;

const ORDINALS: ReadonlyArray<readonly [RegExp, number]> = [
  [/\b(?:first|1st|erste[nrsm]?)\b/u, 0], [/\b(?:second|2nd|zweite[nrsm]?)\b/u, 1], [/\b(?:third|3rd|dritte[nrsm]?)\b/u, 2],
  [/\b(?:fourth|4th|vierte[nrsm]?)\b/u, 3], [/\b(?:fifth|5th|fuenfte[nrsm]?)\b/u, 4], [/\b(?:last|letzte[nrsm]?)\b/u, -1],
];
const NUMBERED = /(?:#|\b(?:number|no\.?|nr\.?|finding|issue|problem|point|punkt|befund)\s*#?)\s*(\d{1,2})\b/u;
const ALL = /\b(?:all of them|them all|all (?:of )?(?:the )?(?:findings|issues|problems|of these|of those)|each of them|everything you found|them|alle(?: davon| probleme| fehler)?|sie alle|alles davon|die alle)\b|^(?:fix|behebe?) (?:all|everything|alles|alle)\b/u;
const PREVIOUS = /\b(?:it|that|this|those|these|the (?:issue|problem|finding|fix|change|suggestion|proposal|bug|error)|es|das|dies\w*|das problem|den fehler|den vorschlag)\b/u;

function referenceOf(text: string): IntentReference | undefined {
  const numbered = NUMBERED.exec(text);
  if (numbered !== null) return { kind: "index", index: Math.max(0, Number(numbered[1]) - 1) };
  for (const [pattern, index] of ORDINALS) if (pattern.test(text)) return { kind: "index", index };
  if (ALL.test(text)) return { kind: "all" };
  if (PREVIOUS.test(text)) return { kind: "previous" };
  return undefined;
}

/** v0.4: the claim clause of a line that states one to check, or undefined. */
export function claimClause(text: string): string | undefined {
  const match = CLAIM_CLAUSE.exec(text);
  const clause = match?.slice(1).find(group => group !== undefined)?.trim();
  return clause === undefined || clause.length < 3 ? undefined : clause.slice(0, 300);
}

/** The host's classification of one typed line. Pure and deterministic; no model is involved. */
export function classifyIntent(input: string): TurnIntent {
  const intent = classifyLine(input);
  if (grantFor(intent.kind).providers !== "readOnly" || grantFor(intent.kind).mutation !== "never" || intent.kind === "plan") return intent;
  const lower = normalize(intent.text);
  const diagnosis = DIAGNOSIS.test(lower);
  // A stated claim is the user's own only when the claim itself refers to no earlier finding (no pronoun, position or "all").
  const clause = claimClause(intent.text);
  const own = clause !== undefined && referenceOf(normalize(clause)) === undefined ? clause : undefined;
  if (!diagnosis && own === undefined) return intent;
  const { reference: _reference, ...rest } = intent;
  return Object.freeze({ ...(own === undefined ? intent : rest), ...(own === undefined ? {} : { claim: own }), ...(diagnosis ? { diagnosis: true } : {}) });
}

function classifyLine(input: string): TurnIntent {
  const text = (typeof input === "string" ? input : "").replace(ANSI, "").replace(CONTROL, "").trim().slice(0, MAX_INTENT_CHARS);
  const lower = normalize(text);
  const bare = lower.replace(/[\s.!?]+$/u, "");
  const make = (kind: IntentKind, reason: string, extra: Readonly<{ broad?: boolean; reference?: IntentReference | undefined; verification?: boolean }> = {}): TurnIntent =>
    Object.freeze({ kind, text, broad: extra.broad ?? false, ...(extra.reference ? { reference: extra.reference } : {}),
      ...(extra.verification === true ? { verification: true } : {}), reason });
  const verification = VERIFY.test(lower);
  if (lower === "?" || HELP.test(bare)) return make("help", "a help request");
  if (bare.length === 0) return make("empty", "nothing was typed");
  if (EXIT.test(bare)) return make("exit", "an exit request");
  const asksWhy = /^(?:why|warum|wieso|weshalb)\b/u.test(lower);
  if (!asksWhy && BYPASS.some(pattern => pattern.test(lower))) return make("bypass", "asks to leave out Fusion's safety gates");
  if (HISTORY.test(bare)) return make("history", "asks for runs and deliveries");
  if (UNDO.test(lower)) return make("undo", "asks to undo changes");
  if (DESTRUCTIVE.test(lower)) return make("clarify", "an unbounded destructive request");
  const plainQuestion = (QUESTION_START.test(lower) || /\?\s*$/u.test(lower)) && !POLITE_QUESTION.test(lower);
  if (!plainQuestion && CREATE.test(lower)) return make("create", "asks for a new project");
  if (((!plainQuestion && CHANGE.test(lower)) || (GO_AHEAD.test(lower) && !/\?\s*$/u.test(lower))) && !NARRATIVE.test(lower))
    return make("change", "an imperative change request", { reference: referenceOf(lower) });
  if (PLAN.test(lower)) return make("plan", "asks what should change (no change yet)", { reference: referenceOf(lower) });
  if (ANALYSIS.test(lower) && !PATH_TOKEN.test(text))
    return make("analysis", "asks for an analysis", { broad: BROAD.test(lower) || !NARROW.test(lower),
      ...(verification ? { verification, reference: referenceOf(lower) } : {}) });
  if (PATH_TOKEN.test(text) || LOCATE.test(lower) || ANALYSIS.test(lower))
    return make("investigation", "asks about specific files or places", { reference: referenceOf(lower), verification });
  return make("conversation", "conversation or explanation", { reference: referenceOf(lower), verification });
}
