import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { FusionFailure } from "../src/core/errors.js";
import { assessRisk, escalateRisk, maxRisk, riskRank, type RiskLevel } from "../src/core/policy/risk.js";
import { classifyPath, inspectTask, unexpectedScopeSignals, verificationFailureSignal,
  type TaskRequest } from "../src/core/policy/task-inspector.js";

const base: TaskRequest = { operation: "edit", summary: "Fix the date formatting helper.", paths: ["src/util/format.ts"],
  scopeKnown: true, expectedMutation: "singleFile", requestedCapabilities: { write: true },
  verification: { required: true, planProvided: true } };
const inspect = (patch: Partial<TaskRequest>) => inspectTask({ ...base, ...patch });

test("O2 a trivial read-only task is low risk with an explicit reason", () => {
  const result = inspect({ operation: "analyze", summary: "Explain the parser.", paths: ["src/parser.ts"], expectedMutation: "none",
    requestedCapabilities: {}, verification: { required: false, planProvided: false } });
  assert.equal(result.writes, false);
  assert.equal(result.risk.level, "low");
  assert.deepEqual(result.risk.decisive, ["readOnlyTask"]);
  const readSecrets = inspect({ operation: "read", paths: [".env"], expectedMutation: "none", requestedCapabilities: {},
    verification: { required: false, planProvided: false } });
  assert.equal(readSecrets.risk.level, "high", "reading credential material exposes it even without writes");
  const readAuth = inspect({ operation: "review", paths: ["src/auth/login.ts"], expectedMutation: "none", requestedCapabilities: {},
    verification: { required: false, planProvided: false } });
  assert.equal(readAuth.risk.level, "medium");
});

test("O2 a narrow verified edit is low, a multi-file implementation is medium", () => {
  const narrow = inspect({});
  assert.deepEqual([narrow.scope, narrow.risk.level, narrow.risk.decisive], ["singleFile", "low", ["narrowWriteScope"]]);
  const multi = inspect({ operation: "implement", paths: ["src/a.ts", "src/b.ts", "test/a.test.ts"], expectedMutation: "multiFile" });
  assert.deepEqual([multi.scope, multi.risk.level, multi.risk.decisive], ["multiFile", "medium", ["multiFileWriteScope"]]);
  const unverified = inspect({ verification: { required: false, planProvided: false } });
  assert.equal(unverified.risk.level, "medium", "a writer without a deterministic verifier is never low");
});

test("O2 dependency, auth, credential, CI and migration paths escalate with evidence", () => {
  const cases: Array<[string, RiskLevel, string]> = [
    ["package.json", "high", "dependencyChange"], ["pnpm-lock.yaml", "high", "dependencyChange"],
    ["src/auth/session.ts", "high", "securitySensitivePath"], ["src/billing/invoice.ts", "high", "securitySensitivePath"],
    ["src/authentication.ts", "high", "securitySensitivePath"], [".github/workflows/ci.yml", "high", "ciOrReleasePath"],
    ["db/migrations/0003_users.sql", "high", "schemaChange"], [".env.production", "critical", "credentialMaterialPath"],
    ["certs/server.pem", "critical", "credentialMaterialPath"], [".git/config", "critical", "gitInternalsPath"],
  ];
  for (const [path, level, code] of cases) {
    const result = inspect({ paths: [path] });
    assert.equal(result.risk.level, level, path);
    assert.ok(result.risk.decisive.includes(code), `${path}: ${result.risk.decisive.join(",")}`);
    assert.ok(result.risk.signals.find(s => s.code === code)?.evidence.length, "every signal explains itself");
  }
  assert.deepEqual(classifyPath("src/components/Button.tsx"), []);
  assert.deepEqual(classifyPath("docs/tokenizer-notes.md"), [], "substring matches do not count; segments do");
});

test("O2 destructive requests, external effects and unknown scope escalate", () => {
  for (const summary of ["Force-push the fixed branch to main", "run git reset --hard origin/main then continue",
    "DROP TABLE sessions and recreate it", "rewrite history to remove the file", "rm -rf build then publish to the npm registry"]) {
    assert.equal(inspect({ summary }).risk.level, "critical", summary);
  }
  assert.equal(inspect({ indicators: { irreversible: true } }).risk.level, "critical");
  assert.equal(inspect({ requestedCapabilities: { write: true, externalSideEffects: true } }).risk.level, "critical");
  assert.equal(inspect({ operation: "release" }).risk.level, "critical");
  const unknown = inspect({ scopeKnown: false, expectedMutation: "unknown", paths: [] });
  assert.deepEqual([unknown.scope, unknown.risk.level], ["unknown", "high"]);
  const noPaths = inspect({ paths: [] });
  assert.equal(noPaths.risk.level, "high", "a writer that declares no paths has an unbounded scope");
  const broad = inspect({ expectedMutation: "multiFile", paths: Array.from({ length: 25 }, (_, i) => `src/m${i}.ts`) });
  assert.deepEqual([broad.scope, broad.risk.level], ["broad", "high"]);
  const escape = inspect({ paths: ["../outside/file.ts"] });
  assert.equal(escape.risk.level, "critical");
  assert.ok(escape.risk.decisive.includes("outOfRepositoryScope"));
});

