#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseConfig, type BindingConfig } from "../../src/app/config.js";
import { buildWriterCandidates, type ProviderRegistry } from "../../src/app/providers.js";
import { ROUTE_ROLES, type RouteRole } from "../../src/app/route-probe.js";
import { providerViewPort, WRITER_ROLES, type ProductionWriterOptions, type WriterComposition } from "../../src/app/writer-composition.js";
import { EXIT_CODES } from "../../src/cli/failure-presentation.js";
import { createInterruptHandler, runCli } from "../../src/cli/run.js";
import { DockerLinuxVerificationBackend } from "../../src/platform/verification/docker/backend.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../../src/platform/workspace/git.js";
import { transportProfile } from "../../src/runtime/provider-profiles.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fake-docker.js";
import { oracle, testSummary } from "./fake-writer.js";
import { installMuseVersion, withInstalls, type Installs } from "./provider-installs.js";
import { routeRegistry, testRouteAuthorization, testRouteBindings } from "./route-harness.js";

/**
 * TEST-ONLY PRODUCT HARNESS for black-box acceptance: the process a user starts with `fusion`, wired exactly as
 * `src/cli/main.js` wires it (runCli, the interrupt handler with per-step scopes, the terminal prompt contract), with the two
 * seams a scripted run needs and a real terminal cannot provide:
 *
 *   - stdin LINES instead of a TTY: each prompt is written to stdout, the next stdin line is the answer and is echoed like a
 *     terminal echoes typing; end of input answers null (as Ctrl+C or EOF does).
 *   - the REAL Claude and Muse adapters on their scripted FAKE binaries (test/fixtures/*-fake.mjs) instead of installed
 *     provider CLIs. `FUSION_HARNESS_MUSE=1.4` installs the fake as Muse 1.4.0-R4161.1 with its binding-scoped validation for
 *     the Reviewer only, re-pinned to the fake's bytes — the posture the maintainer's machine has.
 *
 * It is started in the Fusion checkout (the fakes resolve from there); FUSION_HARNESS_WORKSPACE is the folder the user would start
 * `fusion` in — the host's working directory, as `main.js` passes `process.cwd()`.
 * Environment: FUSION_HARNESS_SCRIPTS (a directory with `<Role>.json` scripted turns, whose `.prompts.jsonl` and
 * `.views.jsonl` logs the fakes write beside them), FUSION_HARNESS_VERIFICATION (JSON verification config),
 * FUSION_HARNESS_COMPOSE (`production` — the real composition, Docker included — or `offline`). Never used in production.
 */
const ROLES = [...ROUTE_ROLES, "Explorer"] as const;
type HarnessRole = (typeof ROLES)[number];
const scripts = process.env.FUSION_HARNESS_SCRIPTS;
if (scripts === undefined) { process.stderr.write("fusion-shell-harness: FUSION_HARNESS_SCRIPTS is required\n"); process.exit(2); }

const lines: string[] = [];
let waiting: ((line: string | null) => void) | undefined, ended = false;
const input = createInterface({ input: process.stdin, terminal: false });
input.on("line", line => { if (waiting !== undefined) { const answer = waiting; waiting = undefined; answer(line); } else lines.push(line); });
input.on("close", () => { ended = true; if (waiting !== undefined) { const answer = waiting; waiting = undefined; answer(null); } });
async function prompt(question: string): Promise<string | null> {
  process.stdout.write(question);
  const line = lines.length > 0 ? lines.shift()! : ended ? null : await new Promise<string | null>(resolve => { waiting = resolve; });
  process.stdout.write(`${line ?? ""}\n`);
  return line;
}

async function sha256Of(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }

function offlineCompose(dir: string): (options: ProductionWriterOptions) => Promise<WriterComposition> {
  return async options => {
    const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry, { workspace: options.root, env: options.env }, WRITER_ROLES);
    const git = await ProcessGitClient.fromPath(process.env, true);
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: new FakeDocker({ attach: oracle(() => ({ pass: true, stdout: testSummary(1, 0) })) }),
      resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), dependencyStoreDirectory: join(dir, "dependency-store") });
    const verification = options.config.verification;
    const workspace = new PrivateCandidateWorkspacePort({ primaryRoot: options.root, git, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform: verification.platformRequirement, dependencies: verification.dependencies ?? "none",
      prepareDependencies: true });
    return { roles: candidates, unavailable, workspace, views: providerViewPort(options.root, git, options.registry, workspace),
      plan: { commands: [...(verification.confinedCommands ?? [])] }, verification: { acceptance: "offlineRehearsal", reasons: [] } };
  };
}

async function registryFor(i: Installs): Promise<ProviderRegistry> {
  const paths = Object.fromEntries(ROLES.map(role => [role, join(scripts!, `${role}.json`)])) as Record<HarnessRole, string>;
  for (const role of ROLES) await readFile(paths[role]).catch(() => writeFile(paths[role], "[]"));
  let museOptions: Parameters<typeof routeRegistry>[3] = {};
  if (process.env.FUSION_HARNESS_MUSE === "1.4") {
    const release = "1.4.0-R4161.1", exe = join(i.museDir, `muse-bin-${release}.exe`);
    await installMuseVersion(i, release);
    const [recorded] = transportProfile("muse", "muse-exec")!.bindingValidations;
    museOptions = { museBindingValidations: [{ ...recorded!, executableSha256: await sha256Of(exe) }], museExecutable: exe };
  }
  const bindings = testRouteBindings(i, testRouteAuthorization(i));
  // The explorer exactly as the production default binds it: the Reviewer's model, without its step limit and retry policy.
  const explorer: BindingConfig = { role: "Explorer", adapter: "muse-exec", model: bindings.Reviewer.model, effort: bindings.Reviewer.effort,
    options: { provider: "meta", binaryDirectory: i.museDir, versionFile: join(i.museDir, ".muse-version"), timeoutMs: 20_000 } };
  const verification = process.env.FUSION_HARNESS_VERIFICATION ? JSON.parse(process.env.FUSION_HARNESS_VERIFICATION) as object : { commands: [] };
  const config = parseConfig({ schemaVersion: 1, bindings: [bindings.Lead, bindings.Worker, explorer, bindings.Reviewer], verification,
    limits: { runTimeoutMs: 10 * 60_000 } });
  const dump = { FUSION_FAKE_VIEW_DUMP: "1" };
  return { ...routeRegistry(i, paths as unknown as Record<RouteRole, string>, { Lead: dump, Worker: dump, Reviewer: dump, Explorer: dump } as never, museOptions),
    defaults: config };
}

const interrupts = createInterruptHandler(text => { process.stderr.write(text); }, () => process.exit(EXIT_CODES.cancelled));
process.on("SIGINT", interrupts.interrupt);
const code = await withInstalls(async i => {
  const registry = await registryFor(i);
  return runCli(process.argv.slice(2), { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
    interactive: true, prompt }, { env: process.env, cwd: process.env.FUSION_HARNESS_WORKSPACE ?? process.cwd(), signal: interrupts.signal, turnScope: interrupts.turn, registry,
      ...(process.env.FUSION_HARNESS_COMPOSE === "offline" ? { writerComposition: offlineCompose(i.dir) } : {}) });
});
input.close();
process.exitCode = code;
