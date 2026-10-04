import assert from "node:assert/strict";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { JsonlDecoder, JsonlError } from "../src/platform/process/jsonl.js";
import { assertNativeExecutablePath, InvalidProcessInputError, normalizeWindowsPathForComparison, resolveVersionedExecutable } from "../src/platform/process/native-executable.js";
import { ProcessSupervisor } from "../src/platform/process/supervisor.js";

const cwd = process.cwd();
const supervisor = new ProcessSupervisor();

function localProcess(script: string, overrides: Partial<Parameters<ProcessSupervisor["start"]>[0]> = {}) {
  return supervisor.start({
    executable: process.execPath,
    args: ["-e", script],
    cwd,
    env: { ...process.env },
    timeoutMs: 3_000,
    graceMs: 100,
    ...overrides,
  });
}

test("JSONL frames partial UTF-8, CRLF, and a final line without newline", () => {
  const values: unknown[] = [];
  const parser = new JsonlDecoder((value) => values.push(value));
  const bytes = Buffer.from('{"text":"ü"}\r\n{"n":2}', "utf8");
  const split = bytes.indexOf(0xc3) + 1;
  parser.push(bytes.subarray(0, split));
  parser.push(bytes.subarray(split, bytes.length - 1));
  parser.push(bytes.subarray(bytes.length - 1));
  parser.finish();
  assert.deepEqual(values, [{ text: "ü" }, { n: 2 }]);
});

test("JSONL rejects invalid JSON, invalid UTF-8, and unbounded lines", () => {
  assert.throws(() => new JsonlDecoder(() => {}).push(Buffer.from("{bad}\n")),
    (error: unknown) => error instanceof JsonlError && error.reason === "invalidJson");
  assert.throws(() => new JsonlDecoder(() => {}).push(Buffer.from([0xff])),
    (error: unknown) => error instanceof JsonlError && error.reason === "invalidUtf8");
  assert.throws(() => new JsonlDecoder(() => {}, 4).push(Buffer.from("12345")),
    (error: unknown) => error instanceof JsonlError && error.reason === "lineTooLong");
});

test("supervisor keeps stdout/stderr separate and emits incremental JSONL", async () => {
  const events: unknown[] = [];
  const script = [
    'process.stdin.setEncoding("utf8");',
    'let input="";',
    'process.stdin.on("data", x => input += x);',
    'process.stdin.on("end", () => {',
    '  process.stdout.write(Buffer.from("{\\"text\\":\\"ü\\"}\\n"));',
    '  process.stdout.write(JSON.stringify({input}) + "\\n");',
    '  process.stderr.write("diagnostic\\n");',
    '});',
  ].join("");
  const run = localProcess(script, { stdin: "a\n日本", onJsonl: (value) => events.push(value) });
  const outcome = await run.result;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.issue, undefined);
  assert.deepEqual(events, [{ text: "ü" }, { input: "a\n日本" }]);
  assert.match(outcome.stderr, /diagnostic/);
  assert.doesNotMatch(outcome.stdout, /diagnostic/);
});

test("observer failure is recorded separately and does not cancel a healthy child", async () => {
  const outcome = await localProcess('process.stdout.write("valid output\\n")', {
    onStdoutText: () => { throw new Error("observer secret must not be logged"); },
  }).result;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.issue, undefined);
  assert.equal(outcome.termination, undefined);
  assert.deepEqual(outcome.observerIssues.map((item) => item.channel), ["stdout"]);
  assert.doesNotMatch(JSON.stringify(outcome), /observer secret/);
});

test("JSONL observer exception does not corrupt later valid records", async () => {
  const seen: unknown[] = [];
  const outcome = await localProcess('process.stdout.write("{\\"n\\":1}\\n{\\"n\\":2}\\n")', {
    onJsonl: (value) => {
      seen.push(value);
      if (seen.length === 1) throw new Error("observer failed");
    },
  }).result;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.issue, undefined);
  assert.equal(outcome.termination, undefined);
  assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
  assert.deepEqual(outcome.observerIssues.map((item) => item.channel), ["jsonl"]);
});

test("early child exit preserves usage code without spurious stdin error", async () => {
  const outcome = await localProcess("process.exit(2)", { stdin: "x".repeat(1_000_000) }).result;
  assert.equal(outcome.exitCode, 2);
  assert.notEqual(outcome.issue?.kind, "StreamError");
  assert.ok(["acceptedByPipe", "failed", "unknown"].includes(outcome.stdinWriteStatus));
});

test("supervisor reports missing binary without hanging", async () => {
  const outcome = await supervisor.start({
    executable: join(tmpdir(), "fusion-nonexistent-binary.exe"), args: [], cwd,
    env: { ...process.env }, timeoutMs: 1_000,
  }).result;
  assert.equal(outcome.issue?.kind, "SpawnFailure");
  assert.notEqual(outcome.exitCode, 0);
});

