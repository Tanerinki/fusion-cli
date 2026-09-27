/**
 * Deterministic argv parsing. Arguments are data: nothing is evaluated by a shell, expanded or globbed. Unknown,
 * duplicate, conflicting or malformed flags are usage errors (exit 2), never ignored.
 */
export const COMMANDS = ["doctor", "review", "audit", "build", "show", "inspect-delivery", "approve-delivery", "apply", "chat", "analyze", "create", "history", "config"] as const;
export type CommandName = (typeof COMMANDS)[number];
export const OPERATIONS = ["read", "analyze", "review", "test", "edit", "implement", "refactor", "configure", "delete", "migrate",
  "release"] as const;

export class UsageError extends Error {
  constructor(readonly safeMessage: string, readonly command?: CommandName) { super(safeMessage); this.name = "UsageError"; }
}

export interface ParsedArgs {
  readonly command?: CommandName;
  readonly help: boolean;
  readonly version: boolean;
  readonly json: boolean;
  readonly debug: boolean;
  readonly config?: string;
  readonly cwd?: string;
  readonly probe: boolean;
  readonly base?: string;
  readonly verify: boolean;
  readonly timeoutSeconds?: number;
  readonly paths: readonly string[];
  readonly operation?: string;
  /** v0.1 `analyze`: larger bounds (never more rights), a focus topic, inventory only (no provider). */
  readonly deep: boolean;
  readonly focus?: string;
  readonly inventoryOnly: boolean;
  /** v0.1 `chat` / `analyze`: the conversation partner (a role such as `reviewer`, or a provider id). */
  readonly with?: string;
  /** v0.1 `create`: the project family and the project (directory) name. */
  readonly template?: string;
  readonly name?: string;
  /** v0.1 `history`: how many runs to list. */
  readonly limit?: number;
  readonly positionals: readonly string[];
}

type FlagSpec = Readonly<{ value: boolean; repeatable?: boolean; commands?: readonly CommandName[] }>;
const FLAGS: Readonly<Record<string, FlagSpec>> = {
  "--help": { value: false }, "--version": { value: false }, "--json": { value: false }, "--debug": { value: false },
  "--config": { value: true }, "--cwd": { value: true },
  "--probe": { value: false, commands: ["doctor"] },
  "--base": { value: true, commands: ["review"] }, "--no-verify": { value: false, commands: ["review"] },
  "--timeout": { value: true, commands: ["review", "build"] },
  "--path": { value: true, repeatable: true, commands: ["build"] }, "--operation": { value: true, commands: ["build"] },
  "--deep": { value: false, commands: ["analyze"] }, "--focus": { value: true, commands: ["analyze"] },
  "--inventory-only": { value: false, commands: ["analyze"] }, "--with": { value: true, commands: ["chat", "analyze"] },
  "--template": { value: true, commands: ["create"] }, "--name": { value: true, commands: ["create"] },
  "--limit": { value: true, commands: ["history"] },
};
const SHORT: Readonly<Record<string, string>> = { "-h": "--help", "-V": "--version" };
const DELIVERY_COMMANDS: readonly CommandName[] = ["inspect-delivery", "approve-delivery", "apply"];
const MAX_ARGS = 256, MAX_ARG_LENGTH = 32 * 1024, MAX_PATHS = 1_000;

