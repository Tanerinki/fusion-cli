import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { test } from "node:test";
import type { VerificationCommand } from "../src/core/domain.js";
import { FusionFailure } from "../src/core/errors.js";
import type { RiskLevel } from "../src/core/policy/risk.js";
import { RISK_TEXT_LIMITS, scanRiskText } from "../src/core/policy/risk-text.js";
import { classifyPath, inspectTask, unexpectedScopeSignals, verificationPlanReferences, verificationReferenceSignals,
  type TaskRequest } from "../src/core/policy/task-inspector.js";
import { VerificationEngine } from "../src/platform/verification/engine.js";
import { ProcessGitClient } from "../src/platform/workspace/git.js";
import { fusionTemporaryBase } from "../src/platform/fs/temporary.js";

const base: TaskRequest = { operation: "edit", summary: "Tidy the helper.", paths: ["src/a.ts"], scopeKnown: true,
  expectedMutation: "singleFile", requestedCapabilities: { write: true }, verification: { required: true, planProvided: true } };
const inspect = (patch: Partial<TaskRequest>) => inspectTask({ ...base, ...patch });
const invalidInput = (e: unknown): boolean => e instanceof FusionFailure && e.error.kind === "InvalidInput";

test("O3.1 repository-control files are high and verification-control files at least medium", () => {
  const cases: Array<[string, string, RiskLevel]> = [
    [".gitignore", "repositoryControl", "high"], ["src/nested/.gitignore", "repositoryControl", "high"],
    [".gitattributes", "repositoryControl", "high"], [".gitmodules", "repositoryControl", "high"],
    [".husky/pre-commit", "repositoryControl", "high"], [".githooks/pre-push", "repositoryControl", "high"],
    ["lefthook.yml", "repositoryControl", "high"], [".pre-commit-config.yaml", "repositoryControl", "high"],
    ["jest.config.js", "verificationControl", "medium"], ["jest.config.ts", "verificationControl", "medium"],
    ["vitest.config.mts", "verificationControl", "medium"], ["vitest.workspace.ts", "verificationControl", "medium"],
    ["playwright.config.ts", "verificationControl", "medium"], [".mocharc.json", "verificationControl", "medium"],
    [".mocharc.yml", "verificationControl", "medium"], ["tsconfig.json", "verificationControl", "medium"],
    ["packages/web/tsconfig.build.json", "verificationControl", "medium"], ["Makefile", "verificationControl", "medium"],
    ["conftest.py", "verificationControl", "medium"],
  ];
  for (const [path, cls, level] of cases) {
    assert.ok(classifyPath(path).includes(cls as never), `${path}: ${JSON.stringify(classifyPath(path))}`);
    const result = inspect({ paths: [path] });
    assert.equal(result.risk.level, level, path);
    assert.ok(result.risk.signals.some(s => s.code === `${cls}Path`), path);
  }
  // package.json scripts control verification too; the manifest class already makes that high.
  assert.equal(inspect({ paths: ["package.json"] }).risk.level, "high");
  for (const path of ["src/config.ts", "docs/jest-notes.md", "docs/tsconfig-guide.md", "src/gitignore-parser.ts", "husky.md"])
    assert.deepEqual(classifyPath(path), [], path);
  // Reading control files is harmless; changing one outside the delegated scope is critical.
  assert.equal(inspect({ operation: "analyze", paths: [".gitignore"], expectedMutation: "none", requestedCapabilities: {},
    verification: { required: false, planProvided: false } }).risk.level, "low");
  assert.equal(unexpectedScopeSignals(["src/a.ts"], ["src/a.ts", "jest.config.js"])[0]?.level, "critical");
});

test("O3.1 destructive Git intent is recognised in its equivalent forms, token-aware", () => {
  const critical = ["push origin main --force", "git push origin main --force", "push origin +main", "git push origin +main",
    "git push --force-with-lease", "git -C repo push -fu origin main", "git push origin --delete release",
    "git push origin :release", "branch -D feature", "git branch --delete --force old", "checkout -- .",
    "git checkout .", "Then run git checkout . to start over.", "git restore src/a.ts",
    "git checkout -- src/a.ts", "git checkout -f main", "git restore .", "stash drop", "git stash clear",
    "git reset --hard HEAD~3", "git clean -fdx", "git clean -xdf", "delete the release branch on origin",
    "delete the remote branch release", "discard all local changes", "git rebase -i HEAD~5", "git filter-repo --path x",
    "git reflog expire --all", "git gc --prune=now", "git push origin main", "run `git push` afterwards"];
  for (const summary of critical) assert.equal(inspect({ summary }).risk.level, "critical", summary);
  const high = ["git branch -d merged-feature", "git rebase main", "git tag -d v1", "git worktree remove old"];
  for (const summary of high) assert.equal(inspect({ summary }).risk.level, "high", summary);
  // Ordinary prose that shares words with Git commands is not escalated.
  const benign = ["Push the button styles into the shared theme.", "Clean up the parser code.", "Improve branch coverage.",
    "Reset the counter when the form closes.", "Tag the release notes section.", "git restore --staged src/a.ts",
    "git checkout main", "git branch --list", "git stash", "git stash pop"];
  for (const summary of benign) assert.equal(inspect({ summary }).risk.level, "low", summary);
  // Deterministic and order-independent.
  assert.deepEqual(scanRiskText(["git push -f", "branch -D x"], "delegation"), scanRiskText(["git push -f", "branch -D x"], "delegation"));
  assert.deepEqual(scanRiskText(["git branch -D x; git push -f"], "task").codes, ["branchForceDelete", "forcePush", "remotePush"]);
});

