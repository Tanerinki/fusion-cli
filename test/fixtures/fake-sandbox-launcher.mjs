// Test-only FAKE sandbox launcher (§49). It stands in for the real native `fusion-sandbox.exe` in DETERMINISTIC tests:
// it implements the same launcher CONTRACT the real one does — read `--spec spec.json`, bridge stdio transparently, exit
// with the simulated child's exit code, and write a bounded `result.json` — WITHOUT a real AppContainer. It is driven by
// the production `ProcessSupervisor` sandbox branch (the same code path the real launcher uses), so it proves the WIRING;
// the real OS confinement is proven separately by the maintainer-live suite with the REAL launcher. It echoes the spec's
// minimized env, network policy and grants so the test can assert they were carried, and interprets the provider command
// (spec.command.args) to simulate the child's stdout/stderr/exit/hang.
import { readFileSync, writeFileSync } from "node:fs";

const argv = process.argv.slice(2);
const specPath = argv[argv.indexOf("--spec") + 1];
const resultPath = argv[argv.indexOf("--result") + 1];
const spec = JSON.parse(readFileSync(specPath, "utf8"));

// Echo what the launcher received, so the supervisor->launcher hand-off is observable in stdout.
process.stdout.write(`SPEC_IDENTITY:${spec.identity}\n`);
process.stdout.write(`SPEC_ENV:${JSON.stringify(spec.env ?? {})}\n`);
process.stdout.write(`SPEC_NETWORK:${JSON.stringify(spec.network ?? null)}\n`);
process.stdout.write(`SPEC_READPATHS:${JSON.stringify(spec.readPaths ?? [])}\n`);
process.stdout.write(`SPEC_WRITEPATHS:${JSON.stringify(spec.writePaths ?? [])}\n`);
process.stdout.write(`SPEC_COMMAND:${JSON.stringify(spec.command ?? null)}\n`);

const cmdArgs = (spec.command && Array.isArray(spec.command.args)) ? spec.command.args : [];
const valueAfter = (flag) => { const i = cmdArgs.indexOf(flag); return i >= 0 ? cmdArgs[i + 1] : undefined; };

const writeResult = (exitCode, timedOut) => {
  try {
    writeFileSync(resultPath, JSON.stringify({ schemaVersion: 1, kind: "run", exitCode, timedOut,
      jobTotalProcesses: 1, jobActiveBeforeKill: 0 }));
  } catch { /* best effort */ }
};

// --hang: never exit on its own; the supervisor's timeout/cancel must kill this process (the real launcher's Job then
// tears down the sandboxed tree). We do NOT write result.json, mirroring a killed launcher.
if (cmdArgs.includes("--hang")) {
  process.stdout.write("HANGING\n");
  setInterval(() => {}, 1 << 30);
} else {
  const emit = valueAfter("--emit");
  if (emit !== undefined) process.stdout.write(`OUT:${emit}\n`);
  const emitErr = valueAfter("--emit-stderr");
  if (emitErr !== undefined) process.stderr.write(`ERR:${emitErr}\n`);
  const jsonl = valueAfter("--jsonl");
  if (jsonl !== undefined) process.stdout.write(`${jsonl}\n`);

  const exitCode = valueAfter("--exit") !== undefined ? Number(valueAfter("--exit")) : 0;

  // Bridge stdin transparently (a real provider turn streams its prompt in): echo it, then finish.
  let stdin = "";
  process.stdin.on("data", (c) => { stdin += c.toString("utf8"); });
  process.stdin.on("end", () => {
    if (stdin.length > 0) process.stdout.write(`STDIN:${stdin}\n`);
    writeResult(exitCode, false);
    process.exit(exitCode);
  });
  // If stdin is already closed (no input), 'end' still fires; guard for environments that don't emit it promptly.
  process.stdin.resume();
}
