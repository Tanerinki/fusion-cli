// Test-only child (§6/§49): a SEPARATE Fusion process that runs the REAL `fusion apply` and dies abruptly after the
// first file is written, leaving the delivery durably `applying` (interrupted) — so the parent proves the production
// apply path recovers from persisted state, not an in-process exception.
// Usage: node apply-crash-child.mjs <cwd> <localAppData> <xdgState> <deliveryId>
import { runCli } from "../../dist/src/cli/run.js";

const [, , cwd, localAppData, xdgState, deliveryId] = process.argv;
const env = { ...process.env, LOCALAPPDATA: localAppData, XDG_STATE_HOME: xdgState };
const registry = { factories: new Map(), defaults: { schemaVersion: 1, bindings: [], verification: { commands: [] }, limits: { runTimeoutMs: 60_000 } } };
const host = {
  env, cwd, registry,
  deliveryFaults: { afterOperation(i) { if (i === 0) { process.stdout.write("CRASH_AFTER_0"); process.exit(137); } } },
};
const code = await runCli(["apply", deliveryId], { stdout: () => {}, stderr: () => {}, interactive: false }, host);
process.stdout.write(`NO_CRASH:${code}`);
process.exit(code);