test("timeout records Fusion-owned kill reason and ends a long-running process", async () => {
  const outcome = await localProcess("setInterval(() => {}, 1000)", { timeoutMs: 80 }).result;
  assert.equal(outcome.issue?.kind, "Timeout");
  assert.equal(outcome.termination?.reason, "timeout");
  assert.equal(outcome.termination?.forced, true);
});

test("graceful cancellation sends protocol message before forcing", async () => {
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const script = [
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", text => { if (text.includes("stop")) process.exit(0); });',
    'process.stdout.write("ready\\n");',
    'setInterval(() => {}, 1000);',
  ].join("");
  const run = localProcess(script, {
    keepStdinOpen: true,
    graceMs: 500,
    onStdoutText: (text) => { if (text.includes("ready")) ready(); },
    gracefulCancel: async ({ writeStdin }) => { await writeStdin("stop\n"); },
  });
  await readyPromise;
  await run.cancel("user");
  await run.cancel("shutdown");
  const outcome = await run.result;
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.termination?.reason, "user");
  assert.equal(outcome.termination?.forced, false);
});

test("output ceiling cancels chatty processes", async () => {
  const outcome = await localProcess('process.stdout.write("x".repeat(100000)); setInterval(() => {}, 1000)', {
    maxStdoutBytes: 128,
  }).result;
  assert.equal(outcome.issue?.kind, "OutputLimit");
  assert.equal(outcome.stdoutTruncated, true);
  assert.equal(Buffer.byteLength(outcome.stdout), 128);
});

test("stderr ceiling mirrors stdout ceiling", async () => {
  const outcome = await localProcess('process.stderr.write("x".repeat(100000)); setInterval(() => {}, 1000)', {
    maxStderrBytes: 64,
  }).result;
  assert.equal(outcome.issue?.kind, "OutputLimit");
  assert.equal(outcome.stderrTruncated, true);
  assert.equal(Buffer.byteLength(outcome.stderr), 64);
  assert.equal(outcome.termination?.reason, "outputLimit");
});

test("invalid UTF-8 and oversized JSONL are protocol failures", async () => {
  const invalid = await localProcess('process.stdout.write(Buffer.from([0xff])); setInterval(() => {}, 1000)').result;
  assert.equal(invalid.issue?.kind, "ProtocolError");
  assert.equal(invalid.termination?.reason, "protocolError");
  const oversized = await localProcess('process.stdout.write("{\\"text\\":\\"123456789\\"}\\n"); setInterval(() => {}, 1000)', {
    onJsonl: () => {}, maxJsonlLineBytes: 10,
  }).result;
  assert.equal(oversized.issue?.kind, "ProtocolError");
  assert.equal(oversized.termination?.reason, "protocolError");
});

test("supervisor rejects malformed JSONL independently of process exit text", async () => {
  const outcome = await localProcess('process.stdout.write("{bad}\\n"); setInterval(() => {}, 1000)', {
    onJsonl: () => {},
  }).result;
  assert.equal(outcome.issue?.kind, "ProtocolError");
  assert.equal(outcome.termination?.reason, "protocolError");
});

test("throwing and hanging graceful hooks still force cleanup", async () => {
  for (const gracefulCancel of [
    () => { throw new Error("hook failure"); },
    () => new Promise<void>(() => {}),
  ]) {
    const run = localProcess("setInterval(() => {}, 1000)", { gracefulCancel, graceMs: 80 });
    await run.cancel("user");
    const outcome = await run.result;
    assert.equal(outcome.termination?.reason, "user");
    assert.equal(outcome.termination?.forced, true);
  }
});

