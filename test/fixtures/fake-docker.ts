import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import type { DockerCommandRunner, DockerInvocation, DockerOutcome } from "../../src/platform/verification/docker/cli.js";
import { assertSafeDockerArgs, GUEST_BOOTSTRAP } from "../../src/platform/verification/docker/config.js";
import type { DependencyManifest, GuestCommand, GuestManifest, VerifyManifest } from "../../src/platform/verification/docker/protocol.js";
import { ChunkReader, decodeArchive, encodeArchive, memoryArchive, rawArchiveCeiling, type ArchiveLimits,
  type ArchiveSink } from "../../src/platform/verification/docker/transfer-archive.js";

/**
 * Test-only in-memory stand-in for the docker CLI + daemon (protocol 2). It never spawns anything. Every argv it
 * receives is first checked by the production `assertSafeDockerArgs`; container state is derived from the real `create`
 * argv (so daemon facts reflect exactly what the builder produced); and an attached start CONSUMES AND PARSES the real
 * stdin stream — bundle frame, manifest frame and FTA1 archives, each checked against the hashes in the create argv — so
 * tests observe exactly what a guest would receive.
 */
export const FAKE_DIGEST = `sha256:${"ab".repeat(32)}`;
export const FAKE_IMAGE = `node@${FAKE_DIGEST}`;
export const FAKE_DOCKER_EXE = "C:\\fake\\docker.exe";
export const FAKE_CREATED = "2026-09-24T12:00:00.000Z";

export interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly createArgs: readonly string[];
  labels: Record<string, string>;
  running: boolean;
  exitCode: number;
  removed: boolean;
  created: string;
  manifest?: GuestManifest;
  release?: () => void;
}
export interface AttachContext {
  readonly manifest: VerifyManifest;
  /** The candidate files the guest would extract (path → bytes). */
  readonly files: ReadonlyMap<string, Buffer>;
  readonly dependencyFiles: ReadonlyMap<string, Buffer> | null;
  readonly invocation: DockerInvocation;
  readonly container: FakeContainer;
}
export interface DepsContext {
  readonly manifest: DependencyManifest;
  readonly files: ReadonlyMap<string, Buffer>;
}
export type AttachReply = Partial<DockerOutcome> & Readonly<{ containerExitCode?: number }>;
export interface ExtraContainer {
  readonly id: string;
  readonly labels: Record<string, string>;
  readonly created?: string;
  readonly running?: boolean;
  /** Returned by EVERY listing regardless of its filter (a misbehaving daemon); defense-in-depth tests. */
  readonly alwaysListed?: boolean;
}
export interface FakeDockerOptions {
  readonly version?: "linux" | "windows" | "noServer" | "malformed" | "duplicateKey" | "exitFailure";
  readonly image?: "present" | "absent" | "wrongOs" | "wrongDigest" | "wrongArch";
  readonly cli?: "present" | "spawnFailure";
  /** Produces the verify guest's stdout; default: every command passes. */
  readonly attach?: (context: AttachContext) => AttachReply | Promise<AttachReply>;
  /** Produces the canary guest's stdout; default: no result (exit 2), i.e. guest facts stay unobserved. */
  readonly canary?: (manifest: GuestManifest) => AttachReply;
  /** node_modules tree the fake dependency stage "installs"; `depsReply` overrides the whole reply. */
  readonly depsTree?: Readonly<Record<string, Buffer>>;
  readonly depsReply?: (context: DepsContext) => { lines: string[]; exitCode: number };
  readonly rmFails?: boolean;
  /** Extra containers the daemon knows (e.g. foreign or stale ones). */
  readonly extraListed?: readonly ExtraContainer[];
  /** Mutate the daemon's view of a container's config (to simulate a weakened container). */
  readonly patchInspect?: (inspect: Record<string, unknown>) => void;
}

const ok = (stdout = "", extra: Partial<DockerOutcome> = {}): DockerOutcome =>
  ({ status: "exited", exitCode: 0, stdout, stderr: "", durationMs: 1, ...extra });
