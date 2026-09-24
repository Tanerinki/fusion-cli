import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DockerCommandRunner, DockerInvocation, DockerOutcome } from "../../src/platform/verification/docker/cli.js";
import { assertSafeDockerArgs } from "../../src/platform/verification/docker/config.js";
import type { GuestCommand, VerifyManifest } from "../../src/platform/verification/docker/protocol.js";

/**
 * Test-only in-memory stand-in for the docker CLI + daemon. It never spawns anything. Every argv it receives is first
 * checked by the production `assertSafeDockerArgs`, container state is derived from the real `create` argv (so the
 * daemon facts reflect exactly what the builder produced), and every invocation is recorded for assertions.
 */
export const FAKE_DIGEST = `sha256:${"ab".repeat(32)}`;
export const FAKE_IMAGE = `node@${FAKE_DIGEST}`;
export const FAKE_DOCKER_EXE = "C:\\fake\\docker.exe";

export interface FakeContainer {
  readonly id: string;
  readonly name: string;
  readonly createArgs: readonly string[];
  labels: Record<string, string>;
  running: boolean;
  exitCode: number;
  removed: boolean;
}
export interface AttachContext {
  readonly manifest: VerifyManifest;
  readonly inputDirectory: string;
  readonly invocation: DockerInvocation;
}
export type AttachReply = Partial<DockerOutcome> & Readonly<{ containerExitCode?: number }>;
export interface FakeDockerOptions {
  readonly version?: "linux" | "windows" | "noServer" | "malformed" | "duplicateKey" | "exitFailure";
  readonly image?: "present" | "absent" | "wrongOs" | "wrongDigest";
  /** Produces the verify guest's stdout; default: every command passes. */
  readonly attach?: (context: AttachContext) => AttachReply | Promise<AttachReply>;
  readonly rmFails?: boolean;
  /** Extra containers returned by label-filtered `ps` (e.g. foreign ones). */
  readonly extraListed?: readonly Readonly<{ id: string; labels: Record<string, string> }>[];
  /** Mutate the daemon's view of a container's config (to simulate a weakened container). */
  readonly patchInspect?: (inspect: Record<string, unknown>) => void;
}

const ok = (stdout = "", extra: Partial<DockerOutcome> = {}): DockerOutcome =>
  ({ status: "exited", exitCode: 0, stdout, stderr: "", durationMs: 1, ...extra });
const fail = (stderr: string, exitCode = 1): DockerOutcome => ({ status: "exited", exitCode, stdout: "", stderr, durationMs: 1 });

export function passingResult(manifest: VerifyManifest, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ protocolVersion: 1, mode: "verify", nonce: manifest.nonce,
    copy: { files: 1, directories: 0, bytes: 10, durationMs: 0 },
    commands: manifest.commands.map((command: GuestCommand) => ({ id: command.id, status: "exited", exitCode: 0, signal: null,
      durationMs: 0, stdoutTail: "ok\n", stderrTail: "", stdoutBytes: 3, stderrBytes: 0 })),
    notRun: [], complete: true, ...overrides });
}

export class FakeDocker implements DockerCommandRunner {
  readonly calls: string[][] = [];
  readonly containers = new Map<string, FakeContainer>();
  #next = 0;
  constructor(private options: FakeDockerOptions = {}) {}
  /** Changes behaviour mid-test, e.g. a daemon that goes away after a lease was prepared. */
  configure(options: FakeDockerOptions): void { this.options = { ...this.options, ...options }; }

  commands(name: string): string[][] { return this.calls.filter(args => args[0] === name); }

