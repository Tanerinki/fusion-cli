import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { raceAbort } from "../src/core/cancellation.js";
import { BoundedReadError, readBoundedFile } from "../src/platform/fs/bounded-read.js";
import { JsonlDecoder, JsonlError } from "../src/platform/process/jsonl.js";
import { parseStrictJson, StrictJsonError } from "../src/platform/process/strict-json.js";
import { ProcessSupervisor, type ProcessSpec, type TreeTerminator } from "../src/platform/process/supervisor.js";

const cwd = process.cwd();
const supervisor = new ProcessSupervisor();
const unhandled: unknown[] = [];
process.on("unhandledRejection", reason => { unhandled.push(reason); });

function node(script: string, overrides: Partial<ProcessSpec> = {}) {
  return supervisor.start({ executable: process.execPath, args: ["-e", script], cwd, env: { ...process.env },
    timeoutMs: 10_000, graceMs: 100, ...overrides });
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
async function killIfAlive(pid: number): Promise<void> {
  if (pid > 0 && alive(pid)) { try { process.kill(pid); } catch { /* already gone */ } }
  for (let i = 0; i < 40 && pid > 0 && alive(pid); i++) await new Promise(resolve => setTimeout(resolve, 25));
}
/**
 * A root that starts a *detached* grandchild inheriting its stdio (as a background daemon would), prints the
 * grandchild PID, and exits at once. A non-detached grandchild would die with the root: on Windows, libuv puts
 * each Node process's direct children in a kill-on-close job object.
 */
const LEAKY_ROOT = [
  'const {spawn} = require("node:child_process");',
  'const g = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {stdio: "inherit", detached: true, windowsHide: true});',
  'process.stdout.write(String(g.pid) + "\\n");',
  'g.unref(); process.exit(0);',
].join("");

test("M7.1-A an already-aborted signal never starts the child", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-m7-abort-"));
  const marker = join(dir, "spawned.txt");
  try {
    const controller = new AbortController(); controller.abort();
    const run = node(`require("node:fs").writeFileSync(${JSON.stringify(marker)}, "x")`, { signal: controller.signal });
    const outcome = await run.result;
    assert.equal(run.pid, null);
    assert.equal(outcome.pid, null);
    assert.equal(outcome.issue?.kind, "Cancelled");
    assert.deepEqual(outcome.termination, { reason: "user", forced: false, method: "none" });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(existsSync(marker), false, "cancelled launch must not execute the child");
    await assert.rejects(run.writeStdin("x"));
    await run.cancel("user");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("M7.1-B/G concurrent and repeated cancellation is typed, idempotent and single-cleanup", async () => {
  const controller = new AbortController();
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const run = node('process.stdout.write("ready\\n"); setInterval(() => {}, 1000)', {
    signal: controller.signal, onStdoutText: text => { if (text.includes("ready")) ready(); } });
  await started;
  const first = run.cancel("user");
  assert.equal(run.cancel("timeout"), first, "a second request joins the first cancellation");
  controller.abort();
  await Promise.all([first, run.cancel("shutdown")]);
  const outcome = await run.result;
  assert.equal(outcome.issue?.kind, "Cancelled");
  assert.equal(outcome.termination?.reason, "user");
  assert.equal(outcome.termination?.forced, true);
  assert.notEqual(outcome.exitCode, 0);
  await run.cancel("user");
  assert.equal((await run.result).termination?.reason, "user");
  assert.equal(outcome.pid !== null && alive(outcome.pid), false);
});

test("M7.1-C cancelling while a large stdin write is blocked settles without unhandled rejection", async () => {
  const before = unhandled.length;
  const run = node("setInterval(() => {}, 1000)", { stdin: "x".repeat(8 * 1024 * 1024) });
  await new Promise(resolve => setTimeout(resolve, 150));
  await run.cancel("user");
  const outcome = await run.result;
  assert.equal(outcome.issue?.kind, "Cancelled");
  assert.ok(["failed", "unknown", "acceptedByPipe"].includes(outcome.stdinWriteStatus));
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(unhandled.length, before);
});

test("M7.1-D cancelling while output is streaming keeps collected bytes bounded and typed", async () => {
  let seen = 0;
  let ready!: () => void;
  const flowing = new Promise<void>(resolve => { ready = resolve; });
  const run = node('setInterval(() => process.stdout.write("x".repeat(512) + "\\n"), 1)', {
    onStdoutText: text => { seen += text.length; if (seen > 4096) ready(); } });
  await flowing;
  await run.cancel("user");
  const outcome = await run.result;
  assert.equal(outcome.issue?.kind, "Cancelled");
  assert.equal(outcome.stdoutTruncated, false);
  assert.ok(outcome.stdout.length > 0);
});

test("M7.1-F cancelling after a completed exit neither rewrites nor delays the outcome", async () => {
  const run = node('process.stdout.write("done\\n")');
  const outcome = await run.result;
  await run.cancel("user");
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.issue, undefined);
  assert.equal(outcome.termination, undefined);
});

test("M7.2 timeout, spawn failure, user cancellation and non-zero exit stay distinct", async () => {
  const timeout = await node("setInterval(() => {}, 1000)", { timeoutMs: 60 }).result;
  const spawnFailure = await supervisor.start({ executable: join(tmpdir(), "fusion-m7-missing.exe"), args: [], cwd,
    env: { ...process.env }, timeoutMs: 2_000 }).result;
  const cancelledRun = node("setInterval(() => {}, 1000)");
  await cancelledRun.cancel("user");
  const cancelled = await cancelledRun.result;
  const nonzero = await node("process.exit(3)").result;
  assert.deepEqual([timeout.issue?.kind, spawnFailure.issue?.kind, cancelled.issue?.kind, nonzero.issue?.kind],
    ["Timeout", "SpawnFailure", "Cancelled", undefined]);
  assert.equal(timeout.termination?.reason, "timeout");
  assert.equal(nonzero.exitCode, 3);
  assert.equal(nonzero.termination, undefined);
});

test("M7.3 a descendant holding stdout after the child exits cannot hang the supervisor", async () => {
  let grandchild = 0;
  const started = performance.now();
  try {
    const outcome = await node(LEAKY_ROOT, { stdioDrainMs: 300,
      onStdoutText: text => { const match = /\d+/u.exec(text); if (match) grandchild = Number(match[0]); } }).result;
    assert.ok(performance.now() - started < 5_000, "settled by the bounded drain, not by the grandchild's exit");
    assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.issue?.kind, "StreamError");
    assert.equal(outcome.termination, undefined, "no PID-based kill after the child already exited");
  } finally { await killIfAlive(grandchild); }
});

test("M7.3 cancelling after the child exited never signals a possibly reused PID", async () => {
  let grandchild = 0;
  let ready!: () => void;
  const printed = new Promise<void>(resolve => { ready = resolve; });
  try {
    const run = node(LEAKY_ROOT, { stdioDrainMs: 10_000,
      onStdoutText: text => { const match = /\d+/u.exec(text); if (match) { grandchild = Number(match[0]); ready(); } } });
    await printed;
    await new Promise(resolve => setTimeout(resolve, 400));
    const started = performance.now();
    await run.cancel("user");
    const outcome = await run.result;
    assert.ok(performance.now() - started < 3_000);
    assert.equal(outcome.issue?.kind, "Cancelled");
    assert.equal(outcome.exitCode, 0);
    // The root exited on its own BEFORE cleanup began, so its PID is unsafe to enumerate (it may be reused). The owned
    // tree is therefore UNVERIFIABLE and cleanup fails CLOSED - never a PID-based kill of a possibly-reused PID, and
    // never "clean" merely because the root is gone (a leaked descendant may remain).
    assert.equal(outcome.termination?.forced, false, "no forced PID-based kill of a possibly-reused PID");
    assert.equal(outcome.termination?.method, "none");
    assert.match(outcome.termination?.cleanupError ?? "", /could not be captured for verification/u);
  } finally { await killIfAlive(grandchild); }
});

test("M7.3 a forced termination that does not stop the child still settles within a bound", async () => {
  const ineffective: TreeTerminator = async () => ({ method: "taskkill" });
  const stubborn = new ProcessSupervisor(undefined, ineffective);
  const run = stubborn.start({ executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], cwd,
    env: { ...process.env }, graceMs: 50, killWaitMs: 200 });
  const pid = run.pid ?? 0;
  try {
    const started = performance.now();
    await run.cancel("user");
    const outcome = await run.result;
    assert.ok(performance.now() - started < 3_000);
    assert.equal(outcome.issue?.kind, "Cancelled");
    assert.equal(outcome.exitCode, null, "no exit status is claimed for a surviving process");
    assert.equal(outcome.termination?.forced, true);
    assert.match(outcome.termination?.cleanupError ?? "", /did not exit/);
  } finally { await killIfAlive(pid); }
});

