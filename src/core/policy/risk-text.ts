import { failWith } from "../errors.js";
import { riskRank, type RiskLevel, type RiskSignal } from "./risk.js";

/**
 * Bounds for any text that can steer a role. Text beyond them is refused as invalid input: a security scan of
 * a prefix would silently ignore instructions placed after it.
 */
export const RISK_TEXT_LIMITS = Object.freeze({ maxChars: 16_384, maxItems: 2_000, maxTotalChars: 1_048_576 });

export type RiskTextOrigin = "task" | "delegation";
export interface RiskTextScan {
  /** Sorted, distinct intent codes, e.g. `forcePush`. */
  readonly codes: readonly string[];
  /** One `<code>Requested` signal per code at its highest implied level. */
  readonly signals: readonly RiskSignal[];
}

/** Natural-language intents. Matching can only escalate; absence proves nothing. */
const PHRASES: ReadonlyArray<readonly [string, RegExp, RiskLevel]> = [
  ["forcePush", /\bforce[- ]?push/u, "critical"],
  ["hardReset", /\breset\s+--hard\b/u, "critical"],
  ["historyRewrite", /rewrite\s+(?:the\s+)?(?:git\s+)?history|\bfilter-(?:branch|repo)\b|\brebase\s+(?:-i\b|--interactive\b|(?:--)?onto\b)/u, "critical"],
  ["recursiveDelete", /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\brmdir\s+\/s|\b(?:del|rd)\s+\/s\b|remove-item\b.*-recurse/u, "critical"],
  ["dataDestruction", /\b(?:drop|truncate)\s+(?:table|database|schema)\b|\bdelete\s+from\b|\bwipe\b|\bpurge\b/u, "critical"],
  ["production", /\b(?:deploy|publish|release)\b.*\b(?:prod|production|registry|live)\b|\bnpm\s+publish\b/u, "critical"],
  ["credentialHandling", /\b(?:rotate|revoke|leak|exfiltrate|print|dump)\b.*\b(?:secret|token|credential|password|api\s*key)s?\b/u, "high"],
  ["remoteBranchDeletion", /\bdelet\w*\b[^.;\n]*\b(?:remote|origin|upstream)\b[^.;\n]*\bbranch(?:es)?\b|\bdelet\w*\b[^.;\n]*\bbranch(?:es)?\b[^.;\n]*\b(?:on|from|at)\s+(?:the\s+)?(?:remote|origin|upstream)\b/u, "critical"],
  ["discardChanges", /\b(?:discard|throw\s+away)\s+(?:all\s+)?(?:of\s+)?(?:the\s+)?(?:(?:local|uncommitted|unstaged|working[- ]tree)\s+)+changes\b/u, "critical"],
  ["stashDrop", /\b(?:drop|clear)\s+(?:the\s+|all\s+)?(?:git\s+)?stash(?:es)?\b/u, "critical"],
];

/** Git subcommands whose options can destroy work, rewrite history or leave the machine. */
const SUBCOMMANDS = new Set(["push", "branch", "checkout", "restore", "stash", "reset", "clean", "rebase", "filter-branch",
  "filter-repo", "reflog", "gc", "update-ref", "tag", "worktree"]);
const GLOBAL_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path",
  "--config-env", "--super-prefix"]);
/**
 * Command boundaries: shell separators, substitutions and sentence ends. A full stop ends a sentence only when it
 * follows a word character, so a standalone `.` (as in `checkout .`) stays an argument.
 */
