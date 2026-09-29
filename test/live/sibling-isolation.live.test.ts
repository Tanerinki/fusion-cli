import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { locateLauncher, runSandboxed } from "../../src/platform/isolation/appcontainer-backend.js";
import { candidateSandboxIdentity } from "../../src/app/provider-sandbox.js";

/**
 * OPT-IN Windows real-OS proof (§13): two candidate sandboxes run CONCURRENTLY, each with its own AppContainer identity
 * (distinct package SID) and its own granted workspace. Neither can read or write the other's workspace — sibling
 * isolation is OS-enforced under parallel execution, not merely logical. Disposable canaries only.
 *   $env:FUSION_APPCONTAINER_LIVE = '1'; npm run build; node --test dist/test/live/sibling-isolation.live.test.js
 */
const LIVE = process.env.FUSION_APPCONTAINER_LIVE === "1";

test("v0.6 LIVE sibling isolation: two concurrent candidate sandboxes cannot read or write each other's workspace", { skip: !LIVE && "set FUSION_APPCONTAINER_LIVE=1 to run" }, async () => {
  if (!LIVE) return;
  const launcher = await locateLauncher();
  assert.ok(launcher !== null, "build native/fusion-sandbox first");
  const dir = await mkdtemp(join(tmpdir(), "fusion-sib-"));
  const secretA = `A_${randomBytes(8).toString("hex")}`, secretB = `B_${randomBytes(8).toString("hex")}`;
  const win = process.env.SystemRoot ?? "C:\\Windows";
  try {
    for (const d of ["a", "b"]) await mkdir(join(dir, d), { recursive: true });
    await writeFile(join(dir, "a", "secret.txt"), secretA);
    await writeFile(join(dir, "b", "secret.txt"), secretB);
    // Unquoted paths: the launcher's argv quoting is not cmd's compound-command quoting, and %TEMP% is space-free, so an
    // unquoted path lets `type` genuinely read a GRANTED file (positive control) and get real access-denied on a denied one.
    const q = (...parts: string[]) => join(dir, ...parts);
    // Candidate A is granted only its own dir "a"; it reads its own secret (control) and tries to read/write dir "b".
    const runOne = (self: "a" | "b", other: "a" | "b") => runSandboxed(launcher!, {
      identity: candidateSandboxIdentity("r-sib", self === "a" ? "c1" : "c2"), workingDirectory: join(dir, self),
      readPaths: [join(dir, self)], writePaths: [join(dir, self)],
      executable: join(win, "System32", "cmd.exe"),
      args: ["/d", "/c", `echo SELF_${self.toUpperCase()}_OK & type ${q(self, "secret.txt")} & type ${q(other, "secret.txt")} & (echo x > ${q(other, "injected.txt")})`],
      timeoutMs: 30_000,
    });
    // Run BOTH concurrently — the isolation must hold while both are live.
    const [a, b] = await Promise.all([runOne("a", "b"), runOne("b", "a")]);
    assert.match(a.stdout, /SELF_A_OK/u); assert.match(b.stdout, /SELF_B_OK/u);
    assert.ok(a.stdout.includes(secretA), "A reads its own workspace");
    assert.ok(b.stdout.includes(secretB), "B reads its own workspace");
    assert.ok(!a.stdout.includes(secretB) && !a.stderr.includes(secretB), "A cannot read B's secret");
    assert.ok(!b.stdout.includes(secretA) && !b.stderr.includes(secretA), "B cannot read A's secret");
    assert.ok(!existsSync(join(dir, "b", "injected.txt")), "A cannot write into B's workspace");
    assert.ok(!existsSync(join(dir, "a", "injected.txt")), "B cannot write into A's workspace");
    assert.equal(await readFile(join(dir, "a", "secret.txt"), "utf8"), secretA);
    assert.equal(await readFile(join(dir, "b", "secret.txt"), "utf8"), secretB);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
