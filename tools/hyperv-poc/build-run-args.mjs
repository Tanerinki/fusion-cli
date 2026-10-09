// Fusion v0.6 Hyper-V PoC — emit the EXACT worker `docker` argv from the pure, CI-tested builder, so the argv that runs
// live is the one CI proves (not a hand-assembled copy). Prints the argv as a JSON array on stdout, or exits non-zero if
// the builder/asserter rejects it (fail closed). run.ps1 executes `docker @args` with exactly this array.
//   usage: node build-run-args.mjs <name> <image> <network> <keepAliveCmd...>  [--env NAME=VALUE ...]
import { buildWorkerRunArgs, assertWorkerArgv } from "./argv.mjs";

const argv = process.argv.slice(2);
const env = {};
const positional = [];
let detach = false;
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--env") { const kv = argv[++i] ?? ""; const eq = kv.indexOf("="); if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1); }
  else if (argv[i] === "--detach") detach = true;
  else positional.push(argv[i]);
}
const [name, image, network, ...cmd] = positional;
if (!name || !image || !network || cmd.length === 0) { console.error("usage: build-run-args.mjs <name> <image> <network> <cmd...> [--detach] [--env NAME=VALUE ...]"); process.exit(64); }

let args;
try { args = buildWorkerRunArgs({ name, image, network, isolation: "hyperv", rm: true, detach, env, cmd }); }
catch (e) { console.error(`REFUSED: ${String(e && e.message)}`); process.exit(2); }
const check = assertWorkerArgv(args);
if (!check.ok) { console.error(`REFUSED (argv invariant): ${check.reasons.join("; ")}`); process.exit(2); }
process.stdout.write(JSON.stringify(args));
