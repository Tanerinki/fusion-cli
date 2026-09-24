/**
 * Fusion Docker guest runner. It runs INSIDE the verification container as an unprivileged user, copied alone into
 * the read-only input bundle, so it imports only Node built-ins (the protocol import below is type-only and erased).
 * Its single output channel is one JSON line on stdout; the host treats that line as untrusted. Modes:
 *   verify     — copy the read-only candidate into tmpfs scratch and run the host-fixed command list there.
 *   canary     — Fusion-authored confinement probes; no repository code runs in this mode.
 *   descendant — start a marked sleeping child and wait, so the host can prove removal takes the child with it.
 *   hang       — never finish, so the host can prove it enforces its own deadline.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { lookup } from "node:dns/promises";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join, posix } from "node:path";
import { performance } from "node:perf_hooks";
import type { CanaryManifest, CanaryResult, GuestCommand, GuestCommandResult, VerifyManifest,
  VerifyResult } from "./protocol.js";

const INPUT = "/fusion/input", WORK = "/fusion/work", SOURCE_IN = `${INPUT}/src`, SOURCE = `${WORK}/src`;
const HOME = `${WORK}/home`;
const FOREVER = 2 ** 30;

class RunnerError extends Error {
  constructor(readonly code: string) { super(code); }
}

function emit(result: VerifyResult | CanaryResult, exitCode: number): void {
  process.stdout.write(`${JSON.stringify(result)}\n`, () => process.exit(exitCode));
}

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

async function copyTree(limits: VerifyManifest["limits"]): Promise<VerifyResult["copy"]> {
  const started = performance.now();
  let files = 0, directories = 0, bytes = 0;
  await mkdir(SOURCE, { mode: 0o700 });
  const pending: [string, string][] = [[SOURCE_IN, SOURCE]];
  while (pending.length > 0) {
    const [from, to] = pending.pop()!;
    for (const entry of await readdir(from, { withFileTypes: true })) {
      if (files + directories >= limits.maxCopyEntries) throw new RunnerError("bundle-too-many-entries");
      const source = join(from, entry.name), target = join(to, entry.name);
      if (entry.isDirectory()) {
        await mkdir(target, { mode: 0o700 });
        directories++;
        pending.push([source, target]);
      } else if (entry.isFile()) {
        bytes += (await lstat(source)).size;
        if (bytes > limits.maxCopyBytes) throw new RunnerError("bundle-too-large");
        await copyFile(source, target);
        files++;
      } else throw new RunnerError("bundle-entry-unsupported");
    }
  }
  return { files, directories, bytes, durationMs: Math.round(performance.now() - started) };
}

function runCommand(command: GuestCommand, manifest: VerifyManifest): Promise<GuestCommandResult> {
  const started = performance.now();
  const stdout = new Tail(manifest.limits.stdoutTailBytes), stderr = new Tail(manifest.limits.stderrTailBytes);
  const cwd = posix.resolve(SOURCE, command.cwd);
  const finishWith = (status: GuestCommandResult["status"], exitCode: number | null, signal: string | null): GuestCommandResult =>
    ({ id: command.id, status, exitCode, signal, durationMs: Math.round(performance.now() - started),
      stdoutTail: stdout.text(), stderrTail: stderr.text(), stdoutBytes: stdout.total, stderrBytes: stderr.total });
  if (cwd !== SOURCE && !cwd.startsWith(`${SOURCE}/`)) return Promise.resolve(finishWith("spawnError", null, null));
  return new Promise(resolve => {
    let child: ChildProcess;
    try {
      // Own process group, so the whole tree can be killed at the deadline and after exit.
      child = spawn(command.executable, [...command.args], { cwd, env: { ...manifest.env },
        stdio: ["ignore", "pipe", "pipe"], detached: true });
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
    const timer = setTimeout(() => { timedOut = true; killGroup(); }, command.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
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

async function verify(manifest: VerifyManifest): Promise<void> {
  const copy = await copyTree(manifest.limits);
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const commands: GuestCommandResult[] = [];
  for (const command of manifest.commands) {
    const result = await runCommand(command, manifest);
    commands.push(result);
    if (result.status !== "exited" || result.exitCode !== 0) break;
  }
  const passed = commands.length === manifest.commands.length && commands.every(entry => entry.status === "exited" && entry.exitCode === 0);
  emit({ protocolVersion: 1, mode: "verify", nonce: manifest.nonce, copy, commands,
    notRun: manifest.commands.slice(commands.length).map(command => command.id), complete: true }, passed ? 0 : 1);
}

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

async function canary(manifest: CanaryManifest): Promise<void> {
  const status = (await readText("/proc/self/status")) ?? "";
  const field = (name: string): string | undefined => status.match(new RegExp(`^${name}:\\s*(\\S+)`, "mu"))?.[1];
  const scope = (await readText("/proc/sys/kernel/yama/ptrace_scope"))?.trim();
  const identity = { uid: process.getuid?.() ?? 0, gid: process.getgid?.() ?? 0, noNewPrivs: field("NoNewPrivs") === "1",
    seccompMode: Number(field("Seccomp") ?? 0),
    capabilitiesZero: ["CapInh", "CapPrm", "CapEff", "CapBnd", "CapAmb"].every(name => /^0+$/u.test(field(name) ?? "x")),
    ptraceScope: scope !== undefined && /^[0-3]$/u.test(scope) ? Number(scope) : null };
  const readable = `${INPUT}/canary/readable.txt`;
  const inputReadable = await readText(readable) === manifest.readableToken;
  const inputCreateDenied = await errorCode(() => writeFile(`${INPUT}/canary/created.txt`, "x")) !== null;
  const inputModifyDenied = await errorCode(() => writeFile(readable, "tampered")) !== null &&
    await readText(readable) === manifest.readableToken;
  // /home/node belongs to this uid in the image, so only a read-only root filesystem can refuse the write (EROFS).
  const rootfsWriteDenied = await errorCode(() => writeFile("/home/node/fusion-rootfs-probe", "x")) === "EROFS" &&
    await errorCode(() => writeFile("/fusion-rootfs-probe", "x")) === "EROFS";
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  const filesystem = { inputReadable, inputCreateDenied, inputModifyDenied, rootfsWriteDenied,
    workWritable: await writable(`${WORK}/fusion-probe`), tmpWritable: await writable("/tmp/fusion-probe"),
    homeWritable: await writable(`${HOME}/fusion-probe`) };
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
  emit({ protocolVersion: 1, mode: "canary", nonce: manifest.nonce, identity, filesystem, markers,
    credentials: credentialFacts, dockerSocket: { knownPathsPresent, socketsNamedDockerFound: dockerSockets }, network: net,
    resources: { memoryMax, cpuMax, pidsMax, pidProbeSpawned: probe.spawned, pidProbeLimited: probe.limited },
    devices: { count: devicesList.length, unexpected: devicesList.filter(name => !allowed.has(name)).slice(0, 16) },
    complete: true }, 0);
}

function descendant(manifest: CanaryManifest): void {
  const child = spawn("/usr/local/bin/node", ["-e", `setInterval(() => {}, ${FOREVER})`, manifest.descendantMarker],
    { stdio: "ignore", detached: true });
  child.unref();
  setInterval(() => {}, FOREVER);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  try {
    if (mode === "hang") { setInterval(() => {}, FOREVER); return; }
    const manifestPath = mode === "verify" ? `${INPUT}/manifest.json` : `${INPUT}/canary.json`;
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as unknown;
    if (mode === "verify") await verify(manifest as VerifyManifest);
    else if (mode === "canary") await canary(manifest as CanaryManifest);
    else if (mode === "descendant") descendant(manifest as CanaryManifest);
    else throw new RunnerError("unknown-mode");
  } catch (error) {
    const code = error instanceof RunnerError ? error.code : "runner-failed";
    process.stderr.write(`fusion-runner-error:${code}\n`, () => process.exit(2));
  }
}

// Only when executed as the container entrypoint; importing this module (e.g. from a test) runs nothing.
if (process.argv[1] === "/fusion/input/runner.mjs") void main();
