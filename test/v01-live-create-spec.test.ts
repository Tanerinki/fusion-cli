import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createTask, planCreate } from "../src/app/create.js";
import { RISK_TEXT_LIMITS, scanRiskText } from "../src/core/policy/risk-text.js";

/**
 * v0.1 — the live `create` acceptance's task is fully specified (so the Lead has no decision left to request), accepted by
 * `fusion create` as a supported library, free of risk signals, and self-consistent: its examples follow its own contract.
 * The live script's authorization, attempt limits and turn budgets are pinned unchanged. Nothing here runs a provider.
 */
const REPO = fileURLToPath(new URL("../../", import.meta.url));
interface Spec { LIVE_CREATE_NAME: string; LIVE_CREATE_DESCRIPTION: string; LIVE_CREATE_EXAMPLES: ReadonlyArray<readonly [number, string]> }
const load = async (): Promise<Spec> => await import(pathToFileURL(join(REPO, "scripts", "v01-live-create-spec.mjs")).href) as Spec;

/** The contract as written, to prove the examples agree with it. */
function reference(seconds: number): string {
  if (!Number.isFinite(seconds) || !Number.isInteger(seconds) || seconds < 0) throw new RangeError("seconds");
  if (seconds === 0) return "0s";
  const units: Array<[number, string]> = [[Math.floor(seconds / 3600), "h"], [Math.floor((seconds % 3600) / 60), "m"], [seconds % 60, "s"]];
  return units.filter(([value]) => value > 0).map(([value, unit]) => `${value}${unit}`).join(" ");
}

test("v0.1 live create spec: every required behavior is stated, the examples follow the contract, and fusion create accepts it", async () => {
  const spec = await load();
  const text = spec.LIVE_CREATE_DESCRIPTION;
  assert.equal(spec.LIVE_CREATE_NAME, "live-durations");
  assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/u, "one line, no control characters");
  for (const phrase of ["formatDuration(seconds: number): string", "finite, non-negative integer", "negative, fractional, NaN, Infinity and -Infinity",
    "RangeError", "the units h, m and s only", "hours may exceed 24", "days are never introduced", "Omit zero-valued units",
    "zero seconds returns exactly \"0s\"", "exactly one ASCII space", "Node.js 22.18+", "type stripping", "node:test", "tests under test/",
    "each example and each invalid input", "add no dependencies"])
    assert.ok(text.includes(phrase), phrase);
  assert.deepEqual(spec.LIVE_CREATE_EXAMPLES.map(([seconds]) => seconds), [0, 5, 60, 65, 3600, 3900, 3930, 7205, 90061]);
  for (const [seconds, expected] of spec.LIVE_CREATE_EXAMPLES) {
    assert.ok(text.includes(`${seconds} -> "${expected}"`), `${seconds} is listed`);
    assert.equal(reference(seconds), expected, `${seconds} follows the contract`);
  }
  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) assert.throws(() => reference(invalid), RangeError);
  // fusion create takes it as a supported library project with no external service, and its build task stays risk-free.
  const plan = planCreate(join(tmpdir(), "fusion-live-create-spec"), { description: text, template: "library", name: spec.LIVE_CREATE_NAME });
  assert.deepEqual([plan.family, plan.familySource, plan.name, plan.services.length], ["library", "template", "live-durations", 0]);
  const task = createTask(plan);
  assert.ok(task.length < RISK_TEXT_LIMITS.maxChars);
  assert.ok(task.includes(text.replace(/[.!?]*$/u, ".")), "the build task carries the whole specification");
  assert.deepEqual(scanRiskText([task], "task").codes, [], "no risk signal in the build task");
});

test("v0.1 live create spec: the live script uses it, with its authorization, attempt limits and turn budgets unchanged", async () => {
  const script = await readFile(join(REPO, "scripts", "v01-live-acceptance.mjs"), "utf8");
  assert.ok(script.includes('import { LIVE_CREATE_DESCRIPTION, LIVE_CREATE_NAME } from "./v01-live-create-spec.mjs";'));
  assert.ok(script.includes('fusion(["create", "--template", "library", "--name", LIVE_CREATE_NAME, "--", LIVE_CREATE_DESCRIPTION], workspace, true)'));
  assert.ok(!script.includes("formats a number of seconds as a short duration"), "the underspecified task is gone");
  assert.ok(script.includes('const AUTHORIZATION = "FUSION-V0.1-FINISH-LIVE";'));
  assert.ok(script.includes("const BUDGET = Object.freeze({ total: 50, perScenario: 12, attempts: 2 });"));
  assert.ok(script.includes("const RESERVE = Object.freeze({ chat: 1, analyze: 1, build: 8, create: 8 });"));
});