const fail = (stderr: string, exitCode = 1): DockerOutcome => ({ status: "exited", exitCode, stdout: "", stderr, durationMs: 1 });
const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

export function passingResult(manifest: VerifyManifest, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ protocolVersion: 2, mode: "verify", nonce: manifest.nonce,
    input: { sourceSha256: manifest.input.source.sha256, sourceEntries: 1, sourceBytes: 10,
      dependencySha256: manifest.input.dependencies?.sha256 ?? null, dependencyEntries: manifest.input.dependencies ? 1 : 0,
      dependencyBytes: manifest.input.dependencies ? 1 : 0, durationMs: 0 },
    runtime: { node: "v22.20.0", platform: "linux", arch: "x64" },
    commands: manifest.commands.map((command: GuestCommand) => ({ id: command.id, status: "exited", exitCode: 0, signal: null,
      durationMs: 0, stdoutTail: "ok\n", stderrTail: "", stdoutBytes: 3, stderrBytes: 0 })),
    notRun: [], complete: true, ...overrides });
}

/** Collects an archive into memory with the production decoder (so tests see what the guest would extract). */
export async function readArchive(bytes: Buffer, limits: ArchiveLimits): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const sink: ArchiveSink = {
    directory: () => Promise.resolve(),
    async file(path, _executable, _size, content) {
      const parts: Buffer[] = [];
      for await (const chunk of content) parts.push(chunk);
      files.set(path, Buffer.concat(parts));
    },
  };
  const reader = new ChunkReader((async function* () { yield bytes; })(), rawArchiveCeiling(limits));
  await decodeArchive(reader, sink, limits);
  if (!await reader.atEnd()) throw new Error("trailing archive bytes");
  return files;
}
/** A gzip FTA1 archive of an in-memory tree (a fake prepared node_modules). */
export async function gzipTree(tree: Readonly<Record<string, Buffer>>): Promise<Buffer> {
  const [entries, content] = memoryArchive(tree);
  const parts: Buffer[] = [];
  for await (const chunk of encodeArchive(entries, content)) parts.push(Buffer.from(chunk));
  return gzipSync(Buffer.concat(parts));
}

interface ParsedInput {
  readonly manifest: GuestManifest;
  readonly parts: readonly Buffer[];
}
/** Parses the stdin stream exactly as the bootstrap + runner would, checking the argv-pinned hashes. */
function parseInput(stream: Buffer, bundleSha: string, manifestSha: string): ParsedInput {
  let offset = 0;
  const frame = (magic: string): Buffer => {
    if (stream.toString("latin1", offset, offset + 8) !== magic) throw new Error(`fake: missing ${magic}`);
    const length = stream.readUInt32BE(offset + 8);
    const body = stream.subarray(offset + 12, offset + 12 + length);
    offset += 12 + length;
    return body;
  };
  if (sha256(frame("FUSIONB1")) !== bundleSha) throw new Error("fake: bundle hash mismatch");
  const manifestBytes = frame("FUSIONM1");
  if (sha256(manifestBytes) !== manifestSha) throw new Error("fake: manifest hash mismatch");
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as GuestManifest;
  const sizes: number[] = manifest.mode === "verify"
    ? [manifest.input.source.bytes, ...(manifest.input.dependencies ? [manifest.input.dependencies.bytes] : [])]
    : manifest.mode === "canary" || manifest.mode === "deps" ? [manifest.input.bytes] : [];
  const parts = sizes.map(size => { const part = stream.subarray(offset, offset + size); offset += size; return part; });
  if (offset !== stream.length) throw new Error("fake: trailing input bytes");
  return { manifest, parts };
}

export class FakeDocker implements DockerCommandRunner {
  readonly calls: string[][] = [];
  readonly containers = new Map<string, FakeContainer>();
  /** Every input stream received by an attached start, in order. */
  readonly inputs: Buffer[] = [];
  #next = 0;
  constructor(private options: FakeDockerOptions = {}) {}
  /** Changes behaviour mid-test, e.g. a daemon that goes away after a lease was prepared. */
  configure(options: FakeDockerOptions): void { this.options = { ...this.options, ...options }; }