test("O2 ambiguity and capability-enforcement doubts are high", () => {
  assert.equal(inspect({ indicators: { ambiguousArchitecture: true } }).risk.level, "high");
  assert.equal(inspect({ indicators: { architectureChange: true } }).risk.level, "high");
  assert.equal(inspect({ indicators: { ambiguousCapabilityEnforcement: true } }).risk.level, "high");
  assert.equal(inspect({ requestedCapabilities: { write: true, network: true } }).risk.level, "high");
});

test("O2 risk is monotonic: escalation never lowers a level", () => {
  const high = inspect({ paths: ["package.json"] }).risk;
  const afterLow = escalateRisk(high, [{ code: "reassurance", level: "low", source: "policy", evidence: "looks fine" }]);
  assert.equal(afterLow.level, "high");
  assert.equal(afterLow.revision, 1);
  assert.ok(afterLow.signals.some(s => s.code === "dependencyChange"), "earlier facts are never dropped");
  const low = inspect({}).risk;
  const raised = escalateRisk(low, [verificationFailureSignal("unit")]);
  assert.deepEqual([raised.level, raised.decisive], ["high", ["verificationFailed"]]);
  const critical = escalateRisk(raised, unexpectedScopeSignals(["src/util/format.ts"], ["src/util/format.ts", "src/auth/login.ts"]));
  assert.equal(critical.level, "critical");
  let chain = assessRisk([]);
  for (const level of ["medium", "low", "critical", "high", "low"] as RiskLevel[]) {
    const next = escalateRisk(chain, [{ code: `step-${level}`, level, source: "policy", evidence: level }]);
    assert.ok(riskRank(next.level) >= riskRank(chain.level));
    chain = next;
  }
  assert.equal(chain.level, "critical");
  assert.equal(maxRisk("medium", "low"), "medium");
});

test("O2 unexpected scope raises risk; changes inside scope do not", () => {
  assert.deepEqual(unexpectedScopeSignals(["src/a.ts"], ["src/a.ts", "SRC\\A.ts"]), []);
  const [outside] = unexpectedScopeSignals(["src/a.ts"], ["src/a.ts", "src/b.ts"]);
  assert.deepEqual([outside?.code, outside?.level], ["unexpectedScope", "high"]);
  assert.equal(unexpectedScopeSignals([], [".env"])[0]?.level, "critical");
});

test("O2 identical input yields identical output regardless of path order or repetition", () => {
  const a = inspect({ operation: "implement", expectedMutation: "multiFile", paths: ["src/b.ts", "src\\a.ts", "./src/b.ts", "package.json"] });
  const b = inspect({ operation: "implement", expectedMutation: "multiFile", paths: ["package.json", "src/a.ts", "src/b.ts"] });
  assert.deepEqual(a, b);
  assert.deepEqual(inspect({}), inspect({}));
  assert.ok(Object.isFrozen(a.risk) && Object.isFrozen(a.risk.signals));
});

test("O2 malformed task requests fail closed as typed input errors", () => {
  const bad: unknown[] = [null, { ...base, operation: "hack" }, { ...base, paths: "src/a.ts" }, { ...base, paths: [""] },
    { ...base, paths: ["a\u0000b"] }, { ...base, scopeKnown: "yes" }, { ...base, expectedMutation: "some" },
    { ...base, verification: {} }, { ...base, summary: 5 }];
  for (const request of bad)
    assert.throws(() => inspectTask(request as TaskRequest), (e: unknown) => e instanceof FusionFailure && e.error.kind === "InvalidInput");
});

test("O2 core policy is provider- and model-neutral", async () => {
  const dir = join(process.cwd(), "src", "core", "policy");
  const forbidden = /claude|muse|anthropic|\bmeta\b|opus|spark|\bgpt|gemini|openai|llama/iu;
  for (const name of ["risk.ts", "task-inspector.ts"]) {
    const source = await readFile(join(dir, name), "utf8");
    assert.doesNotMatch(source, forbidden, name);
  }
  assert.ok((await readdir(dir)).includes("risk.ts"));
});
