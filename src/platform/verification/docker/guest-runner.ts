/**
 * Fusion Docker guest runner (protocol 2). It runs INSIDE the container as an unprivileged user. It is not on any
 * mount: the fixed `node -e` bootstrap receives it over stdin (hash-pinned by the host), writes it with
 * `transfer-archive.js` into tmpfs and calls `runGuest`. It imports only Node built-ins and that archive reader (the
 * protocol import below is type-only and erased). Everything else also arrives over stdin: a hashed manifest frame,
 * then the input archives, which are extracted into container-local tmpfs BEFORE any repository code runs. The
 * manifest — and with it the run nonce — is never written to any filesystem. Modes:
 *   verify     — extract the candidate (+ an optional dependency archive) and run the host-fixed command list.
 *   canary     — Fusion-authored confinement probes; no repository code runs in this mode.
 *   descendant — start a marked sleeping child and wait, so the host can prove removal takes the child with it.
 *   deps       — dependency preparation: `npm ci --ignore-scripts` on the two manifests only, then stream the
 *                resulting node_modules back as a gzip-compressed FTA1 archive. No repository code is present.
 * (`hang` never reaches the runner: the bootstrap itself idles.)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, posix } from "node:path";
import { performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { constants as zlibConstants, createGunzip, createGzip } from "node:zlib";
import { ChunkReader, decodeArchive, encodeArchive, extractingSink, fileContent, planTree, rawArchiveCeiling,
  TransferArchiveError, type ArchiveLimits, type ArchiveStats } from "./transfer-archive.js";
import type { CanaryManifest, CanaryResult, DependencyManifest, DependencyResult, DescendantManifest, GuestCommand,
  GuestCommandResult, GuestManifest, GuestRuntime, InputPart, VerifyManifest, VerifyResult } from "./protocol.js";

const WORK = "/fusion/work", SOURCE = `${WORK}/src`, DEPS = `${WORK}/deps`, HOME = `${WORK}/home`;
const NPM_CLI = "/usr/local/lib/node_modules/npm/bin/npm-cli.js", NODE = "/usr/local/bin/node";
const FOREVER = 2 ** 30;
const MANIFEST_MAGIC = "FUSIONM1";
const MAX_MANIFEST_BYTES = 1024 * 1024;

class RunnerError extends Error {
  constructor(readonly code: string) { super(code); }
}

function emitLine(line: string, exitCode: number): void {
  process.stdout.write(`${line}\n`, () => process.exit(exitCode));
}
const runtime = (): GuestRuntime => ({ node: process.version, platform: process.platform, arch: process.arch });

/** Keeps only the last `limit` bytes of a stream. */
class Tail {
  #chunks: Buffer[] = [];
  #held = 0;
  total = 0;
  constructor(private readonly limit: number) {}
  push(chunk: Buffer): void {
    this.total += chunk.length;
    this.#chunks.push(chunk);
    this.#held += chunk.length;
    while (this.#held - (this.#chunks[0]?.length ?? 0) >= this.limit && this.#chunks.length > 1)
      this.#held -= this.#chunks.shift()!.length;
  }
  /** Decoded, control characters (except tab/newline) replaced, trimmed from the front to the byte limit. */
  text(): string {
    const bytes = Buffer.concat(this.#chunks);
    let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(Math.max(0, bytes.length - this.limit)))
      .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, "�");
    while (Buffer.byteLength(text, "utf8") > this.limit) text = text.slice(1);
    return text;
  }
}

// ---------------------------------------------------------------- input stream

async function readManifest(reader: ChunkReader, expectedSha256: string): Promise<GuestManifest> {
  if ((await reader.exact(MANIFEST_MAGIC.length)).toString("latin1") !== MANIFEST_MAGIC) throw new RunnerError("manifest-magic");
  const length = (await reader.exact(4)).readUInt32BE(0);
  if (length === 0 || length > MAX_MANIFEST_BYTES) throw new RunnerError("manifest-size");
  const bytes = await reader.exact(length);
  if (createHash("sha256").update(bytes).digest("hex") !== expectedSha256) throw new RunnerError("manifest-hash");
  return JSON.parse(bytes.toString("utf8")) as GuestManifest;
}