test("M7.3 a throwing tree terminator is recorded and does not escape", async () => {
  const throwing: TreeTerminator = async () => { throw new Error("terminator failure"); };
  const run = new ProcessSupervisor(undefined, throwing).start({ executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"], cwd, env: { ...process.env }, graceMs: 50, killWaitMs: 150 });
  const pid = run.pid ?? 0;
  try {
    await run.cancel("user");
    const outcome = await run.result;
    // The throwing terminator never kills the child, so the root stays alive: the owned-tree probe authoritatively
    // reports the root did not exit, and cleanup fails closed (a throwing terminator can never be a clean cleanup).
    assert.match(outcome.termination?.cleanupError ?? "", /did not exit/u);
  } finally { await killIfAlive(pid); }
});

test("M7.4 invalid UTF-8 on stderr is replaced; on stdout it stays a protocol error", async () => {
  const stderrOnly = await node('process.stderr.write(Buffer.from([0x66, 0xff, 0x0a])); process.stdout.write("ok\\n")').result;
  assert.equal(stderrOnly.exitCode, 0);
  assert.equal(stderrOnly.issue, undefined);
  assert.match(stderrOnly.stderr, /�/u);
  const stdout = await node("process.stdout.write(Buffer.from([0xff])); setInterval(() => {}, 1000)").result;
  assert.equal(stdout.issue?.kind, "ProtocolError");
});

test("M7.5 unretained stdout keeps observers and byte limits but not the bytes", async () => {
  let observed = "";
  const kept = await node('process.stdout.write("y".repeat(1000))', { retainStdout: false,
    onStdoutText: text => { observed += text; } }).result;
  assert.equal(kept.stdout, "");
  assert.equal(observed.length, 1000);
  const limited = await node('process.stdout.write("y".repeat(1000)); setInterval(() => {}, 1000)',
    { retainStdout: false, maxStdoutBytes: 100 }).result;
  assert.equal(limited.issue?.kind, "OutputLimit");
  assert.equal(limited.stdoutTruncated, true);
  assert.equal(limited.stdout, "");
});

test("M7.4 strict JSON rejects duplicate keys, excessive depth and trailing data", () => {
  const reason = (text: string, depth?: number): string => {
    try { parseStrictJson(text, depth); return "ok"; }
    catch (error) { return error instanceof StrictJsonError ? error.reason : "other"; }
  };
  assert.equal(reason('{"a":1,"a":2}'), "duplicateKey");
  assert.equal(reason('{"x":{"status":"failed","status":"completed"}}'), "duplicateKey");
  assert.equal(reason('{"a":1,"\\u0061":2}'), "duplicateKey", "escaped spellings of one key are one key");
  assert.equal(reason('[{"a":1},{"a":2}]'), "ok", "equal keys in sibling objects are distinct");
  assert.equal(reason('{"a":"{\\"b\\":1,\\"b\\":2}","c":"[[[["}'), "ok", "string contents are not structure");
  assert.equal(reason(`${"[".repeat(64)}${"]".repeat(64)}`), "ok");
  assert.equal(reason(`${"[".repeat(65)}${"]".repeat(65)}`), "tooDeep");
  assert.equal(reason(`${"[".repeat(100_000)}${"]".repeat(100_000)}`), "tooDeep");
  assert.equal(reason("[[1]]", 1), "tooDeep");
  for (const invalid of ["", "   ", '{"a":1', '{"a":1} x', '{"a":1}{"b":2}', "{bad}"])
    assert.equal(reason(invalid), "invalidJson", `rejects ${JSON.stringify(invalid)}`);
  assert.deepEqual(parseStrictJson('{"k":[1,{"m":null}]}'), { k: [1, { m: null }] });
});

test("M7.4 JSONL reports duplicate keys and depth, frames primitives, and rejects whitespace records", () => {
  const values: unknown[] = [];
  const decoder = new JsonlDecoder(value => values.push(value));
  decoder.push(Buffer.from('42\n"text"\nnull\n'));
  assert.deepEqual(values, [42, "text", null], "framing accepts any JSON value; adapters validate shape");
  const failure = (input: string, depth?: number): string => {
    try { const d = new JsonlDecoder(() => {}, 1_048_576, undefined, depth); d.push(Buffer.from(input)); d.finish(); return "ok"; }
    catch (error) { return error instanceof JsonlError ? error.reason : "other"; }
  };
  assert.equal(failure('{"a":1,"a":2}\n'), "duplicateKey");
  assert.equal(failure(`${"[".repeat(10)}${"]".repeat(10)}\n`, 5), "tooDeep");
  assert.equal(failure("   \n"), "invalidJson");
  assert.equal(failure('{"a":1'), "invalidJson", "a truncated final record is rejected at EOF");
});

test("M7.5 JSONL framing stays linear when a long line arrives one byte at a time", () => {
  const line = Buffer.from(`${JSON.stringify({ pad: "z".repeat(300_000) })}\n`);
  let count = 0;
  const decoder = new JsonlDecoder(() => { count += 1; });
  const started = performance.now();
  for (let i = 0; i < line.length; i++) decoder.push(line.subarray(i, i + 1));
  decoder.finish();
  assert.equal(count, 1);
  assert.ok(performance.now() - started < 3_000, "per-chunk work must not rescan the pending line");
  assert.throws(() => { const d = new JsonlDecoder(() => {}, 1024); for (let i = 0; i < 2048; i++) d.push(Buffer.from("x")); },
    (error: unknown) => error instanceof JsonlError && error.reason === "lineTooLong");
});

test("M7.5 bounded reads refuse oversized, non-regular and grown files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "fusion-m7-bounded-"));
  try {
    const file = join(dir, "config.json");
    await writeFile(file, "x".repeat(64));
    assert.equal((await readBoundedFile(file, 64)).length, 64);
    await assert.rejects(readBoundedFile(file, 63), (error: unknown) => error instanceof BoundedReadError && error.reason === "tooLarge");
    await mkdir(join(dir, "folder"));
    await assert.rejects(readBoundedFile(join(dir, "folder"), 64));
    await assert.rejects(readBoundedFile(join(dir, "absent.json"), 64), { code: "ENOENT" });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("M7.1 raceAbort settles on cancellation and never leaks the abandoned rejection", async () => {
  const before = unhandled.length;
  assert.equal(await raceAbort(Promise.resolve(5), new AbortController().signal, () => new Error("cancelled")), 5);
  const controller = new AbortController();
  let rejectLater!: (error: Error) => void;
  const pending = new Promise<number>((_resolve, reject) => { rejectLater = reject; });
  const raced = raceAbort(pending, controller.signal, () => new Error("cancelled"));
  controller.abort();
  await assert.rejects(raced, /cancelled/);
  rejectLater(new Error("late failure"));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(raceAbort(Promise.reject(new Error("x")), aborted.signal, () => new Error("pre-aborted")), /pre-aborted/);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(unhandled.length, before);
});