test("O3.1 malformed risk flags and fields fail closed as InvalidInput", () => {
  const bad: unknown[] = [
    { ...base, requestedCapabilities: { write: true, network: "true" } },
    { ...base, requestedCapabilities: { write: true, externalSideEffects: 1 } },
    { ...base, requestedCapabilities: { write: true, shell: "yes" } },
    { ...base, requestedCapabilities: { write: "false" } },
    { ...base, requestedCapabilities: { write: true, netwrok: true } },
    { ...base, requestedCapabilities: [] },
    { ...base, indicators: { irreversible: "true" } },
    { ...base, indicators: { irreversable: true } },
    { ...base, indicators: null },
    { ...base, verification: { required: true, planProvided: 1 } },
    { ...base, verification: { required: true, planProvided: true, skip: true } },
    { ...base, scopeKnown: "true" },
    { ...base, extra: true },
  ];
  for (const request of bad) assert.throws(() => inspectTask(request as TaskRequest), invalidInput, JSON.stringify(request));
  assert.equal(inspect({ requestedCapabilities: { write: true, network: undefined } as never }).risk.level, "low", "undefined means absent");
});

test("O3.1 oversized risk text is refused, never scanned as a prefix", () => {
  const limit = RISK_TEXT_LIMITS.maxChars;
  assert.throws(() => inspect({ summary: `${"a".repeat(limit - 10)} and then git push -f` }), invalidInput);
  assert.throws(() => inspect({ summary: "a".repeat(limit + 1) }), invalidInput);
  assert.equal(inspect({ summary: "a".repeat(limit) }).risk.level, "low", "text at the limit is accepted");
  const tail = " then git push -f";
  assert.equal(inspect({ summary: `${"a".repeat(limit - tail.length)}${tail}` }).risk.level, "critical",
    "intent in the last characters of an in-limit summary is scanned");
  assert.throws(() => scanRiskText(Array.from({ length: RISK_TEXT_LIMITS.maxItems + 1 }, () => "x"), "delegation"), invalidInput);
  const many = Array.from({ length: Math.ceil(RISK_TEXT_LIMITS.maxTotalChars / limit) + 1 }, () => "b".repeat(limit));
  assert.throws(() => scanRiskText(many, "delegation"), invalidInput);
  assert.throws(() => scanRiskText(["ok", 7 as never], "delegation"), invalidInput);
});

test("O3.1 verification-plan references mark the files a writer could use to steer its own verification", () => {
  const command = (args: string[], cwd = "."): Pick<VerificationCommand, "args" | "cwd"> => ({ args, cwd });
  const references = verificationPlanReferences([
    command(["--require", "./test/helpers/setup.js", "--config=jest.config.js", "test/unit"]),
    command(["dist/test/*.test.js", "-e", "process.exit(0)"], "."),
    command(["spec/run.js"], "packages/web"),
    command(["../outside.js", "https://example.invalid/x", "C:/abs/file.js", "*.js"]),
  ]);
  assert.deepEqual(references, ["dist/test", "jest.config.js", "packages/web/spec/run.js", "process.exit(0)",
    "test/helpers/setup.js", "test/unit"]);
  assert.equal(verificationReferenceSignals(["test/helpers/setup.js"], references)[0]?.level, "medium");
  assert.equal(verificationReferenceSignals(["test/unit/a.test.ts"], references)[0]?.code, "verificationReferencedPath");
  assert.deepEqual(verificationReferenceSignals(["src/a.ts", "test/unitary.ts"], references), []);
});

const gitAvailable = spawnSync("git", ["--version"], { windowsHide: true }).status === 0;
test("O3.1 a verification step whose cwd was swapped for a link by an earlier step never runs",
  { skip: gitAvailable ? false : "git executable unavailable" }, async () => {
  const dir = await mkdtemp(join(fusionTemporaryBase(), "fusion-o31-cwd-"));
  try {
    const root = join(dir, "repo"), outside = join(dir, "outside");
    await mkdir(join(root, "pkg"), { recursive: true }); await mkdir(outside);
    await writeFile(join(root, "pkg", "b.txt"), "b\n");
    const git = (...args: string[]) => spawnSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.invalid",
      "-c", "commit.gpgsign=false", "-c", `core.hooksPath=${join(root, ".no-hooks")}`, ...args], { cwd: root, windowsHide: true });
    git("init", "-q"); git("config", "core.autocrlf", "false"); git("add", "."); git("commit", "-qm", "init");
    const node = process.execPath;
    const steps: VerificationCommand[] = [
      { id: "swap", executable: node, cwd: ".", timeoutMs: 20_000, mutationPolicy: "allowMutation", args: ["-e",
        "const fs=require('fs');fs.rmSync('pkg',{recursive:true,force:true});fs.symlinkSync(process.argv[1],'pkg','junction')", outside] },
      { id: "inside", executable: node, cwd: "pkg", timeoutMs: 20_000, mutationPolicy: "readOnly",
        args: ["-e", "require('fs').writeFileSync('marker.txt','ran')"] },
    ];
    const report = await new VerificationEngine().run({ commands: steps },
      { workspaceRoot: root, git: await ProcessGitClient.fromPath(), env: { ...process.env } });
    assert.equal(report.steps[0]?.status, "passed", "the first step itself was allowed to mutate");
    assert.deepEqual([report.passed, report.status, report.steps[1]?.status, report.failure?.kind],
      [false, "failed", "mutationViolation", "SecurityViolation"]);
    assert.match(report.failure?.safeMessage ?? "", /cwd is no longer a real directory/u);
    assert.equal(existsSync(join(outside, "marker.txt")), false, "the step never ran through the link");
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${fusionTemporaryBase().toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