/** Extracts one uncompressed archive part of exactly `part.bytes` into `root`, verifying its digest. */
async function extractPart(reader: ChunkReader, part: InputPart, root: string): Promise<ArchiveStats> {
  const hash = createHash("sha256");
  const inner = new ChunkReader(reader.range(part.bytes), part.bytes);
  inner.tap = hash;
  const stats = await decodeArchive(inner, extractingSink(root), part.limits);
  if (!await inner.atEnd()) throw new RunnerError("input-trailing-bytes");
  if (inner.consumed !== part.bytes || hash.digest("hex") !== part.sha256) throw new RunnerError("input-digest");
  return stats;
}

/** Extracts one gzip-compressed archive part; the digest covers the compressed bytes, the caps the expanded ones. */
async function extractCompressedPart(reader: ChunkReader, part: InputPart, root: string): Promise<ArchiveStats> {
  const hash = createHash("sha256");
  let compressed = 0;
  async function* hashed(): AsyncGenerator<Buffer> {
    for await (const chunk of reader.range(part.bytes)) { hash.update(chunk); compressed += chunk.length; yield chunk; }
  }
  let stats: ArchiveStats | undefined;
  await pipeline(Readable.from(hashed()), createGunzip(), async (expanded: AsyncIterable<Buffer>) => {
    const inner = new ChunkReader(expanded, rawArchiveCeiling(part.limits));
    stats = await decodeArchive(inner, extractingSink(root), part.limits);
    if (!await inner.atEnd()) throw new RunnerError("input-trailing-bytes");
  });
  if (compressed !== part.bytes || hash.digest("hex") !== part.sha256) throw new RunnerError("input-digest");
  return stats!;
}

async function requireEnd(reader: ChunkReader): Promise<void> {
  if (!await reader.atEnd()) throw new RunnerError("input-trailing-bytes");
}

// ---------------------------------------------------------------- verify

function runProcess(executable: string, args: readonly string[], cwd: string, env: Readonly<Record<string, string>>,
  timeoutMs: number, limits: Readonly<{ stdoutTailBytes: number; stderrTailBytes: number }>, id: string,
  onStdout?: (chunk: Buffer) => void): Promise<GuestCommandResult> {
  const started = performance.now();
  const stdout = new Tail(limits.stdoutTailBytes), stderr = new Tail(limits.stderrTailBytes);
  const finishWith = (status: GuestCommandResult["status"], exitCode: number | null, signal: string | null): GuestCommandResult =>
    ({ id, status, exitCode, signal, durationMs: Math.round(performance.now() - started),
      stdoutTail: stdout.text(), stderrTail: stderr.text(), stdoutBytes: stdout.total, stderrBytes: stderr.total });
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      // Own process group, so the whole tree can be killed at the deadline and after exit.
      child = spawn(executable, [...args], { cwd, env: { ...env }, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch { resolve(finishWith("spawnError", null, null)); return; }
    let settled = false, timedOut = false, spawnFailed = false;
    let exitCode: number | null = null, signal: string | null = null;
    let drain: NodeJS.Timeout | undefined;
    const killGroup = (): void => { if (child.pid !== undefined) try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } };
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (drain !== undefined) clearTimeout(drain);
      resolve(spawnFailed ? finishWith("spawnError", null, null)
        : finishWith(timedOut ? "timeout" : "exited", exitCode, exitCode === null ? signal ?? "SIGKILL" : null));
    };
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => { stdout.push(chunk); onStdout?.(chunk); });
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", () => { spawnFailed = child.pid === undefined; if (spawnFailed) finish(); });
    child.once("exit", (code, exitSignal) => {
      exitCode = code; signal = exitSignal;
      // Orphaned descendants must not outlive their step; a descendant holding the pipes cannot stall the run.
      killGroup();
      drain = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); finish(); }, 1_000);
    });
    child.once("close", finish);
  });
}

