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
  const dir = join(process.cwd(), "test");
  const titles = new Set<string>();
  for (const name of (await readdir(dir)).filter(n => /^v06-.*\.test\.ts$/u.test(n)))
    for (const m of (await readFile(join(dir, name), "utf8")).matchAll(/^test\("([^"]+)"/gmu)) titles.add(m[1]!);
  const matrix = await readFile(join(process.cwd(), "docs", "v0.6-invariant-matrix.md"), "utf8");
  const covered = matrix.split("\n").filter(line => /\|\s*(COVERED|OS-COVERED)\s*\|?\s*$/u.test(line));
  assert.ok(covered.length >= 12, `the matrix has COVERED rows (${covered.length})`);
  const missing: string[] = [];
  for (const row of covered) {
    const quoted = row.match(/→\s*"([^"]+)"/u);
    if (quoted === null) { missing.push(`row without a quoted test: ${row.trim().slice(0, 60)}`); continue; }
    if (!titles.has(quoted[1]!)) missing.push(quoted[1]!);
  }
  assert.deepEqual(missing, [], "every COVERED row quotes a test that exists");
});
