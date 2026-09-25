import assert from "node:assert/strict";
import { copyFile, link, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import type { RoleBinding } from "../../src/core/domain.js";
import type { ClaudeLaunchConfig } from "../../src/providers/claude/types.js";
import { VERIFIED_EXEC_WEB_DISABLE_VERSION, type MuseLaunchConfig } from "../../src/providers/muse/types.js";

/**
 * TEST-ONLY provider installs for the fake native processes: a Claude package layout whose metadata carries the
 * validated version (its `claude.exe` is an empty file, never executed) and a Muse binary directory whose versioned
 * executable is node itself under the verified name. The real adapter code launches `test/fixtures/*-fake.mjs`; with
 * `FUSION_FAKE_RECORD` set, every launched process appends its argv, working directory and environment KEY NAMES.
 */
export const CLAUDE_FIXTURE = resolve(process.cwd(), "test/fixtures/claude-fake.mjs");
export const MUSE_FIXTURE = resolve(process.cwd(), "test/fixtures/muse-fake.mjs");
export const EMPTY_HOME = resolve(process.cwd(), "test/fixtures/empty-claude-home");
export const claudeBinary = { executable: process.execPath, argvPrefix: [CLAUDE_FIXTURE] } as const;

export interface Installs { readonly dir: string; readonly claudeExe: string; readonly museDir: string; readonly museExe: string;
  readonly record: string }
export async function withInstalls<T>(run: (i: Installs) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-b8-installs-"));
  try {
    const pkg = join(dir, "claude-code");
    await mkdir(join(pkg, "bin"), { recursive: true });
    await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "@anthropic-ai/claude-code", version: "2.1.280" }));
    const claudeExe = join(pkg, "bin", "claude.exe");
    await writeFile(claudeExe, "");
    const museDir = join(dir, "muse");
    await mkdir(museDir);
    await writeFile(join(museDir, ".muse-version"), VERIFIED_EXEC_WEB_DISABLE_VERSION);
    const museExe = join(museDir, `muse-bin-${VERIFIED_EXEC_WEB_DISABLE_VERSION}.exe`);
    try { await link(process.execPath, museExe); } catch { await copyFile(process.execPath, museExe); }
    return await run({ dir, claudeExe, museDir, museExe, record: join(dir, "launches.jsonl") });
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
export const museBinary = (i: Installs) => ({ executable: i.museExe, argvPrefix: [MUSE_FIXTURE] }) as const;

export function claudeLaunch(i: Installs, primary: string, env: Readonly<Record<string, string>>,
  over: Partial<ClaudeLaunchConfig> = {}): ClaudeLaunchConfig {
  return { executablePath: i.claudeExe, workspace: primary, forbiddenWorkspaceRoots: [primary], requireSessionWorkspace: true,
    model: { id: "alias", effort: "low", maxTurns: 3 }, expectedCanonicalModel: "claude-canonical-fixture", posture: "readOnly",
    timeoutMs: 20_000, sourceEnvironment: { SystemRoot: process.env.SystemRoot ?? "", USERPROFILE: EMPTY_HOME, FUSION_FAKE_RECORD: i.record, ...env },
    ...over };
}
export function museLaunch(i: Installs, primary: string, env: Readonly<Record<string, string>>,
  over: Partial<MuseLaunchConfig> = {}): MuseLaunchConfig {
  return { binaryDirectory: i.museDir, versionFile: join(i.museDir, ".muse-version"), workspace: primary, forbiddenWorkspaceRoots: [primary],
    requireSessionWorkspace: true, provider: "meta", model: { id: "muse-spark-1.3", effort: "low" }, posture: "readOnly", maxModelSteps: 4,
    timeoutMs: 20_000, sourceEnvironment: { SystemRoot: process.env.SystemRoot ?? "", FUSION_FAKE_RECORD: i.record, ...env }, ...over };
}
export const claudeBindingFor = (role: RoleBinding["role"], config: ClaudeLaunchConfig): RoleBinding =>
  ({ role, provider: "claude", transport: "claude-one-shot", model: config.model, requires: {} });
export const museBindingFor = (role: RoleBinding["role"], config: MuseLaunchConfig, transport = "muse-exec"): RoleBinding =>
  ({ role, provider: config.provider, transport, model: config.model, requires: {} });

/** One recorded process launch by a fake provider binary. */
export interface Launch { readonly argv: readonly string[]; readonly cwd: string; readonly env: readonly string[] }
export async function launches(record: string): Promise<Launch[]> {
  let text = "";
  try { text = await readFile(record, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).map(line => JSON.parse(line) as Launch);
}
/**
 * O5.5B19: make the fake Muse install report another release (its version file and versioned executable), as the
 * machine's real install moved to 1.4.0-R4161.1 — an UNVALIDATED release for Fusion.
 */
export async function installMuseVersion(i: Installs, version: string): Promise<void> {
  await writeFile(join(i.museDir, ".muse-version"), version);
  const exe = join(i.museDir, `muse-bin-${version}.exe`);
  try { await link(process.execPath, exe); } catch { await copyFile(process.execPath, exe); }
}
