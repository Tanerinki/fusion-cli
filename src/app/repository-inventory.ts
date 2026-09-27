import { lstat, readFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { FolderListing } from "../platform/workspace/folder-source.js";
import type { GitClient } from "../platform/workspace/git.js";
import { classifySensitivePath } from "../platform/workspace/sensitive-input.js";

/**
 * v0.1 — the DETERMINISTIC repository inventory behind `fusion analyze` and the context of `fusion chat`: what Fusion itself
 * observes, read-only, without any provider — tracked files by language and directory, package managers and manifests
 * (names, script names, dependency counts, recognised frameworks), entrypoints, tests, CI, containers, configuration,
 * documentation, Git state and recent history, the largest files, and (with a focus) the paths that match it.
 *
 * Bounded everywhere: at most `maxFiles` tracked paths are classified, manifests are read up to 256 KiB, history and lists
 * are capped, and `truncated` says when a bound was hit. Never read: ignored files (`.env` and other secrets are not
 * tracked by a sane repository and are never opened here), file contents other than the recognised manifests.
 */
export interface InventoryOptions {
  /** `--deep`: larger bounds (more files, history, focus matches) — never more rights. */
  readonly deep: boolean;
  /** A focus topic (`auth`, `security`, `architecture`, `testing`, `api`, `data`, `performance`) or a free keyword. */
  readonly focus?: string;
  readonly signal?: AbortSignal;
}
export interface ManifestSummary {
  readonly path: string;
  readonly kind: string;
  readonly name?: string;
  readonly scripts?: readonly Readonly<{ name: string; command: string }>[];
  readonly dependencies?: number;
  readonly devDependencies?: number;
  readonly frameworks?: readonly string[];
  readonly entrypoints?: readonly string[];
}
export interface RepositoryInventory {
  /** v0.2: a Git repository (tracked files) or an ordinary folder (the files a bounded walk found). */
  readonly source: "git" | "folder";
  readonly name: string;
  readonly trackedFiles: number;
  readonly languages: readonly Readonly<{ language: string; files: number }>[];
  readonly directories: readonly Readonly<{ path: string; files: number }>[];
  readonly packageManagers: readonly string[];
  readonly manifests: readonly ManifestSummary[];
  readonly frameworks: readonly string[];
  readonly entrypoints: readonly string[];
  readonly tests: Readonly<{ files: number; directories: readonly string[]; frameworks: readonly string[] }>;
  readonly ci: readonly string[];
  readonly containers: readonly string[];
  readonly config: readonly string[];
  readonly docs: readonly string[];
  readonly git: Readonly<{ branch: string | null; head: string | null; commits: number | null; dirtyPaths: number;
    recent: readonly Readonly<{ hash: string; date: string; subject: string }>[] }>;
  readonly largestFiles: readonly Readonly<{ path: string; bytes: number }>[];
  readonly focus?: Readonly<{ topic: string; pattern: string; paths: readonly string[] }>;
  readonly truncated: boolean;
  /** v0.2: recognised project kinds (for example a Home Assistant configuration) and the files that show it. */
  readonly projects: readonly Readonly<{ kind: string; evidence: readonly string[] }>[];
  /** v0.2: files the input policy never shares in full (by path; contents are not read here), bounded list. */
  readonly sensitive: Readonly<{ count: number; files: readonly Readonly<{ path: string; treatment: "exclude" | "keysOnly"; reason: string }>[] }>;
  /** v0.2 (folders): what the walk skipped (dependency and cache directories, links). */
  readonly skipped?: Readonly<{ directories: readonly string[]; links: number }>;
}

const BOUNDS = { normal: { maxFiles: 20_000, recent: 10, focusPaths: 40, largest: 5, manifests: 12 },
  deep: { maxFiles: 60_000, recent: 30, focusPaths: 120, largest: 10, manifests: 30 } } as const;
const MAX_MANIFEST_BYTES = 256 * 1024;
const LANGUAGES: Readonly<Record<string, string>> = {
  ".ts": "TypeScript", ".tsx": "TypeScript", ".mts": "TypeScript", ".cts": "TypeScript", ".js": "JavaScript", ".jsx": "JavaScript",
  ".mjs": "JavaScript", ".cjs": "JavaScript", ".py": "Python", ".go": "Go", ".rs": "Rust", ".java": "Java", ".kt": "Kotlin",
  ".kts": "Kotlin", ".cs": "C#", ".fs": "F#", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".c": "C", ".h": "C/C++ header",
  ".cc": "C++", ".cpp": "C++", ".hpp": "C/C++ header", ".scala": "Scala", ".dart": "Dart", ".ex": "Elixir", ".exs": "Elixir",
  ".erl": "Erlang", ".clj": "Clojure", ".lua": "Lua", ".r": "R", ".jl": "Julia", ".sh": "Shell", ".ps1": "PowerShell", ".sql": "SQL",
  ".vue": "Vue", ".svelte": "Svelte", ".html": "HTML", ".css": "CSS", ".scss": "SCSS", ".md": "Markdown", ".json": "JSON",
  ".yml": "YAML", ".yaml": "YAML", ".toml": "TOML", ".tf": "Terraform", ".proto": "Protocol Buffers", ".graphql": "GraphQL",
};
const LOCKFILES: ReadonlyArray<readonly [RegExp, string]> = [[/^package-lock\.json$/u, "npm"], [/^npm-shrinkwrap\.json$/u, "npm"],
  [/^pnpm-lock\.yaml$/u, "pnpm"], [/^yarn\.lock$/u, "yarn"], [/^bun\.lockb?$/u, "bun"], [/^poetry\.lock$/u, "poetry"], [/^uv\.lock$/u, "uv"],
  [/^Pipfile(\.lock)?$/u, "pipenv"], [/^requirements[\w.-]*\.txt$/u, "pip"], [/^pyproject\.toml$/u, "python (pyproject)"], [/^go\.mod$/u, "go modules"],
  [/^Cargo\.toml$/u, "cargo"], [/^pom\.xml$/u, "maven"], [/^build\.gradle(\.kts)?$/u, "gradle"], [/^composer\.json$/u, "composer"],
  [/^Gemfile$/u, "bundler"], [/\.(csproj|sln|fsproj)$/u, "dotnet"], [/^mix\.exs$/u, "mix"], [/^pubspec\.yaml$/u, "pub"]];
const FRAMEWORKS: ReadonlyArray<readonly [string, string]> = [["next", "Next.js"], ["react", "React"], ["vue", "Vue"], ["nuxt", "Nuxt"],
  ["svelte", "Svelte"], ["@sveltejs/kit", "SvelteKit"], ["@angular/core", "Angular"], ["express", "Express"], ["fastify", "Fastify"],
  ["koa", "Koa"], ["@nestjs/core", "NestJS"], ["hono", "Hono"], ["prisma", "Prisma"], ["@prisma/client", "Prisma"], ["typeorm", "TypeORM"],
  ["drizzle-orm", "Drizzle"], ["sequelize", "Sequelize"], ["mongoose", "Mongoose"], ["pg", "node-postgres"], ["graphql", "GraphQL"],
  ["jest", "Jest"], ["vitest", "Vitest"], ["mocha", "Mocha"], ["@playwright/test", "Playwright"], ["cypress", "Cypress"], ["vite", "Vite"],
  ["webpack", "webpack"], ["electron", "Electron"], ["tailwindcss", "Tailwind CSS"], ["zod", "Zod"], ["typescript", "TypeScript compiler"]];
const TEST_FRAMEWORKS = new Set(["Jest", "Vitest", "Mocha", "Playwright", "Cypress"]);
const FOCUS_PATTERNS: Readonly<Record<string, string>> = {
  auth: "auth|login|logout|session|token|jwt|oauth|password|passport|credential|permission|rbac",
  security: "eval\\(|exec\\(|child_process|spawn\\(|innerHTML|dangerouslySetInnerHTML|sql|crypto|secret|password|token|sanitiz|csrf|cors|helmet|deseriali",
  testing: "describe\\(|it\\(|test\\(|assert|expect\\(|pytest|unittest",
  api: "router|route|endpoint|controller|app\\.(get|post|put|delete|patch)|@(Get|Post|Put|Delete)|openapi|graphql",
  data: "schema|migration|model|repository|database|prisma|sequelize|typeorm|mongoose|knex|sql",
  performance: "cache|memo|debounce|throttle|worker|queue|batch|pool|index",
};

async function git(client: GitClient, root: string, args: string[], signal?: AbortSignal, maxStdoutBytes = 16 * 1024 * 1024): Promise<string | undefined> {
  const result = await client.run(args, { cwd: root, maxStdoutBytes, ...(signal ? { signal } : {}) }).catch(() => undefined);
  return result?.exitCode === 0 ? result.stdout : undefined;
}
const byCount = (counts: Map<string, number>, limit: number) => [...counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
  .slice(0, limit);
const oneLine = (text: string, max: number) => { const line = text.replace(/\s+/gu, " ").trim(); return line.length > max ? `${line.slice(0, max - 1)}…` : line; };

/** Inventories the repository at `root` (its top level) with an isolated-config Git client; read-only. */
export async function inventoryRepository(root: string, client: GitClient, options: InventoryOptions): Promise<RepositoryInventory> {
  const bounds = options.deep ? BOUNDS.deep : BOUNDS.normal;
  const listing = await git(client, root, ["ls-files", "-z", "--cached"], options.signal) ?? "";
  const all = listing.split("\0").filter(Boolean);
  let truncated = all.length > bounds.maxFiles;
  const files = all.slice(0, bounds.maxFiles);
  const languages = new Map<string, number>(), directories = new Map<string, number>();
  const packageManagers = new Set<string>(), ci: string[] = [], containers: string[] = [], config: string[] = [], docs: string[] = [];
  const manifestPaths: string[] = [], testDirs = new Map<string, number>();
  let testFiles = 0;
  for (const path of files) {
    const name = basename(path), lower = path.toLowerCase(), ext = extname(name).toLowerCase();
    const language = LANGUAGES[ext];
    if (language !== undefined) languages.set(language, (languages.get(language) ?? 0) + 1);
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    directories.set(top, (directories.get(top) ?? 0) + 1);
    for (const [pattern, manager] of LOCKFILES) if (pattern.test(name)) packageManagers.add(manager);
    if (name === "package.json" && !lower.includes("node_modules/")) manifestPaths.push(path);
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path) || /^\.gitlab-ci\.ya?ml$/u.test(path) || /^azure-pipelines\.ya?ml$/u.test(path) ||
        /^\.circleci\//u.test(path) || /^Jenkinsfile$/u.test(path) || /^\.buildkite\//u.test(path) || /^bitbucket-pipelines\.yml$/u.test(path)) ci.push(path);
    if (/(^|\/)(Dockerfile|Containerfile)[^/]*$/u.test(path) || /(^|\/)(docker-)?compose[^/]*\.ya?ml$/u.test(path) || lower.startsWith(".devcontainer/"))
      containers.push(path);
    if (!path.includes("/") && /^(tsconfig[\w.-]*\.json|\.eslintrc[\w.]*|eslint\.config\.[cm]?[jt]s|\.prettierrc[\w.]*|prettier\.config\.[cm]?js|vite\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|webpack\.config\.[cm]?js|jest\.config\.[\w.]+|vitest\.config\.[\w.]+|babel\.config\.[\w.]+|\.editorconfig|Makefile|\.nvmrc|\.node-version|\.tool-versions|setup\.cfg|tox\.ini|pytest\.ini|\.env\.example|\.env\.sample)$/u.test(name))
      config.push(path);
    if (/^readme(\.\w+)?$/iu.test(name) || lower.startsWith("docs/") || /^(contributing|changelog|security|architecture)(\.\w+)?$/iu.test(name))
      docs.push(path);
    if (/(^|\/)(tests?|__tests__|spec|specs|e2e)\//u.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(name) || /^test_.*\.py$/u.test(name) || /_test\.go$/u.test(name)) {
      testFiles++;
      const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".";
      const key = dir.split("/").slice(0, 2).join("/");
      testDirs.set(key, (testDirs.get(key) ?? 0) + 1);
    }
  }
  // Manifests (package.json): names, scripts, dependency counts, frameworks, entrypoints — never other file content.
  const manifests: ManifestSummary[] = [], frameworks = new Set<string>(), entrypoints = new Set<string>();
  const ordered = manifestPaths.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  if (ordered.length > bounds.manifests) truncated = true;
  for (const path of ordered.slice(0, bounds.manifests)) {
    const summary = await packageSummary(root, path);
    if (summary === undefined) continue;
    manifests.push(summary);
    for (const framework of summary.frameworks ?? []) frameworks.add(framework);
    for (const entry of summary.entrypoints ?? []) entrypoints.add(entry);
  }
  for (const path of files) {
    if (entrypoints.size >= 16) break;
    if (/^(src\/)?(main|index|app|server|cli)\.[cm]?[jt]sx?$/u.test(path) || /^cmd\/[^/]+\/main\.go$/u.test(path) || /^main\.go$/u.test(path) ||
        /^(manage|app|main|wsgi|asgi)\.py$/u.test(path) || /^src\/main\.rs$/u.test(path) || /^Program\.cs$/u.test(basename(path)))
      entrypoints.add(path);
  }
  // Git state and recent history (subjects only, bounded; no author identities).
  const branch = (await git(client, root, ["rev-parse", "--abbrev-ref", "HEAD"], options.signal))?.trim() ?? null;
  const head = (await git(client, root, ["rev-parse", "--short=12", "HEAD"], options.signal))?.trim() ?? null;
  const count = (await git(client, root, ["rev-list", "--count", "HEAD"], options.signal))?.trim();
  const status = await git(client, root, ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"], options.signal) ?? "";
  const log = await git(client, root, ["log", `-n${bounds.recent}`, "--date=short", "--format=%h%x09%ad%x09%s"], options.signal) ?? "";
  const recent = log.split(/\r?\n/u).filter(Boolean).map(line => { const [hash = "", date = "", ...rest] = line.split("\t");
    return { hash, date, subject: oneLine(rest.join("\t"), 100) }; });
  // The largest tracked files (sizes only).
  const sized: Array<{ path: string; bytes: number }> = [];
  for (const path of files.slice(0, options.deep ? 20_000 : 5_000)) {
    const info = await lstat(join(root, ...path.split("/"))).catch(() => undefined);
    if (info?.isFile()) sized.push({ path, bytes: info.size });
  }
  sized.sort((a, b) => b.bytes - a.bytes);
  // Focus: tracked paths whose name or content matches (Git's own search over tracked files; paths only).
  let focus: RepositoryInventory["focus"];
  if (options.focus !== undefined && options.focus.trim().length > 0) {
    const topic = options.focus.trim().toLowerCase();
    const pattern = FOCUS_PATTERNS[topic] ?? topic.replace(/[^a-z0-9_-]/gu, "");
    const paths = new Set<string>();
    if (topic !== "architecture" && pattern.length > 0) {
      const regex = new RegExp(pattern, "iu");
      for (const path of files) { if (paths.size >= bounds.focusPaths) break; if (regex.test(path)) paths.add(path); }
      const grep = await git(client, root, ["grep", "-l", "-i", "-I", "-E", "-e", pattern, "--", "."], options.signal, 2 * 1024 * 1024) ?? "";
      for (const path of grep.split(/\r?\n/u).filter(Boolean)) { if (paths.size >= bounds.focusPaths) { truncated = true; break; } paths.add(path); }
    }
    focus = { topic, pattern: topic === "architecture" ? "(module map)" : pattern, paths: [...paths].sort() };
  }
  const testFrameworks = [...frameworks].filter(name => TEST_FRAMEWORKS.has(name));
  return Object.freeze({
    name: basename(root), trackedFiles: all.length,
    languages: byCount(languages, 12).map(([language, n]) => ({ language, files: n })),
    directories: byCount(directories, 20).map(([path, n]) => ({ path, files: n })),
    packageManagers: [...packageManagers].sort(), manifests, frameworks: [...frameworks].sort(), entrypoints: [...entrypoints].slice(0, 16),
    tests: { files: testFiles, directories: byCount(testDirs, 8).map(([dir]) => dir), frameworks: testFrameworks },
    ci: ci.slice(0, 20), containers: containers.slice(0, 20), config: config.slice(0, 30), docs: docs.slice(0, 20),
    git: { branch, head, commits: count !== undefined && /^\d+$/u.test(count) ? Number(count) : null,
      dirtyPaths: status.split("\0").filter(Boolean).length, recent },
    largestFiles: sized.slice(0, bounds.largest), ...(focus ? { focus } : {}), truncated,
    source: "git", projects: detectProjects(files), sensitive: sensitiveFiles(files) });
}

async function packageSummary(root: string, path: string): Promise<ManifestSummary | undefined> {
  const absolute = join(root, ...path.split("/"));
  const info = await lstat(absolute).catch(() => undefined);
  if (!info?.isFile() || info.size > MAX_MANIFEST_BYTES) return { path, kind: "package.json (unread: missing or too large)" };
  let value: Record<string, unknown>;
  try { value = JSON.parse(await readFile(absolute, "utf8")) as Record<string, unknown>; }
  catch { return { path, kind: "package.json (unparseable)" }; }
  const record = (x: unknown): Record<string, unknown> => x !== null && typeof x === "object" && !Array.isArray(x) ? x as Record<string, unknown> : {};
  const deps = record(value.dependencies), dev = record(value.devDependencies);
  const names = new Set([...Object.keys(deps), ...Object.keys(dev), ...Object.keys(record(value.peerDependencies))]);
  const frameworks = [...new Set(FRAMEWORKS.filter(([dep]) => names.has(dep)).map(([, label]) => label))];
  const scripts = Object.entries(record(value.scripts)).filter(([, command]) => typeof command === "string").slice(0, 24)
    .map(([name, command]) => ({ name: oneLine(name, 40), command: oneLine(command as string, 120) }));
  const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : "";
  const entrypoints: string[] = [];
  if (typeof value.main === "string") entrypoints.push(`${dir}${value.main}`);
  if (typeof value.bin === "string") entrypoints.push(`${dir}${value.bin}`);
  for (const target of Object.values(record(value.bin))) if (typeof target === "string") entrypoints.push(`${dir}${target}`);
  return { path, kind: "package.json", ...(typeof value.name === "string" ? { name: oneLine(value.name, 80) } : {}), scripts,
    dependencies: Object.keys(deps).length, devDependencies: Object.keys(dev).length, frameworks, entrypoints: entrypoints.slice(0, 8) };
}

/** The inventory as compact text — for the human and as Fusion-observed context of a conversation (bounded by the caller). */
/** Home Assistant's configuration layout, recognised by its files (a configuration folder is usually not a Git repository). */
const HOME_ASSISTANT_FILES = [/^configuration\.ya?ml$/u, /^automations\.ya?ml$/u, /^scripts\.ya?ml$/u, /^scenes\.ya?ml$/u, /^groups\.ya?ml$/u,
  /^customize\.ya?ml$/u, /^secrets\.ya?ml$/u, /^ui-lovelace\.ya?ml$/u, /^packages\//u, /^custom_components\/[^/]+\/manifest\.json$/u,
  /^blueprints\//u, /^themes\//u, /^\.storage\//u];
function detectProjects(files: readonly string[]): RepositoryInventory["projects"] {
  const projects: Array<{ kind: string; evidence: string[] }> = [];
  if (files.some(path => /^configuration\.ya?ml$/u.test(path)) &&
      files.some(path => /^(automations|scripts|scenes)\.ya?ml$|^custom_components\/|^\.storage\//u.test(path))) {
    const evidence = new Set<string>();
    for (const path of files) {
      if (!HOME_ASSISTANT_FILES.some(pattern => pattern.test(path))) continue;
      evidence.add(/^(packages|blueprints|themes|\.storage)\//u.test(path) ? `${path.split("/")[0]}/` : path);
      if (evidence.size >= 16) break;
    }
    projects.push({ kind: "Home Assistant configuration", evidence: [...evidence].sort() });
  }
  return projects;
}
function sensitiveFiles(files: readonly string[]): RepositoryInventory["sensitive"] {
  const found: Array<{ path: string; treatment: "exclude" | "keysOnly"; reason: string }> = [];
  const directories = new Set<string>();
  let count = 0;
  for (const path of files) {
    const sensitive = classifySensitivePath(path);
    if (sensitive === undefined) continue;
    count++;
    // One entry per withheld directory (for example `.storage/`), one per file otherwise.
    const segments = path.split("/");
    const index = segments.slice(0, -1).findIndex(segment => classifySensitivePath(`${segment}/x`) !== undefined);
    const shown = index >= 0 ? `${segments.slice(0, index + 1).join("/")}/` : path;
    if (directories.has(shown)) continue;
    directories.add(shown);
    if (found.length < 40) found.push({ path: shown, treatment: sensitive.treatment, reason: sensitive.reason });
  }
  return { count, files: found };
}

/**
 * v0.2 — the inventory of an ORDINARY FOLDER (no Git), from a bounded walk: the same kind of classification as a repository's
 * (the walked files stand in for tracked ones), no Git state, and what the walk skipped. Nothing is written; only the
 * recognised manifests are read (and, with a focus, small non-sensitive text files are searched).
 */
export async function inventoryFolder(root: string, listing: FolderListing, options: InventoryOptions): Promise<RepositoryInventory> {
  const bounds = options.deep ? BOUNDS.deep : BOUNDS.normal;
  const all = listing.entries.map(entry => entry.path);
  const files = all.slice(0, bounds.maxFiles);
  const sizeOf = new Map(listing.entries.map(entry => [entry.path, entry.bytes]));
  const languages = new Map<string, number>(), directories = new Map<string, number>(), packageManagers = new Set<string>();
  const config: string[] = [], docs: string[] = [], ci: string[] = [], containers: string[] = [], manifestPaths: string[] = [];
  const testDirs = new Map<string, number>();
  let testFiles = 0;
  for (const path of files) {
    const name = basename(path), lower = path.toLowerCase(), language = LANGUAGES[extname(name).toLowerCase()];
    if (language !== undefined) languages.set(language, (languages.get(language) ?? 0) + 1);
    const top = path.includes("/") ? path.slice(0, path.indexOf("/")) : ".";
    directories.set(top, (directories.get(top) ?? 0) + 1);
    for (const [pattern, manager] of LOCKFILES) if (pattern.test(name)) packageManagers.add(manager);
    if (name === "package.json") manifestPaths.push(path);
    if (/^\.github\/workflows\/[^/]+\.ya?ml$/u.test(path)) ci.push(path);
    if (/(^|\/)(Dockerfile|Containerfile)[^/]*$/u.test(path) || /(^|\/)(docker-)?compose[^/]*\.ya?ml$/u.test(path)) containers.push(path);
    if (!path.includes("/") && /\.(ya?ml|json|toml|ini|conf|cfg)$/iu.test(name) && classifySensitivePath(path) === undefined) config.push(path);
    if (/^readme(\.\w+)?$/iu.test(name) || lower.startsWith("docs/")) docs.push(path);
    if (/(^|\/)(tests?|__tests__|spec|specs)\//u.test(path) || /\.(test|spec)\.[cm]?[jt]sx?$/u.test(name) || /^test_.*\.py$/u.test(name)) {
      testFiles++;
      const key = (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ".").split("/").slice(0, 2).join("/");
      testDirs.set(key, (testDirs.get(key) ?? 0) + 1);
    }
  }
  const manifests: ManifestSummary[] = [], frameworks = new Set<string>(), entrypoints = new Set<string>();
  for (const path of manifestPaths.sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1)).slice(0, bounds.manifests)) {
    const summary = await packageSummary(root, path);
    if (summary === undefined) continue;
    manifests.push(summary);
    for (const framework of summary.frameworks ?? []) frameworks.add(framework);
    for (const entry of summary.entrypoints ?? []) entrypoints.add(entry);
  }
  let focus: RepositoryInventory["focus"];
  if (options.focus !== undefined && options.focus.trim().length > 0) {
    const topic = options.focus.trim().toLowerCase();
    const pattern = FOCUS_PATTERNS[topic] ?? topic.replace(/[^a-z0-9_-]/gu, "");
    const regex = pattern.length > 0 ? new RegExp(pattern, "iu") : undefined, paths = new Set<string>();
    for (const path of files) {
      if (regex === undefined || paths.size >= bounds.focusPaths) break;
      if (classifySensitivePath(path) !== undefined) continue;
      if (regex.test(path)) { paths.add(path); continue; }
      if ((sizeOf.get(path) ?? Infinity) > 256 * 1024) continue;
      const text = await readFile(join(root, ...path.split("/")), "utf8").catch(() => "");
      if (!text.includes("\0") && regex.test(text)) paths.add(path);
    }
    focus = { topic, pattern, paths: [...paths].sort() };
  }
  const largest = listing.entries.slice().sort((a, b) => b.bytes - a.bytes).slice(0, bounds.largest).map(entry => ({ path: entry.path, bytes: entry.bytes }));
  return Object.freeze({
    source: "folder" as const, name: basename(root), trackedFiles: all.length,
    languages: byCount(languages, 12).map(([language, n]) => ({ language, files: n })),
    directories: byCount(directories, 20).map(([path, n]) => ({ path, files: n })),
    packageManagers: [...packageManagers].sort(), manifests, frameworks: [...frameworks].sort(), entrypoints: [...entrypoints].slice(0, 16),
    tests: { files: testFiles, directories: byCount(testDirs, 8).map(([dir]) => dir), frameworks: [...frameworks].filter(name => TEST_FRAMEWORKS.has(name)) },
    ci: ci.slice(0, 20), containers: containers.slice(0, 20), config: config.slice(0, 30), docs: docs.slice(0, 20),
    git: { branch: null, head: null, commits: null, dirtyPaths: 0, recent: [] },
    largestFiles: largest, ...(focus ? { focus } : {}), truncated: listing.truncated || all.length > bounds.maxFiles,
    projects: detectProjects(files), sensitive: sensitiveFiles(files),
    skipped: { directories: listing.skippedDirectories.slice(0, 20), links: listing.skippedLinks } });
}

export function renderInventory(inventory: RepositoryInventory, detail: "summary" | "full"): string {
  const list = (items: readonly string[], empty = "none") => items.length > 0 ? items.join(", ") : empty;
  const lines = [inventory.source === "folder"
      ? `Folder: ${inventory.name} (${inventory.trackedFiles} files, not a Git repository${inventory.truncated ? "; some bounds were hit" : ""})`
      : `Repository: ${inventory.name} (${inventory.trackedFiles} tracked files${inventory.truncated ? "; some bounds were hit" : ""})`,
    ...inventory.projects.map(project => `Detected: ${project.kind} (${project.evidence.join(", ")})`),
    `Languages: ${list(inventory.languages.map(l => `${l.language} ${l.files}`))}`,
    `Package managers: ${list(inventory.packageManagers)}`, `Frameworks and tools: ${list(inventory.frameworks)}`,
    `Entrypoints: ${list(inventory.entrypoints)}`,
    `Tests: ${inventory.tests.files} test file(s)${inventory.tests.directories.length > 0 ? ` in ${inventory.tests.directories.join(", ")}` : ""}` +
      `${inventory.tests.frameworks.length > 0 ? `; ${inventory.tests.frameworks.join(", ")}` : ""}`,
    `CI: ${list(inventory.ci)}`, `Containers: ${list(inventory.containers)}`,
    ...(inventory.source === "git" ? [`Git: ${inventory.git.branch ?? "unknown branch"} at ${inventory.git.head ?? "no commit"}; ` +
      `${inventory.git.commits ?? "?"} commit(s); ${inventory.git.dirtyPaths} uncommitted path(s)`] : []),
    ...(inventory.sensitive.count > 0 ? [`Not shared in full with AI models: ${inventory.sensitive.count} sensitive file(s) — ` +
      `${inventory.sensitive.files.map(f => `${f.path} (${f.treatment === "keysOnly" ? "key names only" : "withheld"})`).join(", ")}`] : [])];
  if (detail === "full") {
    lines.push(`Top-level directories: ${list(inventory.directories.map(d => `${d.path} (${d.files})`))}`,
      `Configuration: ${list(inventory.config)}`, `Documentation: ${list(inventory.docs)}`);
    for (const manifest of inventory.manifests) {
      lines.push(`Manifest ${manifest.path}: ${manifest.kind}${manifest.name ? ` "${manifest.name}"` : ""}` +
        `${manifest.dependencies !== undefined ? `, ${manifest.dependencies} dependencies, ${manifest.devDependencies ?? 0} dev dependencies` : ""}`);
      for (const script of manifest.scripts ?? []) lines.push(`  script ${script.name}: ${script.command}`);
    }
    if (inventory.git.recent.length > 0) lines.push("Recent commits:", ...inventory.git.recent.map(c => `  ${c.hash} ${c.date} ${c.subject}`));
    if (inventory.largestFiles.length > 0) lines.push(`Largest tracked files: ${inventory.largestFiles.map(f => `${f.path} (${f.bytes} B)`).join(", ")}`);
  }
  if (inventory.focus) lines.push(`Focus "${inventory.focus.topic}" (${inventory.focus.pattern}): ` +
    `${inventory.focus.paths.length > 0 ? inventory.focus.paths.join(", ") : "no tracked path matched"}`);
  return lines.join("\n");
}
