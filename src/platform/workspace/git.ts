import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failWith } from "../../core/errors.js";
import { containsNul, resolveExecutableOnPath } from "../process/native-executable.js";
import { ProcessSupervisor, type ProcessOutcome } from "../process/supervisor.js";

export interface GitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}
export interface GitRunOptions {
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxStdoutBytes?: number;
}
/** The only way Fusion invokes Git: an executable plus an argv array, never a shell string. */
export interface GitClient {
  run(args: readonly string[], options: GitRunOptions): Promise<GitResult>;
}

export const GIT_DEFAULT_TIMEOUT_MS = 60_000;
export const GIT_MAX_STDOUT_BYTES = 32 * 1024 * 1024;

/**
 * Inherited `GIT_*` variables can redirect Git to another repository, index, object store or config
 * (`GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*`), so none are forwarded. Prompts are disabled
 * and optional locks are off, so read-only commands never rewrite the primary workspace's index.
 */
export function gitEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || /^GIT_/iu.test(key)) continue;
    env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

export class ProcessGitClient implements GitClient {
  readonly #env: NodeJS.ProcessEnv;
  /**
   * Per-invocation overrides; no configuration file is modified. Hooks point at a directory that does not
   * exist, so repository hooks never run for Fusion's own Git operations, and fsmonitor cannot spawn helpers.
   */
  readonly #fixedArgs: readonly string[];

  constructor(readonly executable: string, source: NodeJS.ProcessEnv = process.env,
    private readonly supervisor = new ProcessSupervisor()) {
    this.#env = gitEnvironment(source);
    const noHooks = join(tmpdir(), `fusion-no-hooks-${randomBytes(12).toString("hex")}`);
    this.#fixedArgs = ["-c", `core.hooksPath=${noHooks}`, "-c", "core.fsmonitor=false", "-c", "core.quotePath=false",
      "-c", "color.ui=false", "--no-pager"];
  }

  static async fromPath(env: NodeJS.ProcessEnv = process.env): Promise<ProcessGitClient> {
    const executable = await resolveExecutableOnPath("git", env);
    if (!executable) failWith("SpawnFailure", "No native git executable was found on PATH.");
    return new ProcessGitClient(executable, env);
  }

  async run(args: readonly string[], options: GitRunOptions): Promise<GitResult> {
    if (!Array.isArray(args) || !args.every(arg => typeof arg === "string" && !containsNul(arg)))
      failWith("InvalidInput", "Git arguments must be strings without NUL.");
    let outcome: ProcessOutcome;
    try {
      outcome = await this.supervisor.start({ executable: this.executable, args: [...this.#fixedArgs, ...args],
        cwd: options.cwd, env: this.#env, timeoutMs: options.timeoutMs ?? GIT_DEFAULT_TIMEOUT_MS,
        maxStdoutBytes: options.maxStdoutBytes ?? GIT_MAX_STDOUT_BYTES, maxStderrBytes: 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}) }).result;
    } catch (error) {
      failWith("InvalidInput", "Git could not be launched with the given working directory or arguments.", false, error);
    }
    if (outcome.issue?.kind === "Cancelled") failWith("Cancelled", "Git operation was cancelled.");
    if (outcome.issue?.kind === "Timeout") failWith("Timeout", "Git operation timed out.", true);
    if (outcome.issue?.kind === "SpawnFailure") failWith("SpawnFailure", "Git could not start.", true);
    if (outcome.issue?.kind === "OutputLimit") failWith("ProtocolError", "Git output exceeded Fusion's size limit.");
    if (outcome.issue) failWith("ProcessFailure", "Git output streams failed.");
    return { exitCode: outcome.exitCode, stdout: outcome.stdout, stderr: outcome.stderr };
  }
}

/** Runs Git and requires exit 0; stderr is never copied into the failure message. */
export async function gitOk(git: GitClient, args: readonly string[], options: GitRunOptions, what: string): Promise<string> {
  const result = await git.run(args, options);
  if (result.exitCode !== 0) failWith("ProcessFailure", `Git could not ${what}.`);
  return result.stdout;
}

/** Git reports paths with forward slashes; compare paths case- and separator-insensitively on Windows. */
export function comparablePath(path: string, platform = process.platform): string {
  let value = path.trim();
  if (platform === "win32") {
    value = value.replace(/\//gu, "\\");
    if (value.startsWith("\\\\?\\UNC\\")) value = `\\\\${value.slice(8)}`;
    else if (value.startsWith("\\\\?\\")) value = value.slice(4);
    value = value.replace(/\\+$/u, "").toLowerCase();
  } else value = value.replace(/\/+$/u, "");
  return value;
}

export interface WorktreeEntry {
  readonly path: string;
  readonly head: string | null;
  readonly locked: boolean;
  readonly prunable: boolean;
}
/** Parses `git worktree list --porcelain -z`. */
export function parseWorktreeList(stdout: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; head?: string; locked: boolean; prunable: boolean } = { locked: false, prunable: false };
  const flush = (): void => {
    if (current.path !== undefined) entries.push({ path: current.path, head: current.head ?? null,
      locked: current.locked, prunable: current.prunable });
    current = { locked: false, prunable: false };
  };
  for (const field of stdout.split("\0")) {
    if (field === "") { flush(); continue; }
    if (field.startsWith("worktree ")) { flush(); current.path = field.slice(9); }
    else if (field.startsWith("HEAD ")) current.head = field.slice(5);
    else if (field === "locked" || field.startsWith("locked ")) current.locked = true;
    else if (field === "prunable" || field.startsWith("prunable ")) current.prunable = true;
  }
  flush();
  return entries;
}