async function verify(manifest: VerifyManifest, reader: ChunkReader): Promise<void> {
  const started = performance.now();
  await mkdir(SOURCE, { mode: 0o700 });
  const source = await extractPart(reader, manifest.input.source, SOURCE);
  let dependencies: ArchiveStats | null = null;
  if (manifest.input.dependencies !== null) {
    const root = join(SOURCE, "node_modules");
    await mkdir(root, { mode: 0o755 });
    dependencies = await extractCompressedPart(reader, manifest.input.dependencies, root);
  }
  await requireEnd(reader);
  const input = { sourceSha256: manifest.input.source.sha256, sourceEntries: source.entries, sourceBytes: source.bytes,
    dependencySha256: manifest.input.dependencies?.sha256 ?? null, dependencyEntries: dependencies?.entries ?? 0,
    dependencyBytes: dependencies?.bytes ?? 0, durationMs: Math.round(performance.now() - started) };
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const commands: GuestCommandResult[] = [];
  for (const command of manifest.commands) {
    const cwd = posix.resolve(SOURCE, command.cwd);
    const result = cwd !== SOURCE && !cwd.startsWith(`${SOURCE}/`)
      ? { id: command.id, status: "spawnError" as const, exitCode: null, signal: null, durationMs: 0, stdoutTail: "",
        stderrTail: "", stdoutBytes: 0, stderrBytes: 0 }
      : await runProcess(command.executable, command.args, cwd, manifest.env, command.timeoutMs, manifest.limits, command.id);
    commands.push(result);
    if (result.status !== "exited" || result.exitCode !== 0) break;
  }
  const passed = commands.length === manifest.commands.length && commands.every(entry => entry.status === "exited" && entry.exitCode === 0);
  const result: VerifyResult = { protocolVersion: 2, mode: "verify", nonce: manifest.nonce, input, runtime: runtime(), commands,
    notRun: manifest.commands.slice(commands.length).map((command: GuestCommand) => command.id), complete: true };
  emitLine(JSON.stringify(result), passed ? 0 : 1);
}

// ---------------------------------------------------------------- canary

async function errorCode(work: () => Promise<unknown>): Promise<string | null> {
  try { await work(); return null; } catch (error) { return (error as NodeJS.ErrnoException).code ?? "EUNKNOWN"; }
}
const readText = (path: string): Promise<string | null> => readFile(path, "utf8").catch(() => null);
const exists = (path: string): Promise<boolean> => lstat(path).then(() => true, () => false);

async function writable(path: string): Promise<boolean> {
  return await errorCode(async () => { await writeFile(path, "fusion"); if (await readFile(path, "utf8") !== "fusion") throw new Error(); }) === null;
}

function environ(text: string | null): Record<string, string> | null {
  if (text === null) return null;
  const env: Record<string, string> = {};
  for (const entry of text.split("\0")) {
    const equals = entry.indexOf("=");
    if (equals > 0) env[entry.slice(0, equals)] = entry.slice(equals + 1);
  }
  return env;
}

const CREDENTIAL_SHAPE =
  /(?:^|_)(?:API_KEY|ACCESS_KEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|PRIVATE_KEY|TOKEN|CREDENTIAL|AUTHORIZATION|COOKIE)(?:$|_)/u;

async function credentials(manifest: CanaryManifest): Promise<CanaryResult["credentials"]> {
  const sources = [process.env as Record<string, string>, environ(await readText("/proc/self/environ")),
    environ(await readText("/proc/1/environ"))].filter((entry): entry is Record<string, string> => entry !== null);
  let forbiddenKeysPresent = 0, credentialShapedKeysPresent = 0, canaryValuesPresent = 0;
  const forbidden = new Set(manifest.forbiddenEnvKeys);
  for (const env of sources) {
    for (const [key, value] of Object.entries(env)) {
      const upper = key.toUpperCase();
      if (forbidden.has(upper) || manifest.forbiddenEnvPrefixes.some(prefix => upper.startsWith(prefix))) forbiddenKeysPresent++;
      if (CREDENTIAL_SHAPE.test(upper)) credentialShapedKeysPresent++;
      if (typeof value === "string" && value.includes(manifest.canaryValuePrefix)) canaryValuesPresent++;
    }
  }
  let sshOrGitPathsPresent = 0;
  for (const home of [HOME, "/home/node", "/root"])
    for (const name of [".ssh", ".gitconfig", ".git-credentials", ".config/gh", ".config/git", ".claude", ".claude.json",
      ".muse", ".npmrc", ".docker/config.json", ".aws", ".azure"])
      if (await exists(join(home, name))) sshOrGitPathsPresent++;
  return { forbiddenKeysPresent, credentialShapedKeysPresent, canaryValuesPresent, environSourcesRead: sources.length,
    sshOrGitPathsPresent };
}

/** File systems Docker Desktop and similar engines use to share HOST directories into the VM or a container. */
const HOST_SHARE_FS = new Set(["9p", "drvfs", "virtiofs", "fuse.grpcfuse", "grpcfuse", "cifs", "smb3", "nfs", "nfs4",
  "fakeowner", "fuse.sshfs", "vboxsf", "prl_fs"]);