  commands(name: string): string[][] { return this.calls.filter(args => args[0] === name); }

  async run(invocation: DockerInvocation): Promise<DockerOutcome> {
    const args = [...invocation.args];
    assertSafeDockerArgs(args);
    this.calls.push(args);
    if (this.options.cli === "spawnFailure") return { status: "spawnFailure", exitCode: null, stdout: "", stderr: "", durationMs: 0 };
    switch (args[0]) {
      case "version": return this.#version();
      case "image": return this.#image();
      case "create": return this.#create(args);
      case "start": return this.#start(args, invocation);
      case "container": return this.#inspect(args);
      case "kill": {
        const container = this.#live(args[1]!);
        if (container) { container.running = false; container.exitCode = 137; container.release?.(); }
        return ok();
      }
      case "rm": {
        if (this.options.rmFails) return fail("Error response from daemon: removal failed");
        const container = this.#live(args[2]!);
        if (!container) return fail(`Error response from daemon: No such container: ${args[2]}`);
        container.removed = true; container.running = false;
        return ok(`${container.id}\n`);
      }
      case "ps": {
        const filter = args[args.indexOf("--filter") + 1]!.slice("label=".length);
        const [key, value] = [filter.slice(0, filter.indexOf("=")), filter.slice(filter.indexOf("=") + 1)];
        const always = new Set((this.options.extraListed ?? []).filter(extra => extra.alwaysListed).map(extra => extra.id));
        const ids = [...this.containers.values(), ...this.#extras()]
          .filter(entry => !entry.removed && (entry.labels[key] === value || always.has(entry.id))).map(entry => entry.id);
        return ok(ids.map(id => `${id}\n`).join(""));
      }
      case "wait": return new Promise(resolve => setTimeout(() => resolve({ status: "timeout", exitCode: null, stdout: "",
        stderr: "", durationMs: invocation.timeoutMs }), Math.min(invocation.timeoutMs, 20)));
      case "top": {
        const container = this.#live(args[1]!);
        if (!container) return fail(`Error response from daemon: No such container: ${args[1]}`);
        if (!container.running) return fail("container is not running");
        const marker = container.manifest?.mode === "descendant" ? container.manifest.descendantMarker : "";
        return ok(`PID COMMAND\n1 /sbin/docker-init -- /usr/local/bin/node -e ...\n9 node -e x ${marker}\n`);
      }
      default: return fail("unsupported");
    }
  }

  readonly #extraState = new Map<string, FakeContainer>();
  #extras(): FakeContainer[] {
    for (const extra of this.options.extraListed ?? []) if (!this.#extraState.has(extra.id))
      this.#extraState.set(extra.id, { id: extra.id, name: `x-${extra.id.slice(0, 6)}`, createArgs: [], labels: { ...extra.labels },
        running: extra.running ?? false, exitCode: 0, removed: false, created: extra.created ?? FAKE_CREATED });
    return [...this.#extraState.values()];
  }
  #live(id: string): FakeContainer | undefined {
    const container = this.containers.get(id) ?? this.#extras().find(entry => entry.id === id);
    return container && !container.removed ? container : undefined;
  }

  #version(): DockerOutcome {
    const client = { Version: "28.5.1", Os: "windows", Arch: "amd64" };
    const server = (os: string): unknown => ({ Platform: { Name: "Docker Desktop 4.50.0 (209931)" }, Version: "28.5.1", Os: os,
      Arch: "amd64", KernelVersion: "6.6.87.2-microsoft-standard-WSL2" });
    switch (this.options.version ?? "linux") {
      case "linux": return ok(JSON.stringify({ Client: client, Server: server("linux") }));
      case "windows": return ok(JSON.stringify({ Client: client, Server: server("windows") }));
      case "noServer": return { ...ok(JSON.stringify({ Client: client, Server: null })), exitCode: 1,
        stderr: "error during connect: this error may indicate that the docker daemon is not running" };
      case "malformed": return ok("{not json");
      case "duplicateKey": return ok(`{"Client":{},"Server":{"Os":"windows","Os":"linux","Arch":"amd64","Version":"1"}}`);
      case "exitFailure": return fail("Cannot connect to the Docker daemon");
    }
  }

  #image(): DockerOutcome {
    const mode = this.options.image ?? "present";
    if (mode === "absent") return fail(`Error response from daemon: No such image: ${FAKE_IMAGE}`);
    return ok(JSON.stringify({ Id: mode === "wrongDigest" ? `sha256:${"cd".repeat(32)}` : FAKE_DIGEST,
      RepoDigests: mode === "wrongDigest" ? [`node@sha256:${"cd".repeat(32)}`] : [FAKE_IMAGE],
      Os: mode === "wrongOs" ? "windows" : "linux", Architecture: mode === "wrongArch" ? "arm64" : "amd64",
      Config: { Env: ["PATH=/usr/local/bin", "NODE_VERSION=22.20.0", "YARN_VERSION=1.22.22"] } }));
  }

  #create(args: string[]): DockerOutcome {
    const id = createHash("sha256").update(`container-${this.#next++}`).digest("hex");
    const labels: Record<string, string> = {};
    args.forEach((arg, index) => {
      if (arg === "--label") { const [key, ...rest] = args[index + 1]!.split("="); labels[key!] = rest.join("="); }
    });
    this.containers.set(id, { id, name: args[args.indexOf("--name") + 1]!, createArgs: args, labels, running: false, exitCode: 0,
      removed: false, created: new Date().toISOString() });
    return ok(`${id}\n`);
  }

  async #start(args: string[], invocation: DockerInvocation): Promise<DockerOutcome> {
    const attached = args.includes("--attach");
    const container = this.#live(args.at(-1)!);
    if (!container) return fail("No such container");
    container.running = true;
    if (!attached) return ok(`${container.id}\n`);
    const createArgs = container.createArgs;
    const end = createArgs.indexOf(GUEST_BOOTSTRAP);
    const chunks: Buffer[] = [];
    for await (const chunk of invocation.input?.chunks() ?? []) chunks.push(Buffer.from(chunk));
    const stream = Buffer.concat(chunks);
    this.inputs.push(stream);
    let parsed: ParsedInput;
    try { parsed = parseInput(stream, createArgs[end + 1]!, createArgs[end + 3]!); }
    catch {
      // What the real guest does with a truncated or mismatching stream: a stable runner error, no result.
      container.running = false; container.exitCode = 2;
      return { status: "exited", exitCode: 2, stdout: "", stderr: "fusion-runner-error:input-digest\n", durationMs: 1 };
    }
    container.manifest = parsed.manifest;
    const finish = (reply: AttachReply): DockerOutcome => {
      const status = reply.status ?? "exited";
      if (status === "exited") { container.running = false; container.exitCode = reply.containerExitCode ?? reply.exitCode ?? 0; }
      return { status, exitCode: status === "exited" ? container.exitCode : null, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "",
        durationMs: 5 };
    };
    const manifest = parsed.manifest;
    if (manifest.mode === "descendant")
      return new Promise(resolve => { container.release = () => resolve({ ...finish({ exitCode: 137 }), exitCode: 137 }); });
    if (manifest.mode === "canary") {
      const reply = this.options.canary?.(manifest) ?? { stdout: "", stderr: "fusion-runner-error:no-canary-in-fake\n", exitCode: 2 };
      return finish(reply);
    }
    if (manifest.mode === "deps") {
      const files = await readArchive(parsed.parts[0]!, manifest.input.limits);
      const reply = this.options.depsReply?.({ manifest, files }) ?? await this.#defaultDeps(manifest);
      for (const line of reply.lines) invocation.onStdoutLine?.(line);
      return finish({ exitCode: reply.exitCode });
    }
    if (manifest.mode !== "verify") return finish({ exitCode: 2 });
    const files = await readArchive(parsed.parts[0]!, manifest.input.source.limits);
    const dependencyFiles = manifest.input.dependencies === null ? null
      : await readArchive(gunzipSync(parsed.parts[1]!), manifest.input.dependencies.limits);
    const attach = this.options.attach ?? ((context: AttachContext): AttachReply => ({ stdout: `${passingResult(context.manifest)}\n` }));
    return finish(await attach({ manifest, files, dependencyFiles, invocation, container }));
  }

  async #defaultDeps(manifest: DependencyManifest): Promise<{ lines: string[]; exitCode: number }> {
    const tree = this.options.depsTree ?? { "is-number/package.json": Buffer.from('{"name":"is-number","version":"7.0.0"}'),
      "is-number/index.js": Buffer.from("module.exports = n => typeof n === 'number';\n") };
    const gz = await gzipTree(tree);
    const [entries] = memoryArchive(tree);
    const files = entries.filter(entry => entry.kind === "file");
    const result = { protocolVersion: 2, mode: "deps", nonce: manifest.nonce, inputSha256: manifest.input.sha256,
      runtime: { node: "v22.20.0", platform: "linux", arch: "x64" },
      npm: { version: "10.9.3", exitCode: 0, signal: null, durationMs: 1, timedOut: false, stdoutTail: "", stderrTail: "" },
      artifact: { sha256: sha256(gz), compressedBytes: gz.length, entries: entries.length, files: files.length,
        directories: entries.length - files.length, bytes: files.reduce((sum, entry) => sum + entry.size!, 0), symlinksRefused: 0 },
      complete: true };
    return { lines: [`D ${gz.toString("base64")}`, `R ${JSON.stringify(result)}`], exitCode: 0 };
  }

  #inspect(args: string[]): DockerOutcome {
    const id = args.at(-1)!, format = args[args.indexOf("--format") + 1];
    const container = this.#live(id);
    if (!container) return fail(`Error response from daemon: No such container: ${id}`);
    if (format === "{{.Id}}") return ok(`${container.id}\n`);
    if (format === "{{json .Config.Labels}}") return ok(`${JSON.stringify(container.labels)}\n`);
    const inspect = daemonView(container);
    this.options.patchInspect?.(inspect);
    return ok(JSON.stringify(inspect));
  }
}

