#!/usr/bin/env node
// v0.5 OFFLINE ROUTING CALIBRATION — what this repository's past builds say about the routing policy, read from Fusion's own
// run records under .fusion/runs. Read-only: it writes nothing, starts no provider and changes no routing. The records carry
// labels and counts only (task class, risk, route, outcome, candidate states) — never task text, paths or model text.
//
//   npm run build
//   node scripts/v05-routing-calibration.mjs [--repo <dir>] [--limit <runs>] [--policy <id>] [--json]
//
// Each policy is evaluated against the same runs: how many tournaments it would add or drop, the separations (Fusion's
// evidence rejected one candidate while it verified another) observed in dropped tournaments, and — only for groups with at
// least 3 observed tournaments — the estimated separations in added ones. A routing change remains a versioned code change.
import { resolve } from "node:path";
import { collectRoutingRecords, renderCalibration } from "../dist/src/app/calibration.js";
import { CALIBRATION_POLICIES, whatIf } from "../dist/src/core/tournament/calibration.js";
import { DiagnosticRedactor } from "../dist/src/core/policy/redaction.js";

const args = process.argv.slice(2);
const options = { json: false };
const fail = message => { process.stderr.write(`${message}
`); process.exit(2); };
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--json") options.json = true;
  else if ((arg === "--repo" || arg === "--limit" || arg === "--policy") && i + 1 < args.length) options[arg.slice(2)] = args[++i];
  else fail(`Unknown or incomplete option: ${arg}`);
}
if (options.limit !== undefined && !/^[1-9][0-9]{0,3}$/u.test(options.limit)) fail("--limit must be a whole number from 1 to 1000.");
const repository = resolve(options.repo ?? process.cwd());
const limit = options.limit === undefined ? undefined : Number(options.limit);
const policies = options.policy === undefined ? CALIBRATION_POLICIES : CALIBRATION_POLICIES.filter(p => p.id === options.policy);
if (policies.length === 0) fail(`Unknown policy. Known: ${CALIBRATION_POLICIES.map(p => p.id).join(", ")}`);
const collected = await collectRoutingRecords(repository, DiagnosticRedactor.fromEnvironment(process.env), limit);
const reports = policies.map(policy => whatIf(collected.records, policy));
const meta = { repository, records: collected.records.length, skipped: collected.skipped, unreadable: collected.unreadable };
process.stdout.write(options.json ? `${JSON.stringify({ ...meta, reports }, null, 2)}\n` : renderCalibration({ ...meta, reports }));
