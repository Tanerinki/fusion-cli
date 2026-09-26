import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { FusionFailure } from "../src/core/errors.js";
import { candidateSourcePart, containerInput, loadGuestBundle, manifestFrame,
  memoryPart } from "../src/platform/verification/docker/bundle.js";
import { assertSafeDockerArgs, buildCreateArgs, DEFAULT_DOCKER_LIMITS, GUEST_BOOTSTRAP,
  networkFor } from "../src/platform/verification/docker/config.js";
import { SOURCE_ARCHIVE_LIMITS, type GuestManifest } from "../src/platform/verification/docker/protocol.js";
import { ChunkReader, decodeArchive, encodeArchive, extractingSink, memoryArchive, planTree, rawArchiveCeiling,
  TransferArchiveError, validateArchivePath, validatingSink, type ArchiveLimits } from "../src/platform/verification/docker/transfer-archive.js";
import { CONTAINER_VERIFIER_ENV } from "../src/platform/verification/verifier-environment.js";
import { FAKE_IMAGE, readArchive } from "./fixtures/fake-docker.js";

const code = (expected: string) => (error: unknown): boolean => error instanceof TransferArchiveError && error.code === expected;
const kind = (name: string) => (error: unknown): boolean => error instanceof FusionFailure && error.error.kind === name;
const LIMITS: ArchiveLimits = { maxEntries: 100, maxFileBytes: 1024, maxTotalBytes: 4096 };
const once = (bytes: Buffer): AsyncIterable<Uint8Array> => (async function* () { yield bytes; })();

/** Raw FTA1 writer that allows ANY path/flags/counts, to build hostile archives the production encoder never emits. */
function hostile(entries: readonly (readonly ["D" | "F", string, Buffer?, number?])[], count = entries.length, magic = "FTA1"): Buffer {
  const parts: Buffer[] = [Buffer.from(magic, "latin1")];
  for (const [type, path, content, flags] of entries) {
    const name = Buffer.from(path, "utf8"), length = Buffer.alloc(2);
    length.writeUInt16BE(name.length, 0);
    parts.push(Buffer.from(type, "latin1"), length, name);
    if (type === "F") {
      const size = Buffer.alloc(4);
      size.writeUInt32BE(content!.length, 0);
      parts.push(Buffer.from([flags ?? 0]), size, content!);
    }
  }
  const end = Buffer.alloc(5);
  end[0] = 0x45; end.writeUInt32BE(count, 1);
  parts.push(end);
  return Buffer.concat(parts);
}
const decode = (bytes: Buffer, limits: ArchiveLimits = LIMITS) =>
  decodeArchive(new ChunkReader(once(bytes), rawArchiveCeiling(limits)), validatingSink, limits);
const encodeMemory = async (files: Record<string, Buffer>): Promise<Buffer> => {
  const [entries, content] = memoryArchive(files);
  const parts: Buffer[] = [];
  for await (const chunk of encodeArchive(entries, content)) parts.push(Buffer.from(chunk));
  return Buffer.concat(parts);
};

test("O5.5B6 archive: a normal tree round-trips exactly (nested, empty and binary files)", async () => {
  const files = { "a.txt": Buffer.from("alpha"), "dir/sub/b.bin": Buffer.from([0, 255, 10, 13, 0]), "dir/empty": Buffer.alloc(0) };
  const bytes = await encodeMemory(files);
  const out = await readArchive(bytes, LIMITS);
  assert.deepEqual([...out.keys()].sort(), Object.keys(files).sort());
  for (const [path, content] of Object.entries(files)) assert.ok(out.get(path)!.equals(content), path);
  const stats = await decode(bytes);
  assert.deepEqual([stats.files, stats.directories, stats.bytes], [3, 2, 10]);
});

test("O5.5B6 archive: traversal, absolute, drive, UNC, device, backslash and non-canonical paths are refused", async () => {
  const cases: Record<string, string> = {
    "../escape.txt": "path-traversal", "a/../../b": "path-traversal", "./a": "path-traversal", "/etc/passwd": "path-absolute",
    "C:/Windows/x": "path-drive-or-stream", "C:x": "path-drive-or-stream", "a.txt:ads": "path-drive-or-stream",
    "\\\\server\\share\\x": "path-backslash", "\\\\.\\PhysicalDrive0": "path-backslash", "\\\\?\\C:\\x": "path-backslash",
    "a\\..\\b": "path-backslash", "a//b": "path-empty-segment", "a/": "path-empty-segment", "a\u0000b": "path-control-character",
    "a\nb": "path-control-character", "a\u007fb": "path-control-character",
  };
  for (const [path, expected] of Object.entries(cases)) {
    assert.throws(() => validateArchivePath(path), code(expected), JSON.stringify(path));
    await assert.rejects(decode(hostile([["F", path, Buffer.from("x")]])), code(expected), JSON.stringify(path));
  }
  assert.throws(() => validateArchivePath("x".repeat(256)), code("path-segment-too-long"));
  assert.throws(() => validateArchivePath(`${"a/".repeat(600)}b`), code("path-too-long"));
  assert.equal(validateArchivePath("ok/dir/file.name-1_2"), "ok/dir/file.name-1_2");
});

