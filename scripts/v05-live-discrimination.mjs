// v0.5 live acceptance L4 — Fusion's deterministic experiment separates KNOWN fixture candidates in the real confined backend.
// No model is involved: two ChangeSets Fusion builds from the fixture's own baseline — a correct fix of configuration.yaml
// (trusted_proxies inside `http:`) and the same fix plus a new top-level section — are materialized in fresh private candidates
// and run through the configured preservation probe against the unchanged baseline, exactly as a tournament runs it.
// Used by scripts/v05-live-acceptance.mjs; its logic is pinned offline by test/v05-live-verdicts.test.ts (over the fake backend,
// where it can never be a live PASS).
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const load = path => import(pathToFileURL(join(REPO, "dist", ...path.split("/"))).href);
const sha256 = text => createHash("sha256").update(text, "utf8").digest("hex");
const HTTP = "http:\n  use_x_forwarded_for: true\n";

/** The two known candidates for a fixture whose configuration.yaml is `text`. */
export function knownCandidates(text) {
  if (!text.includes(HTTP)) throw new Error("the fixture's configuration.yaml has no http section to fix");
  const fixed = text.replace(HTTP, `${HTTP}  trusted_proxies:\n    - 172.30.33.0/24\n`);
  const write = content => ({ schemaVersion: 1, operations: [{ kind: "writeText", path: "configuration.yaml", expectedSha256: sha256(text), content }] });
  return { good: write(fixed), changed: write(`${fixed}\ndebug:\n  enabled: true\n`) };
}

/**
 * Runs the configured experiments on both known candidates. `compose` is the production composition in the live run (it
 * acquires the real acceptance); a test passes an offline one. Returns the acceptance and each candidate's probe result.
 */
export async function discriminate({ root, compose, registry, env = process.env }) {
  const { parseConfig } = await load("src/app/config.js");
  const { runBaselineProbes, runCandidateExperiments } = await load("src/app/tournament/experiments.js");
  const { patchSha256 } = await load("src/core/tournament/manifest.js");
  const config = parseConfig(JSON.parse(await readFile(join(root, "fusion.config.json"), "utf8")));
  const specs = config.verification.experiments;
  if (specs === undefined || specs.probes.length === 0) throw new Error("the fixture configures no experiment (create-git --experiments)");
  const composition = await compose({ root, config, registry, env });
  const acceptance = composition.verification.acceptance;
  if (acceptance === "refused") return { acceptance, good: "notRun", bad: "notRun", cleanup: true };
  const port = composition.workspace, profile = sha256("fusion v0.5 live L4");
  const baseline = await runBaselineProbes(port, "v05-live-l4.baseline", specs);
  const text = await readFile(join(root, "configuration.yaml"), "utf8");
  const known = knownCandidates(text);
  const scope = { allowedPaths: ["configuration.yaml"], forbiddenPaths: [] };
  const judge = async (candidate, changes) => {
    const op = changes.operations[0];
    const target = { candidate, revision: sha256(`${candidate}:${JSON.stringify(changes)}`), changes, scope,
      patchSha256: patchSha256([{ kind: op.kind, path: op.path, beforeSha256: op.expectedSha256, afterSha256: sha256(op.content), bytes: Buffer.byteLength(op.content) }]) };
    const batch = await runCandidateExperiments(port, `v05-live-l4.${candidate}`, target, specs, profile, baseline.observations);
    if (batch.violation !== undefined) throw new Error(`a security violation stopped the check: ${batch.violation}`);
    return { result: batch.nodes.find(n => n.id === `probe:${specs.probes[0].id}`)?.result ?? "notRun", cleanup: batch.cleanup };
  };
  const good = await judge("c1", known.good), bad = await judge("c2", known.changed);
  const cleanup = [...baseline.cleanup, ...good.cleanup, ...bad.cleanup].every(c => c.complete);
  return { acceptance, good: good.result, bad: bad.result, cleanup };
}
