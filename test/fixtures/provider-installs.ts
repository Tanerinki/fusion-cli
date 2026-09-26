import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { copyFile, link, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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

/**
 * A user-owned copy of node that fake installs hard-link to, made once per node build and shared by every test process.
 * A hard link to the system-owned node is refused on Windows, and a copy per install (tens of MiB each, many in parallel)
 * can exhaust a nearly full disk. The copy is written under a temporary name and moved into place atomically.
 */
async function linkableNode(): Promise<string> {
  const info = await stat(process.execPath);
  const shared = join(tmpdir(), `fusion-test-node-${info.size}-${Math.trunc(info.mtimeMs)}.exe`);
  try { if ((await stat(shared)).size === info.size) return shared; } catch { /* not made yet */ }
  const temporary = `${shared}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  await copyFile(process.execPath, temporary);
  try { await rename(temporary, shared); } catch { await rm(temporary, { force: true }); }
  return shared;
}
/**
 * Node under a versioned executable name: a hard link to node itself, else to the shared copy, else a copy. An existing
 * node under that name is kept as it is; anything else there is removed first — never written into, because it may be a
 * link to the shared copy that other tests are running.
 */
async function placeNode(exe: string): Promise<void> {
  const size = (await stat(process.execPath)).size;
  try { if ((await stat(exe)).size === size) return; await rm(exe, { force: true }); } catch { /* absent */ }
  try { await link(process.execPath, exe); return; } catch { /* system-owned: link to the shared copy */ }
  try { await link(await linkableNode(), exe); return; } catch { /* no hard links here */ }
  await copyFile(process.execPath, exe);
}

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
    await placeNode(museExe);
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
/**
 * Select a release that a test only RESOLVES and never starts (a preflight block): a tiny placeholder under the versioned
 * name instead of a copy of node, so heavy parallel suites do not fill the disk. Resolution checks the path only.
 */
export async function selectUnstartedMuseVersion(i: Installs, version: string): Promise<void> {
  await writeFile(join(i.museDir, ".muse-version"), version);
  await writeFile(join(i.museDir, `muse-bin-${version}.exe`), "placeholder: resolved by a preflight, never started\n");
}
export async function installMuseVersion(i: Installs, version: string): Promise<void> {
  await writeFile(join(i.museDir, ".muse-version"), version);
  const exe = join(i.museDir, `muse-bin-${version}.exe`);
  await placeNode(exe);
}