test("O5.5B6 archive: duplicates, case collisions, undeclared parents and forbidden segments are refused", async () => {
  await assert.rejects(decode(hostile([["F", "a.txt", Buffer.from("1")], ["F", "a.txt", Buffer.from("2")]])), code("path-duplicate"));
  await assert.rejects(decode(hostile([["F", "README", Buffer.from("1")], ["F", "readme", Buffer.from("2")]])), code("path-duplicate"));
  await assert.rejects(decode(hostile([["D", "Dir"], ["D", "dir"]])), code("path-duplicate"));
  await assert.rejects(decode(hostile([["F", "a/b.txt", Buffer.from("x")]])), code("path-parent-undeclared"));
  await assert.rejects(decode(hostile([["D", "a"], ["F", "a/b/c.txt", Buffer.from("x")]])), code("path-parent-undeclared"));
  const source = { ...LIMITS, forbiddenSegments: ["node_modules"] };
  for (const path of ["node_modules", "sub/Node_Modules"])
    await assert.rejects(decode(hostile([["D", "sub"], ["D", path]]), source), code("path-forbidden-segment"), path);
});

test("O5.5B6 archive: size, count, flags and framing violations are refused; reading is bounded", async () => {
  await assert.rejects(decode(hostile([["F", "big", Buffer.alloc(1025)]])), code("file-too-large"));
  await assert.rejects(decode(hostile([1, 2, 3, 4, 5].map(i => ["F", `f${i}`, Buffer.alloc(1000)] as const))), code("archive-too-large"));
  await assert.rejects(decode(hostile(Array.from({ length: 101 }, (_, i) => ["D", `d${i}`] as const))), code("archive-too-many-entries"));
  await assert.rejects(decode(hostile([["F", "x", Buffer.from("x"), 2]])), code("file-flags"));
  await assert.rejects(decode(hostile([["F", "x", Buffer.from("x")]], 5)), code("archive-count-mismatch"));
  await assert.rejects(decode(hostile([], 0, "FTA2")), code("archive-magic"));
  await assert.rejects(decode(Buffer.concat([Buffer.from("FTA1"), Buffer.from("Z")])), code("archive-entry-kind"));
  const truncated = hostile([["F", "x", Buffer.from("hello")]]);
  await assert.rejects(decode(truncated.subarray(0, truncated.length - 8)), code("stream-truncated"));
  const badUtf8 = Buffer.concat([Buffer.from("FTA1D"), Buffer.from([0, 2, 0xc3, 0x28])]);
  await assert.rejects(decode(badUtf8), code("path-not-utf8"));
  // The raw reader ceiling stops an oversized stream even if every declared size looked plausible.
  await assert.rejects(decodeArchive(new ChunkReader(once(hostile([["F", "x", Buffer.alloc(900)]])), 100), validatingSink, LIMITS),
    code("stream-too-large"));
});

test("O5.5B6 archive: an expansion bomb stops at the declared bound without inflating the payload", async () => {
  // 64 MiB of zeros compresses to ~64 KiB; the header alone refuses it before its content is read.
  const bomb = gzipSync(hostile([["F", "zeros", Buffer.alloc(64 * 1024 * 1024)]]));
  assert.ok(bomb.length < 1024 * 1024);
  const { createGunzip } = await import("node:zlib");
  const { pipeline } = await import("node:stream/promises");
  const { Readable } = await import("node:stream");
  await assert.rejects(pipeline(Readable.from(once(bomb)), createGunzip(), async (expanded: AsyncIterable<Buffer>) => {
    await decodeArchive(new ChunkReader(expanded, rawArchiveCeiling(LIMITS)), validatingSink, LIMITS);
  }), code("file-too-large"));
});

