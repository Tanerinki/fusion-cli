import { mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { FusionFailure } from "../core/errors.js";
import { ProcessGitClient } from "../platform/workspace/git.js";
import { validateTaskText } from "./commands.js";
import { CONFIG_FILE, parseConfig, type FusionConfig } from "./config.js";
import { CREATE_FAMILIES, inferFamily, SERVICES, templateFiles, TEMPLATE_VERIFICATION, UNSUPPORTED_STACKS, type CreateFamily,
  type ServiceIntegration } from "./create-templates.js";

/**
 * v0.1 — `fusion create "<description>"`: supported-scope greenfield creation, honest and narrow.
 *
 *   1. PLAN (no writes, no provider): the project family (`--template`, or inferred from the description), its name and
 *      directory, the external services the description names. A stack v0.1 does not create is refused, with the
 *      supported alternative.
 *   2. SCAFFOLD (Fusion owns the filesystem): a new directory — never inside an existing Git working tree, never an
 *      existing non-empty directory — with the deterministic template, a `fusion.config.json` (the configured bindings and
 *      the template's confined verification), and a Git baseline commit.
 *   3. BUILD: the normal, confirmed `fusion build` in that new repository — Lead plan, read-only Change Author, private
 *      candidates, confined verification, fresh review, correction — ending in a delivery the human approves and applies.
 *
 * No provider runs a scaffolding command; no dependency is installed; no credential is ever written.
 */
export interface CreatePlan {
  readonly description: string;
  readonly family: CreateFamily;
  readonly familySource: "template" | "inferred" | "default";
  readonly name: string;
  readonly directory: string;
  readonly services: readonly ServiceIntegration[];
}
export interface CreateInput {
  readonly description: string;
  readonly template?: string;
  readonly name?: string;
}
const NAME = /^[a-z0-9][a-z0-9-]{0,49}$/u;
const STOP = new Set(["a", "an", "the", "for", "with", "and", "or", "of", "to", "in", "on", "build", "create", "make", "write", "small", "simple", "new",
  "that", "which", "who", "by", "from", "into", "is", "are", "it", "its", "my", "our"]);

/** A package/directory name from the description: its first meaningful words, lowercase, hyphenated. */
export function nameFrom(description: string): string {
  const words = description.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^a-z0-9\s-]/gu, " ").split(/\s+/u).filter(word => word.length > 1 && !STOP.has(word));
  const name = words.slice(0, 4).join("-").replace(/-+/gu, "-").slice(0, 40).replace(/-$/u, "");
  return NAME.test(name) ? name : "fusion-project";
}

export function planCreate(cwd: string, input: CreateInput): CreatePlan {
  const description = validateTaskText(input.description);
  const unsupported = UNSUPPORTED_STACKS.filter(stack => stack.pattern.test(description)).map(stack => stack.label);
  if (unsupported.length > 0)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `v0.1 does not create ${[...new Set(unsupported)].join(", ")} projects. ` +
      `Supported: Node.js 22 + TypeScript projects of the families ${CREATE_FAMILIES.join(", ")} (for example: fusion create --template api "a REST API for ..."). ` +
      "Describe the project without the unsupported stack. Nothing was created." });
  if (input.template !== undefined && !(CREATE_FAMILIES as readonly string[]).includes(input.template))
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `--template must be one of ${CREATE_FAMILIES.join(", ")}.` });
  const inferred = inferFamily(description);
  const family = (input.template as CreateFamily | undefined) ?? inferred ?? "library";
  const name = input.name ?? nameFrom(description);
  if (!NAME.test(name))
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: "--name must be lowercase letters, digits and hyphens (at most 50), starting with a letter or digit." });
  const services = [...new Map(SERVICES.filter(entry => entry.pattern.test(description)).map(entry => [entry.service.id, entry.service])).values()];
  return Object.freeze({ description, family, familySource: input.template !== undefined ? "template" : inferred !== undefined ? "inferred" : "default",
    name, directory: resolve(cwd, name), services });
}

/** The build task the created project's first build runs (bounded like any task). */
export function createTask(plan: CreatePlan): string {
  return validateTaskText([`Implement this new ${plan.family} project: ${plan.description.trim().replace(/[.!?]*$/u, ".")}`,
    "Start from the existing scaffold (read README.md, package.json, src/ and test/ first).",
    "Keep Node.js 22.18+ with TypeScript run by Node's type stripping and the stock node:test runner; add tests under test/ for every behaviour you add.",
    "Do not add dependencies: none can be installed in this version.",
    ...(plan.services.length > 0 ? ["Read external-service settings only through src/config.ts; never write credentials or example secrets."] : [])].join(" "));
}

/**
 * Refuses a target a new project may not use: a location inside an existing Git working tree (a new project is its own
 * repository) or an existing non-empty directory. Checked before the human is asked, and again right before writing.
 */
export async function checkCreateTarget(plan: CreatePlan, env: NodeJS.ProcessEnv): Promise<Readonly<{ git: ProcessGitClient; existing: boolean }>> {
  const git = await ProcessGitClient.fromPath(env, true);
  const parent = dirname(plan.directory);
  const inside = await git.run(["rev-parse", "--show-toplevel"], { cwd: parent }).catch(() => undefined);
  if (inside?.exitCode === 0)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false,
      safeMessage: `${parent} is inside an existing Git repository; create the project somewhere else (it becomes its own repository). Nothing was created.` });
  const existing = await readdir(plan.directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error));
  if (existing !== undefined && existing.length > 0)
    throw new FusionFailure({ kind: "InvalidInput", retryable: false, safeMessage: `${plan.directory} already exists and is not empty. Nothing was created.` });
  return { git, existing: existing !== undefined };
}

/** Creates the project directory with the template, its configuration and a Git baseline (after {@link checkCreateTarget}). */
export async function scaffoldProject(plan: CreatePlan, env: NodeJS.ProcessEnv, bindings: FusionConfig["bindings"]):
  Promise<Readonly<{ root: string; baseCommit: string }>> {
  const { git, existing } = await checkCreateTarget(plan, env);
  if (!existing) await mkdir(plan.directory);
  const root = await realpath(plan.directory);
  const files = templateFiles({ family: plan.family, name: plan.name, description: plan.description, services: plan.services });
  const config = parseConfig({ schemaVersion: 1, bindings, verification: { commands: [], ...TEMPLATE_VERIFICATION,
    confinedCommands: TEMPLATE_VERIFICATION.confinedCommands.map(command => ({ ...command, args: [...command.args] })) },
    limits: { runTimeoutMs: 30 * 60_000 } });
  files[CONFIG_FILE] = `${JSON.stringify(config, null, 2)}\n`;
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, ...path.split("/"))), { recursive: true });
    await writeFile(join(root, ...path.split("/")), content, { flag: "wx" });
  }
  const run = async (args: string[]) => {
    const result = await git.run(args, { cwd: root });
    if (result.exitCode !== 0) throw new FusionFailure({ kind: "InternalError", retryable: false, safeMessage: `The project baseline could not be committed (git ${args.find(a => !a.startsWith("-"))}).` });
    return result.stdout;
  };
  await run(["-c", "init.defaultBranch=main", "init", "-q"]);
  await run(["-c", "core.autocrlf=false", "add", "--all"]);
  await run(["-c", "user.name=Fusion", "-c", "user.email=fusion-create@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false",
    "commit", "-q", "-m", `fusion create: ${plan.family} template for ${basename(root)}`]);
  return Object.freeze({ root, baseCommit: (await run(["rev-parse", "--verify", "HEAD"])).trim() });
}
