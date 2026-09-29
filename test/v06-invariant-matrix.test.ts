import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

/**
 * v0.6 — THE INVARIANT MATRIX STAYS HONEST: every test title the matrix quotes on a COVERED/OS-COVERED row exists
 * verbatim in a v0.6 test file. A renamed or deleted test fails here instead of leaving a false claim of coverage. Rows
 * still marked PLANNED are not yet built and quote no test; that is allowed while v0.6 is in progress.
 */
test("v0.6 invariant matrix: every COVERED row quotes a real test", async () => {
  const titles = new Set<string>();
  const scan = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir).catch(() => [] as string[])).filter(n => /\.test\.ts$/u.test(n)))
      for (const m of (await readFile(join(dir, name), "utf8")).matchAll(/^test\("([^"]+)"/gmu)) titles.add(m[1]!);
  };
  await scan(join(process.cwd(), "test"));
  await scan(join(process.cwd(), "test", "live"));
  const matrix = await readFile(join(process.cwd(), "docs", "v0.6-invariant-matrix.md"), "utf8");
  const covered = matrix.split("\n").filter(line => /\|\s*(COVERED|OS-COVERED)\s*\|?\s*$/u.test(line));
  assert.ok(covered.length >= 15, `the matrix has COVERED rows (${covered.length})`);
  const missing: string[] = [];
  for (const row of covered) {
    // The quoted test title is the last "..." in the row (after → or after "live:").
    const quoted = [...row.matchAll(/"([^"]+)"/gu)].map(m => m[1]!);
    if (quoted.length === 0) { missing.push(`row without a quoted test: ${row.trim().slice(0, 60)}`); continue; }
    const title = quoted[quoted.length - 1]!;
    if (!titles.has(title)) missing.push(title);
  }
  assert.deepEqual(missing, [], "every COVERED row quotes a test that exists");
});