const HOST_SHARE_ROOTS = ["/run/desktop/mnt/host", "/mnt/host", "/host_mnt", "/mnt/wsl", "/Users/", "/c/Users"];

/** Reads the mount table: a host path can only be visible through a mount, so none may come from the host. */
async function mounts(manifest: CanaryManifest): Promise<CanaryResult["mounts"]> {
  const lines = ((await readText("/proc/self/mountinfo")) ?? "").split("\n").filter(line => line.trim() !== "");
  let forbiddenFound = 0, hostShareFilesystems = 0, bindLikeFromOutsideVm = 0;
  for (const line of lines) {
    if (manifest.mountinfoForbidden.some(fragment => line.includes(fragment))) forbiddenFound++;
    const [left, right] = line.split(" - ");
    const fsType = right?.split(" ")[0] ?? "";
    const root = left?.split(" ")[3] ?? "";
    if (HOST_SHARE_FS.has(fsType)) hostShareFilesystems++;
    if (HOST_SHARE_ROOTS.some(prefix => root.startsWith(prefix) || (right ?? "").includes(prefix))) bindLikeFromOutsideVm++;
  }
  return { entries: lines.length, forbiddenFound, hostShareFilesystems, bindLikeFromOutsideVm };
}

async function walk(manifest: CanaryManifest): Promise<{ markers: CanaryResult["markers"]; dockerSockets: number }> {
  const names = new Set(manifest.absentMarkerNames);
  const skip = new Set(["/proc", "/sys", "/dev"]);
  let entriesVisited = 0, unreadableDirectories = 0, found = 0, dockerSockets = 0, walkComplete = true;
  const pending = ["/"];
  while (pending.length > 0 && walkComplete) {
    const directory = pending.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { unreadableDirectories++; continue; }
    for (const entry of entries) {
      if (++entriesVisited > manifest.walkMaxEntries) { walkComplete = false; break; }
      const path = join(directory, entry.name);
      if (names.has(entry.name)) found++;
      if (entry.isSocket() && entry.name.toLowerCase().includes("docker")) dockerSockets++;
      if (entry.isDirectory() && !skip.has(path)) pending.push(path);
    }
  }
  return { markers: { walkComplete, entriesVisited, unreadableDirectories, found }, dockerSockets };
}

async function network(manifest: CanaryManifest): Promise<CanaryResult["network"]> {
  const interfaces = (await readdir("/sys/class/net").catch(() => [] as string[])).sort().slice(0, 16);
  const routeLines = ((await readText("/proc/net/route")) ?? "").split("\n").slice(1).filter(line => line.trim() !== "");
  const ipv6NonLoopbackRoutes = ((await readText("/proc/net/ipv6_route")) ?? "").split("\n")
    .filter(line => line.trim() !== "" && line.trim().split(/\s+/u).at(-1) !== "lo").length;
  let dnsFailures = 0, connectFailures = 0;
  for (const name of manifest.dnsNames) {
    const failed = await Promise.race([lookup(name).then(() => false, () => true),
      new Promise<boolean>(resolve => setTimeout(() => resolve(true), 3_000))]);
    if (failed) dnsFailures++;
  }
  for (const target of manifest.connectTargets) {
    const failed = await new Promise<boolean>(resolve => {
      const socket = connect({ host: target.host, port: target.port, timeout: 3_000 });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => { socket.destroy(); resolve(true); });
      socket.once("timeout", () => { socket.destroy(); resolve(true); });
    });
    if (failed) connectFailures++;
  }
  return { interfaces, ipv4Routes: routeLines.length, ipv6NonLoopbackRoutes, dnsAttempts: manifest.dnsNames.length, dnsFailures,
    connectAttempts: manifest.connectTargets.length, connectFailures };
}

/** Harmless PID-bound probe: start small sleeping children until the kernel refuses, then kill them all. */
async function pidProbe(max: number): Promise<{ spawned: number; limited: boolean }> {
  const children: ChildProcess[] = [];
  let limited = false;
  for (let index = 0; index < max && !limited; index++) {
    let child: ChildProcess;
    try { child = spawn("/bin/sleep", ["30"], { stdio: "ignore" }); } catch { limited = true; break; }
    limited = await new Promise<boolean>(resolve => {
      child.once("spawn", () => resolve(false));
      child.once("error", () => resolve(true));
    });
    if (!limited) children.push(child);
  }
  await Promise.all(children.map(child => new Promise<void>(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
    child.once("exit", () => resolve());
    child.kill("SIGKILL");
  })));
  return { spawned: children.length, limited };
}

