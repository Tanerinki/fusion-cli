import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

// The clean-dist script lives at the repository root (two levels up from dist/test at runtime).
const scriptUrl = pathToFileURL(resolve(process.cwd(), "scripts", "clean-dist.mjs")).href;
const loadCleaner = async (): Promise<{ cleanDist: (root?: string) => { removed: boolean; dist: string } }> =>
  import(scriptUrl) as Promise<{ cleanDist: (root?: string) => { removed: boolean; dist: string } }>;

async function withTempRoot(hasPackage: boolean, work: (root: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-clean-"));
  try {
    if (hasPackage) writeFileSync(join(dir, "package.json"), '{"name":"tmp"}');
    await work(dir);
  } finally {
    assert.ok(resolve(dir).toLowerCase().startsWith(`${resolve(tmpdir()).toLowerCase()}${sep}`));
    await rm(dir, { recursive: true, force: true });
  }
}

test("O5.5B4 a stale compiled artifact is removed by the clean step so npm test cannot execute it", async () => {
  const { cleanDist } = await loadCleaner();
  await withTempRoot(true, async root => {
    const testDir = join(root, "dist", "test");
    mkdirSync(testDir, { recursive: true });
    // A compiled test from another branch whose source no longer exists.
    const stale = join(testDir, "orphaned-from-another-branch.test.js");
    writeFileSync(stale, "throw new Error('stale');");
    assert.ok(existsSync(stale));
    const result = cleanDist(root);
    assert.equal(result.removed, true);
    assert.equal(existsSync(join(root, "dist")), false, "dist must be gone");
    assert.equal(existsSync(stale), false, "the stale compiled test must be gone");
    // Cleaning again when dist is absent is a no-op, not an error.
    assert.equal(cleanDist(root).removed, false);
  });
});

test("O5.5B4 clean refuses a directory that is not a package root", async () => {
  const { cleanDist } = await loadCleaner();
  await withTempRoot(false, async root => {
    mkdirSync(join(root, "dist"));
    assert.throws(() => cleanDist(root), /not a package root/u);
    assert.equal(existsSync(join(root, "dist")), true, "dist must be untouched when the root is not a package");
  });
});

test("O5.5B4 the build pipeline is wired to clean before tsc", async () => {
  const pkg = JSON.parse(await import("node:fs").then(fs => fs.readFileSync(resolve(process.cwd(), "package.json"), "utf8"))) as
    { scripts: Record<string, string> };
  assert.match(pkg.scripts.build ?? "", /clean-dist\.mjs.*&&.*tsc/u);
  assert.match(pkg.scripts.test ?? "", /npm run build/u);
});
