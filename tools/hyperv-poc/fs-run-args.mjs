// Fusion v0.6 Hyper-V PoC - emit the EXACT filesystem-worker docker argv from the tested builder (--isolation=hyperv,
// --network none, ZERO mounts of any kind). Prints a JSON array or exits non-zero (fail closed).
//   usage: node fs-run-args.mjs <name> <image> <cmd...>
import { buildFsWorkerRunArgs, assertFsWorkerArgv } from "./argv.mjs";
const [name, image, ...cmd] = process.argv.slice(2);
if (!name || !image || cmd.length === 0) { console.error("usage: node fs-run-args.mjs <name> <image> <cmd...>"); process.exit(64); }
let args;
try { args = buildFsWorkerRunArgs({ name, image, cmd, rm: true, detach: true }); }
catch (e) { console.error(`REFUSED: ${String(e && e.message)}`); process.exit(2); }
const chk = assertFsWorkerArgv(args);
if (!chk.ok) { console.error(`REFUSED (argv invariant): ${chk.reasons.join("; ")}`); process.exit(2); }
process.stdout.write(JSON.stringify(args));
