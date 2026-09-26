import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_PROPOSED_PATHS, parseProposedScope, SCOPE_INSTRUCTION } from "../src/app/build-scope.js";
import { CONFIG_FILE, parseConfig } from "../src/app/config.js";
import { createTask, nameFrom, planCreate, scaffoldProject } from "../src/app/create.js";
import { CREATE_FAMILIES, templateFiles, TEMPLATE_VERIFICATION } from "../src/app/create-templates.js";
import { ROUTE_ROLES } from "../src/app/route-probe.js";
import { FusionFailure } from "../src/core/errors.js";
import { withInstalls } from "./fixtures/provider-installs.js";
import { cleanReview, plan, PREFIX, proposal } from "./fixtures/route-harness.js";
import { DESCRIPTION, GREET, NAME, SCOPE, TEMPLATE, withCreate, type Created } from "./fixtures/v01-rig.js";
import { git, gitAvailable } from "./fixtures/writer-rehearsal-harness.js";

/**
 * v0.1 Block 3 — `fusion create`, offline: the plan (families, names, services, honest refusal of unsupported stacks), the
 * Lead's scope proposal as untrusted data, the deterministic templates (each one's own tests really pass under Node), the
 * scaffold's refusals, and the whole command through the REAL CLI: plan → typed "create" → template + Git baseline → the
 * Lead's read-only scope turn → typed "build" → the real route (plan, Change Author, confined verification on a fake
 * daemon, fresh review) → an offline rehearsal that is never delivered.
 */
const skip = gitAvailable ? false : "git executable unavailable";
const kind = (expected: string) => (error: unknown) => error instanceof FusionFailure && error.error.kind === expected;

// ---------------------------------------------------------------- plan

test("v0.1 create plan: the family from --template or the description, a safe name, named services as placeholders; unsupported stacks refused", () => {
  const cwd = join("work", "projects");
  const library = planCreate(cwd, { description: DESCRIPTION });
  assert.deepEqual([library.family, library.familySource, library.name], ["library", "inferred", "library-greets-people-name"]);
  assert.equal(planCreate(cwd, { description: "a REST API for orders backed by Postgres and Redis" }).family, "api");
  assert.equal(planCreate(cwd, { description: "a command-line tool that renames photos" }).family, "cli");
  const fallback = planCreate(cwd, { description: "something that counts words" });
  assert.deepEqual([fallback.family, fallback.familySource], ["library", "default"]);
  const explicit = planCreate(cwd, { description: "a REST API for orders", template: "cli", name: "orders-tool" });
  assert.deepEqual([explicit.family, explicit.familySource, explicit.name], ["cli", "template", "orders-tool"]);
  assert.ok(explicit.directory.endsWith(join("projects", "orders-tool")));
  const services = planCreate(cwd, { description: "an API with PostgreSQL, a MariaDB mirror, Stripe payments and e-mail receipts" }).services;
  assert.deepEqual(services.map(s => s.id), ["postgres", "mysql", "stripe", "email"]);
  assert.throws(() => planCreate(cwd, { description: "a Next.js shop with React" }), (error: unknown) =>
    kind("InvalidInput")(error) && /does not create Next\.js, React projects/u.test((error as FusionFailure).error.safeMessage));
  assert.throws(() => planCreate(cwd, { description: "a Django site in Python" }), kind("InvalidInput"));
  assert.throws(() => planCreate(cwd, { description: DESCRIPTION, template: "desktop" }), kind("InvalidInput"));
  for (const name of ["Upper", "../escape", "-dash", "a".repeat(51), "a b"]) assert.throws(() => planCreate(cwd, { description: DESCRIPTION, name }), kind("InvalidInput"));
  assert.throws(() => planCreate(cwd, { description: "   " }), kind("InvalidInput"));
  assert.equal(nameFrom("!!!"), "fusion-project");
  assert.equal(nameFrom("Build a JavaScript-free Übersicht of the weather"), "javascript-free-ubersicht-weather");
  const task = createTask(planCreate(cwd, { description: "an API storing orders in Postgres" }));
  assert.match(task, /^Implement this new api project: an API storing orders in Postgres\./u);
  assert.match(task, /never write credentials/u);
});

// ---------------------------------------------------------------- scope proposal