export function parseArgs(argv: readonly string[]): ParsedArgs {
  if (!Array.isArray(argv) || argv.length > MAX_ARGS) throw new UsageError("Too many arguments.");
  let command: CommandName | undefined;
  const seen = new Map<string, string[]>();
  const positionals: string[] = [];
  let endOfOptions = false;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (typeof token !== "string" || token.length > MAX_ARG_LENGTH || token.includes("\0"))
      throw new UsageError("An argument is too long or contains NUL.");
    if (!endOfOptions && token === "--") { endOfOptions = true; continue; }
    if (!endOfOptions && token.startsWith("-") && token !== "-") {
      const eq = token.indexOf("=");
      const rawName = eq > 0 ? token.slice(0, eq) : token;
      const name = SHORT[rawName] ?? rawName;
      const spec = FLAGS[name];
      if (spec === undefined)
        throw new UsageError(`Unknown option ${JSON.stringify(rawName)}. A task that starts with "-" must follow "--".`, command);
      if (spec.commands !== undefined && (command === undefined || !spec.commands.includes(command)))
        throw new UsageError(`Option ${name} is not valid ${command === undefined ? "before a command" : `for ${command}`}.`, command);
      let value = "";
      if (spec.value) {
        if (eq > 0) value = token.slice(eq + 1);
        else {
          const next = argv[i + 1];
          if (next === undefined || (next.startsWith("-") && next !== "-")) throw new UsageError(`Option ${name} needs a value.`, command);
          value = next; i++;
        }
        if (value.length === 0) throw new UsageError(`Option ${name} needs a non-empty value.`, command);
      } else if (eq > 0) throw new UsageError(`Option ${name} does not take a value.`, command);
      const values = seen.get(name) ?? [];
      if (values.length > 0 && spec.repeatable !== true) throw new UsageError(`Option ${name} was given more than once.`, command);
      values.push(value);
      seen.set(name, values);
      continue;
    }
    if (command === undefined && !endOfOptions) {
      if (!(COMMANDS as readonly string[]).includes(token)) throw new UsageError(`Unknown command ${JSON.stringify(token.slice(0, 64))}.`);
      command = token as CommandName;
      continue;
    }
    if (command === undefined) throw new UsageError("A command must come before \"--\".");
    positionals.push(token);
  }
  const has = (name: string): boolean => seen.has(name);
  const one = (name: string): string | undefined => seen.get(name)?.[0];
  const help = has("--help"), version = has("--version");
  if (version && (command !== undefined || help)) throw new UsageError("--version cannot be combined with a command or --help.");
  // v0.2: no command is the conversational shell (the CLI decides whether a terminal allows it).
  if (!help && !version && command !== undefined) {
    const expected = command === "build" || command === "show" || command === "create" || DELIVERY_COMMANDS.includes(command) ? 1 : 0;
    // v0.1: `chat` takes an optional one-shot message, `analyze` an optional repository path.
    const optionalOne = command === "chat" || command === "analyze";
    if (optionalOne ? positionals.length > 1 : positionals.length !== expected)
      throw new UsageError(command === "build" ? "build takes exactly one task; quote it, and put it after \"--\" if it starts with \"-\"."
        : command === "create" ? "create takes exactly one project description; quote it."
        : command === "show" ? "show takes exactly one run ID." : DELIVERY_COMMANDS.includes(command) ? `${command} takes exactly one delivery ID.`
        : command === "chat" ? "chat takes at most one message; quote it, and put it after \"--\" if it starts with \"-\"."
        : command === "analyze" ? "analyze takes at most one repository path."
        : `${command} takes no positional arguments.`, command);
    if (command === "approve-delivery" && has("--json"))
      throw new UsageError("approve-delivery is interactive only (a human types the manifest digest); --json is not accepted.", command);
    if (command === "create" && has("--json"))
      throw new UsageError("create is interactive only (you confirm the project and its build); --json is not accepted.", command);
  }
  let timeoutSeconds: number | undefined;
  if (has("--timeout")) {
    const raw = one("--timeout")!;
    if (!/^[0-9]{1,6}$/u.test(raw) || Number(raw) < 1 || Number(raw) > 86_400)
      throw new UsageError("--timeout must be a whole number of seconds from 1 to 86400.", command);
    timeoutSeconds = Number(raw);
  }
  const operation = one("--operation");
  if (operation !== undefined && !(OPERATIONS as readonly string[]).includes(operation))
    throw new UsageError(`--operation must be one of ${OPERATIONS.join(", ")}.`, command);
  let limit: number | undefined;
  if (has("--limit")) {
    const raw = one("--limit")!;
    if (!/^[0-9]{1,3}$/u.test(raw) || Number(raw) < 1 || Number(raw) > 50) throw new UsageError("--limit must be a whole number from 1 to 50.", command);
    limit = Number(raw);
  }
  const paths = seen.get("--path") ?? [];
  if (paths.length > MAX_PATHS) throw new UsageError("Too many --path options.", command);
  return { ...(command === undefined ? {} : { command }), help, version, json: has("--json"), debug: has("--debug"),
    ...(one("--config") === undefined ? {} : { config: one("--config")! }), ...(one("--cwd") === undefined ? {} : { cwd: one("--cwd")! }),
    probe: has("--probe"), ...(one("--base") === undefined ? {} : { base: one("--base")! }), verify: !has("--no-verify"),
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }), paths, ...(operation === undefined ? {} : { operation }),
    deep: has("--deep"), ...(one("--focus") === undefined ? {} : { focus: one("--focus")! }), inventoryOnly: has("--inventory-only"),
    ...(one("--with") === undefined ? {} : { with: one("--with")! }), ...(one("--template") === undefined ? {} : { template: one("--template")! }),
    ...(one("--name") === undefined ? {} : { name: one("--name")! }), ...(limit === undefined ? {} : { limit }), positionals };
}