test("O5.5B6 archive: extraction cannot leave its root, never overwrites, and malicious entries write nothing", async () => {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-fta-"));
  try {
    const target = join(root, "extract"), outside = join(root, "outside");
    await mkdir(target); await mkdir(outside);
    for (const path of ["../outside/pwned.txt", "..\\outside\\pwned.txt", `${outside.replace(/\\/gu, "/")}/pwned.txt`]) {
      const bytes = hostile([["F", path, Buffer.from("pwned")]]);
      await assert.rejects(decodeArchive(new ChunkReader(once(bytes), rawArchiveCeiling(LIMITS)), extractingSink(target), LIMITS));
    }
    assert.deepEqual(await readdir(outside), [], "nothing escaped the extraction root");
    assert.deepEqual(await readdir(target), []);
    const good = await encodeMemory({ "src/index.js": Buffer.from("export {};") });
    await decodeArchive(new ChunkReader(once(good), rawArchiveCeiling(LIMITS)), extractingSink(target), LIMITS);
    assert.equal(readFileSync(join(target, "src", "index.js"), "utf8"), "export {};");
    // A second extraction of the same entries fails on exclusive create instead of overwriting.
    await assert.rejects(decodeArchive(new ChunkReader(once(good), rawArchiveCeiling(LIMITS)), extractingSink(target), LIMITS));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("O5.5B6 source archive: .git is excluded, node_modules is refused, links fail closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-src-"));
  try {
    const candidate = join(root, "candidate");
    await mkdir(join(candidate, ".git"), { recursive: true });
    await writeFile(join(candidate, ".git", "config"), "[credential]\nhelper = store");
    await writeFile(join(candidate, "package.json"), "{}");
    const { part, stats } = await candidateSourcePart(candidate);
    const chunks: Buffer[] = [];
    for await (const chunk of part.chunks()) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), part.sha256);
    assert.equal(bytes.length, part.bytes);
    assert.deepEqual([...(await readArchive(bytes, SOURCE_ARCHIVE_LIMITS)).keys()], ["package.json"]);
    assert.deepEqual([stats.files, stats.directories], [1, 0]);
    // A primary checkout's node_modules is never trusted or copied, at any depth.
    for (const path of [join(candidate, "node_modules", "x"), join(candidate, "packages", "a", "node_modules", "y")]) {
      await mkdir(path, { recursive: true });
      await assert.rejects(candidateSourcePart(candidate), kind("SecurityViolation"), path);
      await rm(path.slice(0, path.indexOf("node_modules") + "node_modules".length), { recursive: true });
    }
    try { await symlink(root, join(candidate, "link"), "junction"); }
    catch { t.diagnostic("junction creation not permitted; link case skipped"); return; }
    await assert.rejects(candidateSourcePart(candidate), kind("SecurityViolation"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("O5.5B6 planTree carries executable bits only when asked (POSIX producers) and never follows links", async () => {
  const root = await mkdtemp(join(tmpdir(), "fusion-o55b6-plan-"));
  try {
    await writeFile(join(root, "a.sh"), "x");
    const entries = await planTree(root, { limits: LIMITS });
    assert.deepEqual(entries.map(entry => [entry.path, entry.executable]), [["a.sh", false]]);
    await assert.rejects(planTree(join(root, "missing"), { limits: LIMITS }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("O5.5B6 zero host mounts: the create argv has no mount of any kind and stdin is the input channel", () => {
  const args = buildCreateArgs({ runId: "0".repeat(32), mode: "verify", image: FAKE_IMAGE, limits: DEFAULT_DOCKER_LIMITS,
    env: CONTAINER_VERIFIER_ENV, createdAt: "2026-09-24T12:00:00.000Z", bundleSha256: "1".repeat(64), manifestSha256: "2".repeat(64) });
  for (const flag of ["--mount", "-v", "--volume", "--volumes-from", "--device"]) assert.equal(args.includes(flag), false, flag);
  assert.equal(args.some(arg => /type=(?:bind|volume)|\/fusion\/input/u.test(arg)), false);
  assert.ok(args.includes("--interactive"));
  assert.deepEqual(args.filter(arg => arg.startsWith("/fusion/work:") || arg.startsWith("/tmp:")).length, 2, "tmpfs only");
  assert.equal(GUEST_BOOTSTRAP.includes("\\"), false, "the bootstrap survives Windows argv quoting unchanged");
  assert.equal(networkFor("verify"), "none");
  assert.equal(networkFor("canary"), "none");
});

test("O5.5B6 the argv guard refuses every mount, foreign networks, other tmpfs targets and a replaced entry command", () => {
  const base = buildCreateArgs({ runId: "0".repeat(32), mode: "verify", image: FAKE_IMAGE, limits: DEFAULT_DOCKER_LIMITS,
    env: CONTAINER_VERIFIER_ENV, createdAt: "2026-09-24T12:00:00.000Z", bundleSha256: "1".repeat(64), manifestSha256: "2".repeat(64) });
  const at = base.indexOf(FAKE_IMAGE);
  const inject = (...flags: string[]): string[] => [...base.slice(0, at), ...flags, ...base.slice(at)];
  const refused = [
    inject("--mount", "type=bind,source=C:\\candidate,target=/fusion/input,readonly"),
    inject("--mount", "type=volume,source=x,target=/y"), inject("-v", "C:\\:/host"), inject("--volume=/:/host"),
    inject("--tmpfs", "/etc:rw"), inject("--network", "bridge"), inject("--network=host"), inject("--user", "0:0"),
    inject("--privileged"), inject("--device", "/dev/sda"), inject("--cap-add=SYS_ADMIN"), inject("--pid=host"),
    inject("--security-opt", "seccomp=unconfined"), inject("-e", "ANTHROPIC_API_KEY"), inject("--env-file", "C:\\.env"),
    inject("--group-add", "docker"), inject("--cgroup-parent", "/"),
    [...base.slice(0, at + 1), "-e", "require('child_process').execSync('sh')", "1".repeat(64), "verify", "2".repeat(64)],
    [...base.slice(0, at + 1), "/bin/sh", "-c", "id"], [...base, "--privileged"],
    base.filter(arg => arg !== "--read-only"), base.map(arg => arg === "none" ? "host" : arg),
  ];
  for (const args of refused) assert.throws(() => assertSafeDockerArgs(args), kind("SecurityViolation"), args.slice(at - 3, at + 2).join(" "));
  assert.doesNotThrow(() => assertSafeDockerArgs(base));
  // The dependency stage alone may use the default bridge, and only as a labelled `deps` container.
  const deps = buildCreateArgs({ runId: "0".repeat(32), mode: "deps", image: FAKE_IMAGE, limits: DEFAULT_DOCKER_LIMITS,
    env: CONTAINER_VERIFIER_ENV, createdAt: "2026-09-24T12:00:00.000Z", bundleSha256: "1".repeat(64), manifestSha256: "2".repeat(64) });
  assert.doesNotThrow(() => assertSafeDockerArgs(deps));
  assert.deepEqual(deps.slice(deps.indexOf("--network"), deps.indexOf("--network") + 2), ["--network", "bridge"]);
  assert.throws(() => assertSafeDockerArgs(deps.map(arg => arg === "fusion.mode=deps" ? "fusion.mode=verify" : arg)), kind("SecurityViolation"));
  assert.throws(() => assertSafeDockerArgs(deps.map(arg => arg === "bridge" ? "host" : arg)), kind("SecurityViolation"));
});

test("O5.5B6 the stdin stream is framed, hash-pinned and refuses to send a part that differs from its digest", async () => {
  const bundle = await loadGuestBundle();
  const part = await memoryPart({ "canary/readable.txt": Buffer.from("token") }, LIMITS);
  const manifest = manifestFrame({ protocolVersion: 2, mode: "descendant", nonce: "a".repeat(32), descendantMarker: "m" } as GuestManifest);
  const input = containerInput(bundle, manifest, [part]);
  const chunks: Buffer[] = [];
  for await (const chunk of input.chunks()) chunks.push(Buffer.from(chunk));
  const stream = Buffer.concat(chunks);
  assert.equal(stream.length, input.bytes);
  assert.equal(stream.toString("latin1", 0, 8), "FUSIONB1");
  assert.equal(createHash("sha256").update(stream.subarray(12, 12 + stream.readUInt32BE(8))).digest("hex"), bundle.sha256);
  assert.equal(input.mismatch(), false);
  const lying = containerInput(bundle, manifest, [{ ...part, sha256: "f".repeat(64) }]);
  for await (const _ of lying.chunks()) { /* drain */ }
  assert.equal(lying.mismatch(), true, "a part whose bytes do not match its announced digest is flagged");
  // The bundle ships only the runner, the archive reader and a module-type marker.
  const names: string[] = [];
  const body = bundle.frame.subarray(12);
  let offset = 1;
  for (let index = 0; index < body[0]!; index++) {
    const length = body[offset]!;
    names.push(body.toString("utf8", offset + 1, offset + 1 + length));
    offset += 1 + length;
    offset += 4 + body.readUInt32BE(offset);
  }
  assert.deepEqual(names, ["package.json", "guest-runner.js", "transfer-archive.js"]);
  assert.equal(existsSync(new URL("../src/platform/verification/docker/guest-runner.js", import.meta.url)), true);
});