test("v0.1 build scope: the Lead's reply is untrusted data — one JSON array of canonical file paths, strictly checked", () => {
  assert.deepEqual(parseProposedScope('["src/a.ts", "test/a.test.ts"]'), ["src/a.ts", "test/a.test.ts"]);
  assert.deepEqual(parseProposedScope('Here you go:\n```json\n["src/a.ts", "src/a.ts", "README.md"]\n```\n'), ["src/a.ts", "README.md"]);
  assert.deepEqual(parseProposedScope('Files: ["docs/x.md"] and nothing else.'), ["docs/x.md"]);
  for (const bad of ["no list", "[]", '{"paths": ["a.ts"]}', "[1, 2]"]) assert.throws(() => parseProposedScope(bad), (error: unknown) => error instanceof FusionFailure);
  for (const path of ["../outside.ts", "/etc/passwd", "C:/Windows/x", ".git/config", "src/../../x", ".fusion/runs/x", "src\\a.ts"])
    assert.throws(() => parseProposedScope(JSON.stringify([path])), kind("SecurityViolation"), path);
  for (const path of ["package-lock.json", "web/yarn.lock", ".env", "config/.env.production"])
    assert.throws(() => parseProposedScope(JSON.stringify(["src/a.ts", path])), kind("SecurityViolation"), path);
  assert.throws(() => parseProposedScope(JSON.stringify(Array.from({ length: MAX_PROPOSED_PATHS + 1 }, (_, i) => `src/f${i}.ts`))), kind("InvalidInput"));
  assert.match(SCOPE_INSTRUCTION, /ONLY a JSON array/u);
});

// ---------------------------------------------------------------- templates and scaffold

