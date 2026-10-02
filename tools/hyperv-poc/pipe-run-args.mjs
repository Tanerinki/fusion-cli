// Fusion v0.6 Hyper-V PoC - emit the EXACT pipe-worker docker argv from the tested builder (--network none + exactly one
// Fusion npipe; no bind mount, no engine pipe). Prints a JSON array or exits non-zero (fail closed).
//   usage: node pipe-run-args.mjs <name> <image> <pipePath> <cmd...>
import { buildPipeWorkerRunArgs, assertPipeWorkerArgv } from "./argv.mjs";
const [name, image, pipe, ...cmd] = process.argv.slice(2);
if (!name || !image || !pipe || cmd.length === 0) { console.error("usage: node pipe-run-args.mjs <name> <image> <pipePath> <cmd...>"); process.exit(64); }
let args;
try { args = buildPipeWorkerRunArgs({ name, image, pipe, cmd, rm: true, detach: true }); }
catch (e) { console.error(`REFUSED: ${String(e && e.message)}`); process.exit(2); }
const chk = assertPipeWorkerArgv(args);
if (!chk.ok) { console.error(`REFUSED (argv invariant): ${chk.reasons.join("; ")}`); process.exit(2); }
process.stdout.write(JSON.stringify(args));