async function canary(manifest: CanaryManifest, reader: ChunkReader): Promise<void> {
  await mkdir(SOURCE, { mode: 0o700 });
  let transferDigestMatched = true;
  try { await extractPart(reader, manifest.input, SOURCE); await requireEnd(reader); }
  catch { transferDigestMatched = false; }
  const status = (await readText("/proc/self/status")) ?? "";
  const field = (name: string): string | undefined => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "mu"))?.[1];
  const scope = (await readText("/proc/sys/kernel/yama/ptrace_scope"))?.trim();
  const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, noNewPrivs: field("NoNewPrivs") === "1",
    seccompMode: Number(field("Seccomp") ?? 0),
    capabilitiesZero: ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(name => /^0+$/u.test(field(name) ?? "x")),
    ptraceScope: scope !== undefined && /^[0-3]$/u.test(scope) ? Number(scope) : null };
  const transferredReadable = await readText(`${SOURCE}/canary/readable.txt`) === manifest.readableToken;
  // /home/node belongs to this uid in the image, so only a read-only root filesystem can refuse the write (EROFS).
  const rootfsWriteDenied = await errorCode(() => writeFile("/home/node/fusion-rootfs-probe", "x")) === "EROFS" &&
    await errorCode(() => writeFile("/fusion-rootfs-probe", "x")) === "EROFS";
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const filesystem = { transferredReadable, transferDigestMatched, rootfsWriteDenied,
    workWritable: await writable(`${WORK}/fusion-probe`), tmpWritable: await writable("/tmp/fusion-probe"),
    homeWritable: await writable(`${HOME}/fusion-probe`) };
  const mountTable = await mounts(manifest);
  const { markers, dockerSockets } = await walk(manifest);
  let knownPathsPresent = 0;
  for (const path of ["/var/run/docker.sock", "/run/docker.sock", "/run/host-services/docker.proxy.sock",
    "/run/guest-services/docker.sock", "/var/run/docker"])
    if (await exists(path)) knownPathsPresent++;
  const net = await network(manifest);
  const devicesList = (await readdir("/dev").catch(() => [] as string[])).sort();
  const allowed = new Set(manifest.allowedDevices);
  const cgroup = async (name: string): Promise<string> => ((await readText(`/sys/fs/cgroup/${name}`)) ?? "").trim();
  const memoryMax = await cgroup("memory.max"), cpuMax = await cgroup("cpu.max"), pidsMax = await cgroup("pids.max");
  const credentialFacts = await credentials(manifest);
  const probe = await pidProbe(manifest.pidProbeMax);
  const result: CanaryResult = { protocolVersion: 2, mode: "canary", nonce: manifest.nonce, runtime: runtime(), identity, filesystem,
    mounts: mountTable, markers, credentials: credentialFacts,
    dockerSocket: { knownPathsPresent, socketsNamedDockerFound: dockerSockets }, network: net,
    resources: { memoryMax, cpuMax, pidsMax, pidProbeSpawned: probe.spawned, pidProbeLimited: probe.limited },
    devices: { count: devicesList.length, unexpected: devicesList.filter(name => !allowed.has(name)).slice(0, 16) },
    complete: true };
  emitLine(JSON.stringify(result), 0);
}

function descendant(manifest: DescendantManifest): void {
  const child = spawn(NODE, ["-e", `setInterval(() => {}, ${FOREVER})`, manifest.descendantMarker],
    { stdio: "ignore", detached: true });
  child.unref();
  setInterval(() => {}, FOREVER);
}

// ---------------------------------------------------------------- dependency preparation

/** Base64 line framing for the binary artifact on stdout: `D <base64>` lines, then one `R <json>` line. */
async function writeFramed(prefix: string, data: Buffer): Promise<void> {
  const line = `${prefix} ${data.toString("base64")}\n`;
  if (!process.stdout.write(line)) await new Promise<void>(resolve => process.stdout.once("drain", () => resolve()));
}

