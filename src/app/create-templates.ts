/**
 * v0.1 — the Fusion-owned, deterministic project templates behind `fusion create`. Narrow on purpose: Node.js 22.18+
 * with TypeScript run through Node's own type stripping, the stock test runner, and NO dependencies (nothing to install,
 * no network, no lockfile to trust). Fusion writes these files itself; the models then plan and implement the project
 * content through the normal verified build, and the human approves the result as a delivery.
 *
 * External services are represented as configuration STRUCTURE only: named environment variables with empty placeholders
 * in `.env.example` and a typed configuration reader — never a credential, never a guessed value, never a driver install.
 */
export const CREATE_FAMILIES = ["library", "cli", "api"] as const;
export type CreateFamily = (typeof CREATE_FAMILIES)[number];

export interface ServiceIntegration {
  readonly id: string;
  readonly label: string;
  /** Environment variables the integration needs; placeholders only. */
  readonly variables: readonly Readonly<{ name: string; note: string }>[];
}
/** Recognised external services (by keyword) and the configuration they need. */
export const SERVICES: readonly Readonly<{ pattern: RegExp; service: ServiceIntegration }>[] = [
  { pattern: /\b(postgres|postgresql|psql)\b/iu, service: { id: "postgres", label: "PostgreSQL", variables: [{ name: "DATABASE_URL", note: "postgres://user:password@host:5432/database — set your own" }] } },
  { pattern: /\b(mysql|mariadb)\b/iu, service: { id: "mysql", label: "MySQL", variables: [{ name: "DATABASE_URL", note: "mysql://user:password@host:3306/database — set your own" }] } },
  { pattern: /\bmongo(db)?\b/iu, service: { id: "mongodb", label: "MongoDB", variables: [{ name: "MONGODB_URL", note: "mongodb://host:27017/database — set your own" }] } },
  { pattern: /\bredis\b/iu, service: { id: "redis", label: "Redis", variables: [{ name: "REDIS_URL", note: "redis://host:6379 — set your own" }] } },
  { pattern: /\bstripe\b/iu, service: { id: "stripe", label: "Stripe", variables: [{ name: "STRIPE_SECRET_KEY", note: "from your Stripe dashboard; never commit it" }] } },
  { pattern: /\b(s3|object storage)\b/iu, service: { id: "s3", label: "S3-compatible storage", variables: [{ name: "S3_BUCKET", note: "bucket name" },
    { name: "S3_ACCESS_KEY_ID", note: "your access key id" }, { name: "S3_SECRET_ACCESS_KEY", note: "your secret; never commit it" }] } },
  { pattern: /\b(smtp|e-?mail|sendgrid|mailgun)\b/iu, service: { id: "email", label: "Email delivery", variables: [{ name: "SMTP_URL", note: "smtp://user:password@host:587 — set your own" }] } },
];
/** Stacks v0.1 does not create (refused honestly, with the supported alternative). */
export const UNSUPPORTED_STACKS: readonly Readonly<{ pattern: RegExp; label: string }>[] = [
  { pattern: /\bnext(\.js|js)\b/iu, label: "Next.js" }, { pattern: /\breact( native)?\b/iu, label: "React" }, { pattern: /\bvue\b/iu, label: "Vue" },
  { pattern: /\bangular\b/iu, label: "Angular" }, { pattern: /\bsvelte(kit)?\b/iu, label: "Svelte" }, { pattern: /\bdjango\b/iu, label: "Django" },
  { pattern: /\bflask\b/iu, label: "Flask" }, { pattern: /\bfastapi\b/iu, label: "FastAPI" }, { pattern: /\brails\b/iu, label: "Ruby on Rails" },
  { pattern: /\blaravel\b/iu, label: "Laravel" }, { pattern: /\bspring( boot)?\b/iu, label: "Spring" }, { pattern: /(\.net\b|\bdotnet\b|\bc#)/iu, label: ".NET" },
  { pattern: /\b(golang|go module)\b/iu, label: "Go" }, { pattern: /\brust\b/iu, label: "Rust" }, { pattern: /\bpython\b/iu, label: "Python" },
  { pattern: /\bjava\b/iu, label: "Java" }, { pattern: /\bkotlin\b/iu, label: "Kotlin" }, { pattern: /\bphp\b/iu, label: "PHP" },
  { pattern: /\bflutter\b/iu, label: "Flutter" }, { pattern: /\belectron\b/iu, label: "Electron" }, { pattern: /\bswift\b/iu, label: "Swift" },
];

/** The family a description asks for, when it says so (explicit `--template` always wins). */
export function inferFamily(description: string): CreateFamily | undefined {
  if (/\b(api|server|backend|rest|http|endpoint|service|saas|web ?app|webhook)\b/iu.test(description)) return "api";
  if (/\b(cli|command[- ]line|terminal|console tool|command)\b/iu.test(description)) return "cli";
  if (/\b(library|package|sdk|module|utility|helper)\b/iu.test(description)) return "library";
  return undefined;
}

const GITIGNORE = "node_modules/\n.env\n.env.*\n!.env.example\ncoverage/\n*.log\n";
const TSCONFIG = `${JSON.stringify({ compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true, noEmit: true,
  allowImportingTsExtensions: true, erasableSyntaxOnly: true, verbatimModuleSyntax: true, skipLibCheck: true }, include: ["src", "test"] }, null, 2)}\n`;

function packageJson(name: string, family: CreateFamily): string {
  return `${JSON.stringify({ name, version: "0.1.0", private: true, type: "module",
    ...(family === "cli" ? { bin: { [name]: "./src/main.ts" } } : {}), ...(family === "library" ? { exports: "./src/index.ts" } : {}),
    scripts: { test: "node --test \"test/**/*.test.ts\"", ...(family === "api" ? { start: "node src/server.ts" } : {}), ...(family === "cli" ? { start: "node src/main.ts" } : {}) },
    engines: { node: ">=22.18" } }, null, 2)}\n`;
}

/** The files of a fresh project: deterministic in the family, the package name, the description and the services. */
export function templateFiles(input: Readonly<{ family: CreateFamily; name: string; description: string; services: readonly ServiceIntegration[] }>): Record<string, string> {
  const { family, name, description, services } = input;
  const variables = services.flatMap(service => service.variables.map(variable => ({ ...variable, service: service.label })));
  const files: Record<string, string> = {
    ".gitignore": GITIGNORE, "package.json": packageJson(name, family), "tsconfig.json": TSCONFIG,
    "README.md": `# ${name}\n\n${description.trim()}\n\nCreated with \`fusion create\` (template \`${family}\`): Node.js 22.18+ runs the TypeScript sources directly ` +
      "(type stripping), and `npm test` runs the stock test runner. There are no dependencies yet.\n" +
      (variables.length > 0 ? `\n## Configuration\n\nCopy \`.env.example\` to \`.env\` and fill in:\n\n${variables.map(v => `- \`${v.name}\` (${v.service}): ${v.note}`).join("\n")}\n\n` +
        "Fusion never writes credentials. No client library is installed yet: add the one you choose (for example with npm) and commit its lockfile.\n" : ""),
  };
  if (variables.length > 0) {
    files[".env.example"] = `# Placeholders only — copy to .env and set your own values. Never commit .env.\n${variables.map(v => `# ${v.service}: ${v.note}\n${v.name}=`).join("\n")}\n`;
    files["src/config.ts"] = [
      "/** Configuration from the environment. Values are required at the point of use; nothing is defaulted. */",
      "export interface Config {",
      ...[...new Set(variables.map(v => v.name))].map(variable => `  readonly ${camel(variable)}: string | undefined;`),
      "}",
      "",
      "export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {",
      "  return {",
      ...[...new Set(variables.map(v => v.name))].map(variable => `    ${camel(variable)}: env.${variable} || undefined,`),
      "  };",
      "}",
      "",
      "/** The value, or an error naming the missing variable (never a guessed default). */",
      "export function required(value: string | undefined, variable: string): string {",
      "  if (value === undefined) throw new Error(`Missing configuration: set ${variable} (see .env.example).`);",
      "  return value;",
      "}",
      ""].join("\n");
    files["test/config.test.ts"] = [
      "import assert from \"node:assert/strict\";",
      "import { test } from \"node:test\";",
      "import { loadConfig, required } from \"../src/config.ts\";",
      "",
      "test(\"configuration comes from the environment and is never guessed\", () => {",
      `  const config = loadConfig({});`,
      ...[...new Set(variables.map(v => v.name))].map(variable => `  assert.equal(config.${camel(variable)}, undefined);`),
      `  assert.throws(() => required(undefined, "X"), /Missing configuration: set X/);`,
      "});",
      ""].join("\n");
  }
  if (family === "library") {
    files["src/index.ts"] = "/** The public API of this library. */\nexport function describe(): string {\n  return \"" + escapeString(name) + "\";\n}\n";
    files["test/index.test.ts"] = "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { describe } from \"../src/index.ts\";\n\n" +
      "test(\"the library describes itself\", () => {\n  assert.equal(describe(), \"" + escapeString(name) + "\");\n});\n";
  } else if (family === "cli") {
    files["src/cli.ts"] = [
      "import { parseArgs } from \"node:util\";",
      "",
      "/** Parses the command line; pure, so it can be tested without a process. */",
      "export function parse(argv: readonly string[]): { help: boolean; positionals: string[] } {",
      "  const { values, positionals } = parseArgs({ args: [...argv], options: { help: { type: \"boolean\", short: \"h\" } }, allowPositionals: true });",
      "  return { help: values.help === true, positionals };",
      "}",
      "",
      "export function run(argv: readonly string[], out: (text: string) => void): number {",
      "  const args = parse(argv);",
      `  if (args.help) { out(\"Usage: ${escapeString(name)} [options]\\n\"); return 0; }`,
      "  out(\"Not implemented yet.\\n\");",
      "  return 1;",
      "}",
      ""].join("\n");
    files["src/main.ts"] = "#!/usr/bin/env node\nimport { run } from \"./cli.ts\";\n\nprocess.exitCode = run(process.argv.slice(2), text => process.stdout.write(text));\n";
    files["test/cli.test.ts"] = "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { parse, run } from \"../src/cli.ts\";\n\n" +
      "test(\"--help prints the usage\", () => {\n  let out = \"\";\n  assert.equal(run([\"--help\"], text => { out += text; }), 0);\n  assert.match(out, /Usage:/);\n  assert.equal(parse([\"-h\"]).help, true);\n});\n";
  } else {
    files["src/app.ts"] = [
      "/** The HTTP routes as a pure function: method and path in, status and JSON body out. */",
      "export interface Reply { readonly status: number; readonly body: unknown }",
      "",
      "export function handle(method: string, path: string): Reply {",
      "  if (method === \"GET\" && path === \"/health\") return { status: 200, body: { status: \"ok\" } };",
      "  return { status: 404, body: { error: \"not found\" } };",
      "}",
      ""].join("\n");
    files["src/server.ts"] = [
      "import { createServer } from \"node:http\";",
      "import { handle } from \"./app.ts\";",
      "",
      "const port = Number(process.env.PORT ?? 3000);",
      "createServer((request, response) => {",
      "  const reply = handle(request.method ?? \"GET\", new URL(request.url ?? \"/\", \"http://localhost\").pathname);",
      "  response.writeHead(reply.status, { \"content-type\": \"application/json\" });",
      "  response.end(JSON.stringify(reply.body));",
      "}).listen(port, () => process.stdout.write(`Listening on http://localhost:${port}\\n`));",
      ""].join("\n");
    files["test/app.test.ts"] = "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { handle } from \"../src/app.ts\";\n\n" +
      "test(\"the health route answers\", () => {\n  assert.deepEqual(handle(\"GET\", \"/health\"), { status: 200, body: { status: \"ok\" } });\n  assert.equal(handle(\"GET\", \"/nope\").status, 404);\n});\n";
  }
  return files;
}

/** The confined verification of a created project: the stock Node test runner over every test file, in the container. */
export const TEMPLATE_VERIFICATION = Object.freeze({ platformRequirement: "linux-compatible" as const, dependencies: "none" as const,
  confinedCommands: Object.freeze([Object.freeze({ id: "unit", executable: "/usr/local/bin/node", args: Object.freeze(["--test", "test/**/*.test.ts"]),
    cwd: ".", timeoutMs: 180_000, mutationPolicy: "readOnly" as const })]) });

const camel = (variable: string): string => variable.toLowerCase().replace(/_([a-z0-9])/gu, (_m, c: string) => c.toUpperCase());
const escapeString = (text: string): string => text.replace(/\\/gu, "\\\\").replace(/"/gu, "\\\"");