const GLOBAL = "fusion [--json] [--debug] [--config <file>] [--cwd <dir>]";
/** One help entry per command: its synopsis line and description (also printed by `fusion <command> --help`). */
const HELP: readonly Readonly<{ group: string; command: CommandName; text: string }>[] = [
  { group: "Talk and look (read-only; nothing is changed):", command: "chat", text: `  chat [--with <partner>] [-- "<message>"]
                                   Conversation about the repository (REPL; one message when given).
                                   /help lists the commands; /ask <partner> gets a second opinion; /build starts a
                                   build only when you confirm it. The default partner is the lead
                                   (conversation.partner in fusion.config.json changes it).` },
  { group: "Talk and look (read-only; nothing is changed):", command: "analyze", text: `  analyze [<path>] [--deep] [--focus <topic>] [--inventory-only] [--with <partner>]
                                   Fusion's own inventory, then one model analysis in a read-only view.
                                   --deep raises the bounds (never the rights); --inventory-only runs no provider.` },
  { group: "Talk and look (read-only; nothing is changed):", command: "review", text: `  review [--base <ref>] [--no-verify] [--timeout <s>]
                                   Fresh, read-only review of the working tree against HEAD (default) or the
                                   merge base of a local <ref>. Runs configured read-only verification unless
                                   --no-verify.` },
  { group: "Build and deliver:", command: "build", text: `  build [--path <p>]... [--operation <op>] [--timeout <s>] [--] "<task>"
                                   Shows the plan (risk, roles, verification and the exact files; without --path the
                                   lead proposes them) and starts only when you type "build": lead plan, Change
                                   Author proposal in a private candidate, confined verification, fresh review and
                                   correction. The result is a delivery; your working tree is not touched.` },
  { group: "Build and deliver:", command: "create", text: `  create [--template library|cli|api] [--name <dir>] [--] "<description>"
                                   A new Node.js/TypeScript project: after you type "create", Fusion writes a template
                                   with a Git baseline into a new directory, then runs the confirmed build there.` },
  { group: "Build and deliver:", command: "inspect-delivery", text: `  inspect-delivery <id>            Read-only view of a stored delivery: digests, target, diff, evidence, approval.` },
  { group: "Build and deliver:", command: "approve-delivery", text: `  approve-delivery <id>            Your approval of exactly one delivery: type its full manifest digest
                                   (interactive terminal only; nothing else approves).` },
  { group: "Build and deliver:", command: "apply", text: `  apply <id>                       Applies an approved delivery to this checkout after a read-only precheck, under
                                   one single-use claim; a failure rolls back. Fusion never commits or pushes.` },
  { group: "History and setup:", command: "history", text: `  history [--limit <n>]            Recent runs of this repository (newest first), their deliveries and the next step.` },
  { group: "History and setup:", command: "show", text: `  show <run-id>                    One recorded run, its delivery and the next step.` },
  { group: "History and setup:", command: "config", text: `  config                           The effective configuration: role models, conversation partner, verifier
                                   profile, run evidence and delivery store locations.` },
  { group: "History and setup:", command: "doctor", text: `  doctor [--probe]                 Read-only diagnostics: runtime, repository, storage, providers, readiness.
                                   --probe may start provider CLIs to read back auth and check their read-only
                                   posture (init-only startups; never inference).` },
  { group: "History and setup:", command: "audit", text: `  audit                            Deterministic, read-only audit of Fusion-relevant state and readiness blockers.` },
];
const OPTIONS = `Options:
  -h, --help       Show help (fusion <command> --help for one command).
  -V, --version    Show the version.
  --json           Machine-readable output (not for create and approve-delivery: they ask you).
  --debug          Add safe cause codes to errors.
  --config <file>  Use this configuration file instead of <repository>/fusion.config.json.
  --cwd <dir>      Run as if started in <dir>.`;
const EXIT_CODES_HELP = `Exit codes: 0 completed/answered/ready, 1 internal, 2 invalid input, 3 billing/auth, 4 security policy,
  5 capability unavailable, 6 provider failure, 7 timeout, 8 workspace conflict, 9 verification failed,
  10 storage, 11 blocked, 12 review required, 13 decision required, 14 human gate required,
  15 degraded (doctor), 130 cancelled. See README.md (Exit codes).`;

export const USAGE = `Usage: fusion                    Talk to Fusion about the project in this folder (interactive terminal).
                                 Plain words: "analyze this project", "explain the first finding",
                                 "what would you change?", "fix it". Read-only until you confirm a change.
       ${GLOBAL} <command> [options]

Expert commands:

${[...new Set(HELP.map(entry => entry.group))].map(group => `${group}\n${HELP.filter(entry => entry.group === group).map(entry => entry.text).join("\n")}`).join("\n\n")}

${OPTIONS}

${EXIT_CODES_HELP}
`;

/** `fusion <command> --help`: that command's entry, the options and the exit codes. */
export function commandHelp(command: CommandName): string {
  const entry = HELP.find(item => item.command === command);
  return entry === undefined ? USAGE : `Usage: ${GLOBAL}\n${entry.text}\n\n${OPTIONS}\n\n${EXIT_CODES_HELP}\n`;
}