test("first accepted cancellation reason wins timeout/user race", async () => {
  const firstUser = localProcess("setInterval(() => {}, 1000)", { timeoutMs: 30, graceMs: 100 });
  void firstUser.cancel("user");
  assert.equal((await firstUser.result).termination?.reason, "user");

  const firstTimeout = localProcess("setInterval(() => {}, 1000)", { timeoutMs: 30, graceMs: 200 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  void firstTimeout.cancel("user");
  assert.equal((await firstTimeout.result).termination?.reason, "timeout");
});

test("taskkill unavailable: the direct-child fallback reaps the root, and cleanup is authoritatively clean (not a false failure)", { skip: process.platform !== "win32" }, async () => {
  const fallbackSupervisor = new ProcessSupervisor(join(tmpdir(), "missing-taskkill.exe"));
  const run = fallbackSupervisor.start({
    executable: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
    cwd, env: { ...process.env }, graceMs: 50, timeoutMs: 1_000,
  });
  await run.cancel("user");
  const outcome = await run.result;
  // taskkill could not launch, so the direct SIGKILL fallback reaped the root; the owned-tree probe then PROVES the
  // root exited via the OS handle, so cleanup is clean - taskkill's unavailability is no longer a false cleanup failure.
  assert.equal(outcome.termination?.method, "directKill");
  assert.equal(outcome.termination?.cleanupError, undefined);
});

test("resolver rejects wrappers and reads version selector afresh", async () => {
  assert.throws(() => assertNativeExecutablePath("muse.cmd"));
  for (const extension of ["cmd", "bat", "ps1"]) {
    assert.throws(() => assertNativeExecutablePath(join(cwd, `muse.${extension}`)));
  }
  const directory = await mkdtemp(join(tmpdir(), "fusion-native-"));
  const versionFile = join(directory, ".version");
  const binary = join(directory, "engine-bin-1.2.exe");
  try {
    await writeFile(versionFile, "1.2\n", "utf8");
    await writeFile(binary, "fixture", "utf8");
    assert.equal(await resolveVersionedExecutable({ directory, prefix: "engine-bin-", versionFile }), binary);
    await writeFile(versionFile, "../escape", "utf8");
    await assert.rejects(resolveVersionedExecutable({ directory, prefix: "engine-bin-", versionFile }));
    await writeFile(versionFile, "x".repeat(257), "utf8");
    await assert.rejects(resolveVersionedExecutable({ directory, prefix: "engine-bin-", versionFile }),
      (error: unknown) => error instanceof InvalidProcessInputError);
    await assert.rejects(resolveVersionedExecutable({ directory, prefix: "engine-bin-", versionFile: directory }));
    await assert.rejects(resolveVersionedExecutable({ directory: ".", prefix: "engine-bin-", versionFile }));
    await writeFile(versionFile, "1.2", "utf8");
    const path = await resolveVersionedExecutable({ directory, prefix: "engine-bin-", versionFile });
    const changed = await supervisor.start({ executable: path, args: [], cwd, env: { ...process.env } }).result;
    assert.equal(changed.issue?.kind, "SpawnFailure");
    await unlink(binary);
    const vanished = await supervisor.start({ executable: path, args: [], cwd, env: { ...process.env } }).result;
    assert.equal(vanished.issue?.kind, "SpawnFailure");
    await writeFile(binary, "fixture", "utf8");
  } finally {
    await unlink(versionFile);
    await unlink(binary);
    await rmdir(directory);
  }
});

test("supervisor rejects invalid cwd, NUL paths, args and env before spawn", () => {
  const base = { executable: process.execPath, args: [] as string[], cwd, env: { ...process.env } };
  const invalid = [
    { ...base, cwd: "." },
    { ...base, cwd: join(cwd, "absent-cwd") },
    { ...base, cwd: join(cwd, "package.json") },
    { ...base, cwd: `${cwd}\0bad` },
    { ...base, executable: `${process.execPath}\0bad` },
    { ...base, args: ["bad\0arg"] },
    { ...base, env: { ...base.env, BAD: "bad\0value" } },
    { ...base, env: { ...base.env, ["BAD\0KEY"]: "value" } },
  ];
  for (const spec of invalid) {
    assert.throws(() => supervisor.start(spec),
      (error: unknown) => error instanceof InvalidProcessInputError && error.kind === "InvalidInput");
  }
});

test("Windows extended and normal paths compare equally", () => {
  assert.equal(normalizeWindowsPathForComparison("\\\\?\\D:\\Apps Backup\\fusion-cli"),
    normalizeWindowsPathForComparison("d:\\apps backup\\fusion-cli"));
  assert.equal(normalizeWindowsPathForComparison("\\\\?\\UNC\\server\\share\\repo"),
    normalizeWindowsPathForComparison("\\\\server\\share\\repo"));
});

test("Windows cancellation removes a live descendant process", { skip: process.platform !== "win32" }, async () => {
  let descendantPid = 0;
  let ready!: () => void;
  const readyPromise = new Promise<void>((resolve) => { ready = resolve; });
  const script = [
    'const {spawn} = require("node:child_process");',
    'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {stdio:"ignore"});',
    'process.stdout.write(String(child.pid) + "\\n");',
    'setInterval(() => {}, 1000);',
  ].join("");
  const run = localProcess(script, {
    onStdoutText: (text) => {
      const match = /\d+/.exec(text);
      if (match) { descendantPid = Number(match[0]); ready(); }
    },
  });
  await readyPromise;
  assert.ok(descendantPid > 0);
  await run.cancel("user");
  const outcome = await run.result;
  assert.equal(outcome.termination?.method, "taskkill");
  let alive = true;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try { process.kill(descendantPid, 0); }
    catch { alive = false; break; }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(alive, false);
});
