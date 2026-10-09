import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const pocDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "tools", "hyperv-poc");
const buildPs = readFileSync(join(pocDir, "build-worker-image.ps1"), "utf8");

/** The basenames the Dockerfile COPYs into the worker image (C:/fusion/<name>). */
function packagedFiles(): string[] {
  return [...buildPs.matchAll(/"COPY\s+(\S+)\s+C:\/fusion\/\S+"/gu)].map(m => m[1]!);
}
/** The basenames the PS copy-list stages into the build context. */
function copiedFiles(): string[] {
  const loop = /foreach \(\$g in ([^)]+)\)/u.exec(buildPs)?.[1] ?? "";
  const list = [...loop.matchAll(/'([^']+)'/gu)].map(m => m[1]!);
  list.push("fake-provider.mjs", "node.exe"); // staged by their own Copy-Item lines
  return list;
}
/** Source path on disk for a packaged basename (fake-provider.mjs lives in the fake-provider/ subdir). */
function sourceOf(name: string): string {
  return name === "fake-provider.mjs" ? join(pocDir, "fake-provider", "fake-provider.mjs") : join(pocDir, name);
}
/** Local relative `.mjs` imports (static + dynamic) of a guest module. */
function relativeImports(src: string): string[] {
  const text = readFileSync(src, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/\bfrom\s+["']\.\/([A-Za-z0-9_.-]+\.mjs)["']/gu)) out.push(m[1]!);
  for (const m of text.matchAll(/\bimport\(\s*["']\.\/([A-Za-z0-9_.-]+\.mjs)["']/gu)) out.push(m[1]!);
  return out;
}

test("v0.6 Hyper-V image: the PS copy-list and the Dockerfile COPY set agree (no file staged-but-not-COPYed or vice versa)", () => {
  const copied = new Set(copiedFiles());
  const packaged = new Set(packagedFiles());
  for (const f of packaged) assert.ok(copied.has(f), `Dockerfile COPYs ${f} but it is not staged into the build context`);
  for (const f of copied) assert.ok(packaged.has(f) || f === "node.exe", `${f} is staged but never COPYed into the image`);
});

test("v0.6 Hyper-V image: every local ./*.mjs import of a packaged guest module is itself packaged (no ERR_MODULE_NOT_FOUND)", () => {
  const packaged = new Set(packagedFiles().filter(f => f.endsWith(".mjs")));
  const missing: string[] = [];
  for (const f of packaged) for (const dep of relativeImports(sourceOf(f))) if (!packaged.has(dep)) missing.push(`${f} -> ./${dep}`);
  assert.deepEqual(missing, [], `guest modules import files that are NOT packaged into the worker image:\n${missing.join("\n")}`);
});

test("v0.6 Hyper-V image: the specific required guest import edges are packaged (pipegate3 regression)", () => {
  const packaged = new Set(packagedFiles());
  assert.ok(packaged.has("raw-tuple.mjs"), "raw-tuple.mjs must be COPYed (pipe-canary imports it)");
  assert.ok(relativeImports(sourceOf("pipe-canary.mjs")).includes("pipe-protocol.mjs") && packaged.has("pipe-protocol.mjs"), "pipe-canary -> ./pipe-protocol.mjs packaged");
  assert.ok(relativeImports(sourceOf("pipe-canary.mjs")).includes("raw-tuple.mjs") && packaged.has("raw-tuple.mjs"), "pipe-canary -> ./raw-tuple.mjs packaged");
  assert.ok(relativeImports(sourceOf("guest-shim.mjs")).includes("pipe-protocol.mjs") && packaged.has("pipe-protocol.mjs"), "guest-shim -> ./pipe-protocol.mjs packaged");
});