  async run(invocation: DockerInvocation): Promise<DockerOutcome> {
    const args = [...invocation.args];
    assertSafeDockerArgs(args);
    this.calls.push(args);
    switch (args[0]) {
      case "version": return this.#version();
      case "image": return this.#image();
      case "create": return this.#create(args);
      case "start": return this.#start(args, invocation);
      case "container": return this.#inspect(args);
      case "kill": { const container = this.#live(args[1]!); if (container) container.running = false; return ok(); }
      case "rm": {
        if (this.options.rmFails) return fail("Error response from daemon: removal failed");
        const container = this.#live(args[2]!);
        if (!container) return fail(`Error response from daemon: No such container: ${args[2]}`);
        container.removed = true; container.running = false;
        return ok(`${container.id}\n`);
      }
      case "ps": {
        const run = args[args.indexOf("--filter") + 1]!.split("=").pop()!;
        const ids = [...this.containers.values()].filter(entry => !entry.removed && entry.labels["fusion.run"] === run)
          .map(entry => entry.id).concat((this.options.extraListed ?? []).map(entry => entry.id));
        return ok(ids.map(id => `${id}\n`).join(""));
      }
      case "wait": return new Promise(resolve => setTimeout(() => resolve({ status: "timeout", exitCode: null, stdout: "",
        stderr: "", durationMs: invocation.timeoutMs }), Math.min(invocation.timeoutMs, 20)));
      case "top": {
        const container = this.#live(args[1]!);
        if (!container) return fail(`Error response from daemon: No such container: ${args[1]}`);
        if (!container.running) return fail("container is not running");
        const marker = container.createArgs.at(-1) === "descendant" ? (JSON.parse(readFileSync(
          join(inputDirectory(container.createArgs), "canary.json"), "utf8")) as { descendantMarker: string }).descendantMarker : "";
        return ok(`PID COMMAND\n1 /sbin/docker-init -- /usr/local/bin/node /fusion/input/runner.mjs\n9 node -e x ${marker}\n`);
      }
      default: return fail("unsupported");
    }
  }

  #live(id: string): FakeContainer | undefined {
    const container = this.containers.get(id) ?? (this.options.extraListed ?? []).find(entry => entry.id === id) as FakeContainer | undefined;
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
      Os: mode === "wrongOs" ? "windows" : "linux", Architecture: "amd64",
      Config: { Env: ["PATH=/usr/local/bin", "NODE_VERSION=22.20.0", "YARN_VERSION=1.22.22"] } }));
  }

  #create(args: string[]): DockerOutcome {
    const id = createHash("sha256").update(`container-${this.#next++}`).digest("hex");
    const labels: Record<string, string> = {};
    args.forEach((arg, index) => {
      if (arg === "--label") { const [key, ...rest] = args[index + 1]!.split("="); labels[key!] = rest.join("="); }
    });
    this.containers.set(id, { id, name: args[args.indexOf("--name") + 1]!, createArgs: args, labels, running: false, exitCode: 0,
      removed: false });
    return ok(`${id}\n`);
  }

  async #start(args: string[], invocation: DockerInvocation): Promise<DockerOutcome> {
    const attached = args[1] === "--attach";
    const container = this.#live(attached ? args[2]! : args[1]!);
    if (!container) return fail("No such container");
    container.running = true;
    if (!attached) return ok(`${container.id}\n`);
    const mode = container.createArgs.at(-1);
    const input = inputDirectory(container.createArgs);
    if (mode !== "verify") { container.running = false; container.exitCode = 2; return { ...ok(), exitCode: 2 }; }
    const manifest = JSON.parse(readFileSync(join(input, "manifest.json"), "utf8")) as VerifyManifest;
    const attach = this.options.attach ?? ((context: AttachContext): AttachReply => ({ stdout: `${passingResult(context.manifest)}\n` }));
    const reply: AttachReply = await attach({ manifest, inputDirectory: input, invocation });
    const status = reply.status ?? "exited";
    if (status === "exited") { container.running = false; container.exitCode = reply.containerExitCode ?? reply.exitCode ?? 0; }
    return { status, exitCode: status === "exited" ? container.exitCode : null, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "",
      durationMs: 5 };
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

export function inputDirectory(createArgs: readonly string[]): string {
  const mount = createArgs[createArgs.indexOf("--mount") + 1]!;
  return mount.split(",").find(part => part.startsWith("source="))!.slice("source=".length);
}

/** What a daemon would report for a container created with these args (only the fields the backend reads). */
function daemonView(container: FakeContainer): Record<string, unknown> {
  const args = container.createArgs;
  const value = (flag: string): string | undefined => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
  const all = (flag: string): string[] => args.flatMap((arg, index) => arg === flag ? [args[index + 1]!] : []);
  const tmpfs = Object.fromEntries(all("--tmpfs").map(entry => [entry.split(":")[0]!, entry.slice(entry.indexOf(":") + 1)]));
  const memory = Number(value("--memory") ?? 0);
  return {
    Id: container.id, Image: FAKE_DIGEST,
    State: { Running: container.running, ExitCode: container.exitCode, OOMKilled: false },
    Config: { User: value("--user") ?? "", Labels: container.labels,
      Env: [...all("--env"), "NODE_VERSION=22.20.0", "YARN_VERSION=1.22.22"] },
    HostConfig: { Privileged: args.includes("--privileged"), CapAdd: null, CapDrop: all("--cap-drop"),
      SecurityOpt: all("--security-opt"), ReadonlyRootfs: args.includes("--read-only"), NetworkMode: value("--network") ?? "bridge",
      PidMode: "", IpcMode: value("--ipc") ?? "shareable", UTSMode: "", UsernsMode: "", CgroupnsMode: value("--cgroupns") ?? "host",
      Memory: memory, MemorySwap: Number(value("--memory-swap") ?? 0), NanoCpus: Math.round(Number(value("--cpus") ?? 0) * 1e9),
      PidsLimit: Number(value("--pids-limit") ?? 0), Devices: [], DeviceRequests: null, DeviceCgroupRules: null, Tmpfs: tmpfs,
      Binds: null, LogConfig: { Type: value("--log-driver") ?? "json-file" }, Init: args.includes("--init"),
      MaskedPaths: ["/proc/kcore", "/proc/keys"] },
    Mounts: [{ Type: "bind", Source: inputDirectory(args), Destination: "/fusion/input",
      RW: !(value("--mount") ?? "").endsWith(",readonly") }],
  };
}