async function deps(manifest: DependencyManifest, reader: ChunkReader): Promise<void> {
  await mkdir(DEPS, { mode: 0o700 });
  const stats = await extractPart(reader, manifest.input, DEPS);
  await requireEnd(reader);
  if (stats.files !== 2 || stats.directories !== 0 || !await exists(`${DEPS}/package.json`) || !await exists(`${DEPS}/package-lock.json`))
    throw new RunnerError("deps-input-shape");
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  let npmVersion = "";
  try { npmVersion = String((JSON.parse(await readFile("/usr/local/lib/node_modules/npm/package.json", "utf8")) as { version?: unknown }).version ?? ""); }
  catch { throw new RunnerError("deps-npm-missing"); }
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(npmVersion)) throw new RunnerError("deps-npm-missing");
  const env = { PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", HOME, TMPDIR: "/tmp", LANG: "C.UTF-8",
    NO_COLOR: "1", CI: "1" };
  const npm = await runProcess(NODE, [NPM_CLI, ...manifest.npmArgs], DEPS, env, manifest.npmTimeoutMs, manifest.limits, "npm");
  const npmSummary = { version: npmVersion, exitCode: npm.exitCode, signal: npm.signal, durationMs: npm.durationMs,
    timedOut: npm.status === "timeout", stdoutTail: npm.stdoutTail, stderrTail: npm.stderrTail };
  const finish = (artifact: DependencyResult["artifact"], exitCode: number): void => {
    const result: DependencyResult = { protocolVersion: 2, mode: "deps", nonce: manifest.nonce, inputSha256: manifest.input.sha256,
      runtime: runtime(), npm: npmSummary, artifact, complete: true };
    emitLine(`R ${JSON.stringify(result)}`, exitCode);
  };
  if (npm.status !== "exited" || npm.exitCode !== 0) { finish(null, 1); return; }
  const root = `${DEPS}/node_modules`;
  if (!await exists(root)) await mkdir(root, { mode: 0o755 });
  // A link or special file anywhere in node_modules fails the preparation: it is never followed or shipped.
  const limits: ArchiveLimits = manifest.output.limits;
  const entries = await planTree(root, { limits, preserveExecutable: true }).catch((error: unknown) => {
    throw new RunnerError(error instanceof TransferArchiveError && error.code === "tree-link" ? "deps-symlink" : "deps-tree-invalid");
  });
  const hash = createHash("sha256");
  let compressedBytes = 0, pending: Buffer[] = [], pendingBytes = 0, files = 0, directories = 0, bytes = 0;
  for (const entry of entries) {
    if (entry.kind === "file") { files++; bytes += entry.size!; } else directories++;
  }
  const flush = async (): Promise<void> => {
    if (pendingBytes === 0) return;
    const data = Buffer.concat(pending);
    pending = []; pendingBytes = 0;
    await writeFramed("D", data);
  };
  await pipeline(Readable.from(encodeArchive(entries, entry => fileContent(root, entry))),
    createGzip({ level: zlibConstants.Z_BEST_SPEED }), async (compressed: AsyncIterable<Buffer>) => {
      for await (const chunk of compressed) {
        hash.update(chunk);
        compressedBytes += chunk.length;
        if (compressedBytes > manifest.output.maxCompressedBytes) throw new RunnerError("deps-artifact-too-large");
        pending.push(chunk); pendingBytes += chunk.length;
        if (pendingBytes >= 48 * 1024) await flush();
      }
      await flush();
    });
  finish({ sha256: hash.digest("hex"), compressedBytes, entries: entries.length, files, directories, bytes, symlinksRefused: 0 }, 0);
}

// ---------------------------------------------------------------- entry

/** Called by the bootstrap with the rest of stdin. Importing this module runs nothing. */
export async function runGuest(mode: string, manifestSha256: string, leftover: Buffer, stdin: AsyncIterable<Uint8Array>): Promise<void> {
  try {
    const reader = new ChunkReader(stdin, Number.MAX_SAFE_INTEGER, leftover);
    const manifest = await readManifest(reader, manifestSha256);
    if (manifest.protocolVersion !== 2 || manifest.mode !== mode) throw new RunnerError("manifest-mode");
    if (manifest.mode === "verify") await verify(manifest, reader);
    else if (manifest.mode === "canary") await canary(manifest, reader);
    else if (manifest.mode === "descendant") { await requireEnd(reader); descendant(manifest); }
    else if (manifest.mode === "deps") await deps(manifest, reader);
    else throw new RunnerError("unknown-mode");
  } catch (error) {
    const code = error instanceof RunnerError || error instanceof TransferArchiveError ? error.code : "runner-failed";
    process.stderr.write(`fusion-runner-error:${code}\n`, () => process.exit(2));
  }
}