const SEGMENT_BREAK = /[;&|\n\r`]+|\$\(|\)|(?<=[^\s.])\.(?=\s|$)/u;

const clean = (token: string): string => token.replace(/^[("'“‘\[]+/u, "").replace(/(?<=.)[)"'”’\],;!?]+$/u, "");
const isGit = (token: string): boolean => /^(?:.*[\\/])?git(?:\.exe)?$/iu.test(token);
const shortCluster = (arg: string): boolean => /^-[A-Za-z]+$/u.test(arg);
const hasShort = (args: readonly string[], letter: string): boolean => args.some(a => shortCluster(a) && a.slice(1).includes(letter));
const hasLong = (args: readonly string[], ...names: string[]): boolean =>
  args.some(a => names.some(name => a === name || a.startsWith(`${name}=`)));
const positionals = (args: readonly string[]): string[] => args.filter(a => !a.startsWith("-"));
/** Without a literal `git`, a subcommand counts only when its arguments look like Git syntax. */
function gitLike(sub: string, args: readonly string[]): boolean {
  const first = positionals(args)[0]?.toLowerCase();
  if (sub === "filter-branch" || sub === "filter-repo") return true;
  if (sub === "stash") return first === "drop" || first === "clear";
  if (sub === "reflog") return first === "expire" || first === "delete";
  return args.some(a => a.startsWith("-") || a.startsWith("+") || a === "." || /^:[^\s:]+$/u.test(a) || /^[^\s:]+:[^\s:]+$/u.test(a));
}

function* invocations(segment: string): Generator<{ sub: string; args: string[] }> {
  const tokens = segment.split(/\s+/u).map(clean).filter(token => token.length > 0);
  for (let i = 0; i < tokens.length; i++) {
    let j = i;
    const explicit = isGit(tokens[i]!);
    if (explicit) {
      j = i + 1;
      while (j < tokens.length && tokens[j]!.startsWith("-")) j += GLOBAL_OPTIONS_WITH_VALUE.has(tokens[j]!) ? 2 : 1;
    }
    const sub = tokens[j]?.toLowerCase();
    if (sub === undefined || !SUBCOMMANDS.has(sub)) continue;
    const rest = tokens.slice(j + 1);
    const next = rest.findIndex(isGit);
    const args = next >= 0 ? rest.slice(0, next) : rest;
    if (explicit || gitLike(sub, args)) yield { sub, args };
    if (explicit) i = j;
  }
}

/** Token-aware reading of Git invocations, so flag order, clusters and refspec forms cannot hide intent. */
function gitIntents(text: string): Array<readonly [string, RiskLevel]> {
  const found: Array<readonly [string, RiskLevel]> = [];
  for (const segment of text.split(SEGMENT_BREAK)) for (const { sub, args } of invocations(segment)) {
    const pos = positionals(args), first = pos[0]?.toLowerCase();
    switch (sub) {
      case "push":
        found.push(["remotePush", "critical"]);
        if (hasShort(args, "f") || hasLong(args, "--force", "--force-with-lease", "--force-if-includes") || pos.some(r => r.startsWith("+")))
          found.push(["forcePush", "critical"]);
        if (hasShort(args, "d") || hasLong(args, "--delete", "--prune", "--mirror") || pos.some(r => r.startsWith(":")))
          found.push(["remoteBranchDeletion", "critical"]);
        break;
      case "branch": {
        const deletes = hasShort(args, "d") || hasShort(args, "D") || hasLong(args, "--delete");
        const forced = hasShort(args, "f") || hasLong(args, "--force");
        if (hasShort(args, "D") || (deletes && forced)) found.push(["branchForceDelete", "critical"]);
        else if (deletes) found.push(["branchDeletion", "high"]);
        if ((forced && !deletes) || hasShort(args, "M") || hasShort(args, "C")) found.push(["branchOverwrite", "critical"]);
        break;
      }
      case "checkout":
        if (args.includes("--") || args.includes(".") || hasShort(args, "f") || hasLong(args, "--force"))
          found.push(["discardChanges", "critical"]);
        if (hasShort(args, "B")) found.push(["branchOverwrite", "critical"]);
        break;
      case "restore": {
        const stagedOnly = (hasLong(args, "--staged") || hasShort(args, "S")) && !(hasLong(args, "--worktree") || hasShort(args, "W"));
        if (!stagedOnly) found.push(["discardChanges", "critical"]);
        break;
      }
      case "stash": if (first === "drop" || first === "clear") found.push(["stashDrop", "critical"]); break;
      case "reset": if (hasLong(args, "--hard")) found.push(["hardReset", "critical"]); break;
      case "clean": if (hasShort(args, "f") || hasLong(args, "--force")) found.push(["gitClean", "critical"]); break;
      case "rebase":
        found.push(hasShort(args, "i") || hasLong(args, "--interactive", "--onto", "--root")
          ? ["historyRewrite", "critical"] : ["rebase", "high"]);
        break;
      case "filter-branch": case "filter-repo": found.push(["historyRewrite", "critical"]); break;
      case "reflog": if (first === "expire" || first === "delete") found.push(["recoveryDestruction", "critical"]); break;
      case "gc": if (hasLong(args, "--prune")) found.push(["recoveryDestruction", "critical"]); break;
      case "update-ref": if (hasShort(args, "d") || hasLong(args, "--delete")) found.push(["refRewrite", "high"]); break;
      case "tag": if (hasShort(args, "d") || hasShort(args, "f") || hasLong(args, "--delete", "--force")) found.push(["refRewrite", "high"]); break;
      case "worktree": if (first === "remove" || first === "prune") found.push(["worktreeRemoval", "high"]); break;
    }
  }
  return found;
}

/**
 * The one scan for text that can steer a role: task summaries and every delegated packet field. Input beyond
 * `RISK_TEXT_LIMITS` is `InvalidInput`; nothing is scanned partially. Deterministic; only ever raises risk.
 */
export function scanRiskText(texts: readonly string[], origin: RiskTextOrigin): RiskTextScan {
  if (!Array.isArray(texts) || texts.length > RISK_TEXT_LIMITS.maxItems)
    failWith("InvalidInput", "Risk-relevant text has too many parts.");
  let total = 0;
  for (const text of texts) {
    if (typeof text !== "string" || text.includes("\0") || text.length > RISK_TEXT_LIMITS.maxChars)
      failWith("InvalidInput", `Risk-relevant text must be a string of at most ${RISK_TEXT_LIMITS.maxChars} characters.`);
    total += text.length;
  }
  if (total > RISK_TEXT_LIMITS.maxTotalChars) failWith("InvalidInput", "Risk-relevant text exceeds its total size limit.");
  const levels = new Map<string, RiskLevel>();
  const record = (code: string, level: RiskLevel): void => {
    const previous = levels.get(code);
    if (previous === undefined || riskRank(level) > riskRank(previous)) levels.set(code, level);
  };
  for (const text of texts) {
    const lower = text.toLowerCase().replace(/\s+/gu, " ");
    for (const [code, pattern, level] of PHRASES) if (pattern.test(lower)) record(code, level);
    for (const [code, level] of gitIntents(text)) record(code, level);
  }
  const codes = [...levels.keys()].sort();
  const where = origin === "task" ? "request text" : "delegated text";
  return Object.freeze({ codes: Object.freeze(codes), signals: Object.freeze(codes.map(code => Object.freeze({
    code: `${code}Requested`, level: levels.get(code)!, source: "task" as const, evidence: `${where} mentions ${code}` }))) });
}