/** What a daemon would report for a container created with these args (only the fields the backend reads). */
function daemonView(container: FakeContainer): Record<string, unknown> {
  const args = container.createArgs;
  const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const all = (flag: string): string[] => args.flatMap((arg, index) => arg === flag ? [args[index + 1]!] : []);
  const tmpfs = Object.fromEntries(all("--tmpfs").map(entry => [entry.split(":")[0]!, entry.slice(entry.indexOf(":") + 1)]));
  return {
    Id: container.id, Image: FAKE_DIGEST, Created: container.created,
    State: { Running: container.running, ExitCode: container.exitCode, OOMKilled: false },
    Config: { User: value("--user") ?? "", Labels: container.labels, OpenStdin: args.includes("--interactive"), StdinOnce: false,
      Env: [...all("--env"), "NODE_VERSION=22.20.0", "YARN_VERSION=1.22.22"] },
    HostConfig: { Privileged: args.length === 0 ? false : args.includes("--privileged"), CapAdd: null, CapDrop: all("--cap-drop"),
      SecurityOpt: all("--security-opt"), ReadonlyRootfs: args.includes("--read-only"), NetworkMode: value("--network") ?? "bridge",
      PidMode: "", IpcMode: value("--ipc") ?? "shareable", UTSMode: "", UsernsMode: "", CgroupnsMode: value("--cgroupns") ?? "host",
      Memory: Number(value("--memory") ?? 0), MemorySwap: Number(value("--memory-swap") ?? 0),
      NanoCpus: Math.round(Number(value("--cpus") ?? 0) * 1e9),
      PidsLimit: Number(value("--pids-limit") ?? 0), Devices: [], DeviceRequests: null, DeviceCgroupRules: null, Tmpfs: tmpfs,
      Binds: null, LogConfig: { Type: value("--log-driver") ?? "json-file" }, Init: args.includes("--init"),
      MaskedPaths: ["/proc/kcore", "/proc/keys"] },
    Mounts: [],
  };
}
