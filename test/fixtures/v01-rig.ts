import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "../../src/app/config.js";
import { buildWriterCandidates, type ProviderRegistry } from "../../src/app/providers.js";
import { REHEARSAL_PLAN, ROUTE_TASK } from "../../src/app/route-fixture.js";
import { createRouteFixture, ROUTE_ROLES, type RouteRole } from "../../src/app/route-probe.js";
import { providerViewPort, WRITER_ROLES, type ProductionWriterOptions, type WriterComposition } from "../../src/app/writer-composition.js";
import { runCli } from "../../src/cli/run.js";
import { DockerLinuxVerificationBackend } from "../../src/platform/verification/docker/backend.js";
import { VerificationService } from "../../src/platform/verification/selection.js";
import { OFFLINE_REHEARSAL, PrivateCandidateWorkspacePort } from "../../src/platform/workflow/candidates.js";
import { ProcessGitClient } from "../../src/platform/workspace/git.js";
import { FAKE_DOCKER_EXE, FAKE_IMAGE, FakeDocker } from "./fake-docker.js";
import { withInstalls, type Installs } from "./provider-installs.js";
import { routeEnv, routeRegistry, testRouteAuthorization, testRouteBindings, type RoleScripts } from "./route-harness.js";
import { FAKE_DEPENDENCY_TREE } from "./rehearsal-project.js";
import { rehearsalOracle } from "./writer-rehearsal-harness.js";

/**
 * v0.1 — the product rig: the REAL CLI over the route fixture repository, the REAL Claude and Muse adapters on their
 * scripted fake binaries (production registry path), host-controlled private candidates and confined verification on a
 * fake Docker daemon. A fake backend never holds a GRANTED acceptance, so a build here is an offline rehearsal.
 */
export const TASK = ROUTE_TASK.summary;
export const BUILD = ["build", "--path", "src/quote.ts", "--path", "test/quote.test.ts", "--", TASK];

/** The production composition shape over a fake Docker backend: an offline rehearsal (or a refused acceptance). */
export function testCompose(dir: string, acceptance: "offlineRehearsal" | "refused"): (options: ProductionWriterOptions) => Promise<WriterComposition> {
  return async options => {
    const { candidates, unavailable } = await buildWriterCandidates(options.config, options.registry, { workspace: options.root, env: options.env }, WRITER_ROLES);
    const git = await ProcessGitClient.fromPath(process.env, true);
    const backend = new DockerLinuxVerificationBackend({ image: FAKE_IMAGE, runner: new FakeDocker({ attach: rehearsalOracle(), depsTree: FAKE_DEPENDENCY_TREE }),
      resolveDocker: () => Promise.resolve(FAKE_DOCKER_EXE), dependencyStoreDirectory: join(dir, "dependency-store") });
    const verification = options.config.verification;
    const workspace = new PrivateCandidateWorkspacePort({ primaryRoot: options.root, git, service: new VerificationService([backend]),
      confinement: OFFLINE_REHEARSAL, declaredPlatform: verification.platformRequirement, dependencies: verification.dependencies ?? "none",
      prepareDependencies: true, ...(options.config.protection ? { protectedPaths: options.config.protection.ignoredPaths } : {}) });
    return { roles: candidates, unavailable, workspace, views: providerViewPort(options.root, git, options.registry, workspace),
      plan: { commands: [...(verification.confinedCommands ?? [])] },
      verification: { acceptance, reasons: acceptance === "refused" ? ["test: no acceptance"] : [] } };
  };
}

export interface Built { code: number; stdout: string; stderr: string; prompts: Record<RouteRole, string[]>; questions: string[] }
export interface Rig { i: Installs; dir: string; root: string; env: NodeJS.ProcessEnv; registry: ProviderRegistry;
  cli(argv: string[], answers: Array<string | null>): Promise<Built> }
export async function withRig<T>(name: string, scripts: RoleScripts, options: Readonly<{ acceptance?: "offlineRehearsal" | "refused"; confinedPlan?: boolean }>,
  work: (rig: Rig) => Promise<T>): Promise<T> {
  return withInstalls(async i => {
    const dir = join(i.dir, name);
    await mkdir(dir, { recursive: true });
    const root = await createRouteFixture(dir, await ProcessGitClient.fromPath(process.env, true));
    const scriptDir = join(dir, "scripts");
    await mkdir(scriptDir);
    const paths = Object.fromEntries(ROUTE_ROLES.map(role => [role, join(scriptDir, `${role}.json`)])) as Record<RouteRole, string>;
    for (const role of ROUTE_ROLES) await writeFile(paths[role], JSON.stringify(scripts[role] ?? []));
    const bindings = testRouteBindings(i, testRouteAuthorization(i));
    const config = parseConfig({ schemaVersion: 1, bindings: ROUTE_ROLES.map(role => bindings[role]),
      verification: { commands: [], platformRequirement: "linux-compatible", dependencies: "npm-lockfile",
        ...(options.confinedPlan === false ? {} : { confinedCommands: REHEARSAL_PLAN.commands }) },
      limits: { runTimeoutMs: 10 * 60_000 }, protection: { ignoredPaths: ["secrets.local"] } });
    const registry: ProviderRegistry = { ...routeRegistry(i, paths), defaults: config };
    const env = routeEnv({ LOCALAPPDATA: join(dir, "localappdata"), XDG_STATE_HOME: join(dir, "xdg") });
    const rig: Rig = { i, dir, root, env, registry, async cli(argv, answers) {
      let stdout = "", stderr = "";
      const queue = [...answers], questions: string[] = [];
      const code = await runCli(argv, { stdout: t => { stdout += t; }, stderr: t => { stderr += t; }, interactive: answers.length > 0,
        ...(answers.length > 0 ? { prompt: async (question: string) => { questions.push(question); return queue.length > 0 ? queue.shift()! : null; } } : {}) },
        { env, cwd: root, registry, writerComposition: testCompose(dir, options.acceptance ?? "offlineRehearsal") });
      const prompts = Object.fromEntries(await Promise.all(ROUTE_ROLES.map(async role => {
        let text = "";
        try { text = await readFile(`${paths[role]}.prompts.jsonl`, "utf8"); } catch { /* no model turn */ }
        return [role, text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { prompt: string }).prompt)];
      }))) as Record<RouteRole, string[]>;
      return { code, stdout, stderr, prompts, questions };
    } };
    return work(rig);
  });
}
/** Every model turn the scripted fakes saw so far (their prompt logs accumulate across CLI calls in one rig). */
export const modelTurns = (built: Built) => ROUTE_ROLES.reduce((sum, role) => sum + built.prompts[role].length, 0);
/** The output line with this prefix (the last one: a confirmed plan before it has lines of its own). */
export const line = (built: Built, prefix: string) => built.stdout.split("\n").filter(entry => entry.startsWith(prefix)).at(-1);