test("v0.1 create templates: no dependencies, no credentials, Node's type stripping; every family's own tests pass under Node", { skip }, async () =>
  withInstalls(async i => {
    for (const family of CREATE_FAMILIES) {
      const description = family === "api" ? "a REST API for orders with Postgres and Stripe" : family === "cli" ? "a command-line tool that greets" : DESCRIPTION;
      const created = planCreate(join(i.dir, `work-${family}`), { description, template: family, name: `demo-${family}` });
      await mkdir(join(i.dir, `work-${family}`));
      const project = await scaffoldProject(created, process.env, [...parseConfig({ schemaVersion: 1 }).bindings]);
      assert.equal(git(project.root, "rev-parse", "HEAD").trim(), project.baseCommit);
      assert.equal(git(project.root, "status", "--porcelain").trim(), "", "the baseline commits every template file");
      const files = templateFiles({ family, name: `demo-${family}`, description, services: created.services });
      for (const [path, content] of Object.entries(files)) assert.equal(await readFile(join(project.root, ...path.split("/")), "utf8"), content, path);
      const pkg = JSON.parse(files["package.json"]!) as Record<string, unknown>;
      assert.equal(pkg.dependencies, undefined);
      assert.equal(pkg.devDependencies, undefined);
      const all = Object.values(files).join("\n");
      assert.ok(!all.includes("import.meta"), "the sources stay provider-guard clean");
      assert.ok(!/sk_(live|test)_|AKIA[0-9A-Z]{8}|password=/u.test(all), "no credential or example secret");
      const config = parseConfig(JSON.parse(await readFile(join(project.root, CONFIG_FILE), "utf8")));
      assert.deepEqual(config.verification.confinedCommands?.map(command => [command.id, command.executable, [...command.args]]),
        TEMPLATE_VERIFICATION.confinedCommands.map(command => [command.id, command.executable, [...command.args]]));
      assert.equal(config.verification.platformRequirement, "linux-compatible");
      if (family === "api") assert.match(files["src/config.ts"]!, /DATABASE_URL[\s\S]*STRIPE_SECRET_KEY/u);
      // The template's own command, as a fresh top-level runner (not a child of this test run).
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", "test/**/*.test.ts"], { cwd: project.root, env, encoding: "utf8",
        windowsHide: true, timeout: 60_000 });
      assert.equal(run.status, 0, `${family}: ${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout, /^# pass [1-9]\d*$/mu, family);
      assert.match(run.stdout, /^# fail 0$/mu, family);
    }
  }));

test("v0.1 create scaffold: never inside an existing Git repository, never into a non-empty directory", { skip }, async () =>
  withInstalls(async i => {
    const repo = join(i.dir, "repo");
    await mkdir(repo);
    git(repo, "init", "-q");
    const inside = planCreate(repo, { description: DESCRIPTION, name: "inner" });
    await assert.rejects(scaffoldProject(inside, process.env, []), (error: unknown) =>
      kind("InvalidInput")(error) && /inside an existing Git repository/u.test((error as FusionFailure).error.safeMessage));
    assert.equal(existsSync(join(repo, "inner")), false, "nothing was created");
    const parent = join(i.dir, "parent");
    await mkdir(join(parent, "taken"), { recursive: true });
    await writeFile(join(parent, "taken", "keep.txt"), "mine\n");
    await assert.rejects(scaffoldProject(planCreate(parent, { description: DESCRIPTION, name: "taken" }), process.env, []), kind("InvalidInput"));
    assert.deepEqual(await readdir(join(parent, "taken")), ["keep.txt"]);
    await mkdir(join(parent, "empty"));
    const project = await scaffoldProject(planCreate(parent, { description: DESCRIPTION, name: "empty" }), process.env, []);
    assert.equal(git(project.root, "rev-list", "--count", "HEAD").trim(), "1", "an existing empty directory is used");
  }));

// ---------------------------------------------------------------- the command, end to end

const CREATE = ["create", "--template", "library", "--name", NAME, "--", DESCRIPTION];
const last = (created: Created, prefix: string) => created.stdout.split("\n").filter(entry => entry.startsWith(prefix)).at(-1);

test("v0.1 create: confirmed twice by the human — the template and a Git baseline, the Lead's scope, the real route; an offline rehearsal is never delivered",
  { skip }, async () => withCreate("pass", { Lead: [{ prefix: SCOPE_INSTRUCTION.slice(0, 60), output: SCOPE }, { prefix: PREFIX.plan, output: plan() }],
    Worker: [proposal(GREET)], Reviewer: [{ prefix: PREFIX.review, output: cleanReview }] }, async rig => {
    const created = await rig.cli(CREATE, ["create", "build"]);
    assert.equal(created.code, 0, `${created.stdout}\n${created.stderr}`);
    assert.equal(created.questions.length, 2);
    assert.match(created.questions[0]!, /^Type "create" to create .*greeter/u);
    assert.match(created.questions[1]!, /^Type "build" to start/u);
    assert.match(created.stdout, /^Create plan$/mu);
    assert.match(created.stdout, /^Project: greeter \(template library, template\)$/mu);
    assert.match(created.stdout, /^Services: none$/mu);
    assert.match(created.stdout, /^Scope \(proposed by lead \([^)]+\); confirm or rerun with --path\): src\/index\.ts, test\/index\.test\.ts$/mu);
    assert.equal(last(created, "Build: "), "Build: PASS (offline rehearsal — never delivered)");
    assert.equal(last(created, "Verification: "), "Verification: PASS (docker-linux, 1 command(s))");
    assert.equal(last(created, "Review: "), "Review: PASS (1 cycle(s), 0 finding(s), 0 outstanding)");
    assert.deepEqual([created.turns.Lead.length, created.turns.Worker.length, created.turns.Reviewer.length], [2, 1, 1]);
    assert.ok(created.turns.Lead[0]!.includes("Implement this new library project: a small library that greets people by name."));
    const root = join(rig.cwd, NAME);
    assert.equal(git(root, "rev-list", "--count", "HEAD").trim(), "1");
    assert.equal(git(root, "status", "--porcelain", "--untracked-files=all").trim(), "", "the build never touches the new working tree");
    assert.equal(await readFile(join(root, "src", "index.ts"), "utf8"), TEMPLATE["src/index.ts"]);
  }));

test("v0.1 create: unattended, declined, unsupported or inside a repository — nothing is created and no model runs; a declined build keeps the project",
  { skip }, async () => withCreate("gates", { Lead: [{ prefix: SCOPE_INSTRUCTION.slice(0, 60), output: SCOPE }] }, async rig => {
    const root = join(rig.cwd, NAME);
    const unattended = await rig.cli(CREATE, []);
    assert.equal(unattended.code, 14, unattended.stdout);
    assert.match(unattended.stderr, /needs a human at an interactive terminal/u);
    const json = await rig.cli(["--json", ...CREATE], ["create"]);
    assert.equal(json.code, 2, "create is interactive only: --json is a usage error");
    assert.equal(json.questions.length, 0, "--json never asks");
    const declined = await rig.cli(CREATE, ["yes"]);
    assert.equal(declined.code, 11);
    assert.match(declined.stdout, /Nothing was created: it was not confirmed/u);
    assert.equal(existsSync(root), false);
    const unsupported = await rig.cli(["create", "a Flask backend in Python"], ["create"]);
    assert.equal(unsupported.code, 2, unsupported.stderr);
    assert.match(unsupported.stderr, /does not create Flask, Python projects/u);
    assert.equal(unsupported.questions.length, 0);
    const repo = join(rig.cwd, "existing-repo");
    await mkdir(repo);
    git(repo, "init", "-q");
    const inside = await rig.cli(CREATE, ["create"], repo);
    assert.equal(inside.code, 2);
    assert.match(inside.stderr, /inside an existing Git repository/u);
    assert.equal(inside.questions.length, 0, "refused before the human is asked");
    assert.equal(existsSync(join(repo, NAME)), false);
    const unusedTurns = [unattended, json, declined, unsupported, inside].reduce((sum, run) => sum + ROUTE_ROLES.reduce((n, role) => n + run.turns[role].length, 0), 0);
    assert.equal(unusedTurns, 0);
    const noBuild = await rig.cli(CREATE, ["create", "not now"]);
    assert.equal(noBuild.code, 0, noBuild.stdout + noBuild.stderr);
    assert.match(noBuild.stdout, /The project is created; no build ran/u);
    assert.deepEqual([noBuild.turns.Lead.length, noBuild.turns.Worker.length, noBuild.turns.Reviewer.length], [1, 0, 0], "only the read-only scope turn");
    assert.equal(git(root, "status", "--porcelain", "--untracked-files=all").trim(), "");
  }));
