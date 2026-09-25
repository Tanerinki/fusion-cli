import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import type { BindingConfig } from "../../src/app/config.js";
import { ADJUDICATION_ONLY_TURNS, runAdjudicationProbe, type AdjudicationProbeAuthorization, type AdjudicationProbeDependencies,
  type AdjudicationProbeRefusal, type AdjudicationProbeReport } from "../../src/app/adjudication-probe.js";
import { adjudicationFindingsIdentity, reviewCandidateIdentity } from "../../src/app/route-fixture.js";
import { grantedBinding, routeFixtureIdentity, type RouteRole, type RouteRoleGrant } from "../../src/app/route-probe.js";
import { PROPOSAL_PROBE_PROFILES, ROUTE_LEAD_ADJUDICATOR } from "../../src/providers/probe-profiles.js";
import type { AttachContext } from "./fake-docker.js";
import type { Installs } from "./provider-installs.js";
import { routeCompose, routeEnv, routeRegistry, type ScriptedTurn } from "./route-harness.js";

/**
 * O5.5B28 offline harness of the Lead-adjudication probe: the REAL one-shot adapter code (built exactly as the route harness
 * builds the route Lead) launches the scripted fake native binary; the real candidate port, view store and Docker backend
 * run over the real route fixture with the in-memory daemon and the dependency lane. Every run is labelled
 * `offlineRehearsal`, never live evidence.
 */
export const TEST_ADJUDICATION = "TEST-ADJUDICATION";
/** The production Lead grant with the fake binary's executable name and a short timeout: the same family, release, binding and flags. */
export function testLeadGrant(patch: Partial<RouteRoleGrant> = {}): RouteRoleGrant {
  return { ...ROUTE_LEAD_ADJUDICATOR, executable: basename(process.execPath), requiredEnvironment: [],
    binding: { ...ROUTE_LEAD_ADJUDICATOR.binding, options: { ...ROUTE_LEAD_ADJUDICATOR.binding.options, timeoutMs: 20_000 } }, ...patch };
}
export function testAdjudicationAuthorization(patch: Partial<AdjudicationProbeAuthorization> = {},
  lead: Partial<RouteRoleGrant> = {}): AdjudicationProbeAuthorization {
  return { milestone: "TEST", evidenceDirectory: "fusion-test-adjudication", state: "open", lead: testLeadGrant(lead), turns: ADJUDICATION_ONLY_TURNS,
    fixtureSha256: routeFixtureIdentity(), candidateSha256: reviewCandidateIdentity(), findingsSha256: adjudicationFindingsIdentity(), ...patch };
}
/** The granted binding plus only the fake install's location (the test seam). */
export function testLeadBinding(i: Installs, authorization: AdjudicationProbeAuthorization, patch: Partial<BindingConfig> = {}): BindingConfig {
  const granted = grantedBinding("Lead", authorization.lead);
  return { ...granted, ...patch, options: { executable: i.claudeExe, ...granted.options, ...patch.options } };
}

export interface AdjudicationRun { readonly report: AdjudicationProbeReport; readonly prompts: readonly string[];
  readonly streamed: AttachContext[]; readonly root: string }
/**
 * One Lead-adjudication probe under the test authorization (own namespace `name` under `dir`) with the scripted Lead turns.
 * The Worker and Reviewer have empty scripts: any turn of theirs would fail the fake.
 */
export async function runAdjudication(i: Installs, dir: string, name: string, turns: readonly ScriptedTurn[],
  options: Readonly<{ authorization?: AdjudicationProbeAuthorization; binding?: Partial<BindingConfig>; extra?: Readonly<Record<string, string>>;
    env?: NodeJS.ProcessEnv; deps?: Partial<AdjudicationProbeDependencies> }> = {}): Promise<AdjudicationRun | AdjudicationProbeRefusal> {
  const authorization = options.authorization ?? testAdjudicationAuthorization();
  const scriptDir = join(dir, `${name}-scripts`);
  await mkdir(scriptDir, { recursive: true });
  const paths: Record<RouteRole, string> = { Lead: join(scriptDir, "Lead.json"), Worker: join(scriptDir, "Worker.json"), Reviewer: join(scriptDir, "Reviewer.json") };
  await writeFile(paths.Lead, JSON.stringify(turns));
  await writeFile(paths.Worker, "[]");
  await writeFile(paths.Reviewer, "[]");
  const streamed: AttachContext[] = [];
  const root = join(dir, name);
  const report = await runAdjudicationProbe({ env: options.env ?? routeEnv(), registry: routeRegistry(i, paths, options.extra ? { Lead: options.extra } : {}),
    profiles: { families: PROPOSAL_PROBE_PROFILES, authorizations: { [TEST_ADJUDICATION]: authorization } }, authorization: TEST_ADJUDICATION,
    evidenceRoot: root, binding: testLeadBinding(i, authorization, options.binding), offlineRehearsal: true, compose: routeCompose(dir, streamed),
    ...options.deps });
  if ("refused" in report) return report;
  let text = "";
  try { text = await readFile(`${paths.Lead}.prompts.jsonl`, "utf8"); } catch { /* no model turn */ }
  return { report, prompts: text.split("\n").filter(Boolean).map(line => (JSON.parse(line) as { prompt: string }).prompt), streamed, root };
}
export function asAdjudicationRun(value: AdjudicationRun | AdjudicationProbeRefusal): AdjudicationRun {
  if ("refused" in value) throw new Error(`refused: ${value.reason}: ${value.message}`);
  return value;
}
export const evidenceOf = <T>(run: AdjudicationRun, name: string): T => run.report.evidence[name] as T;
