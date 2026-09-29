import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

/**
 * v0.5 — THE INVARIANT MATRIX STAYS TRUE: every test title it quotes exists verbatim in the v0.5 test files, and no invariant
 * is MISSING. A renamed or deleted test fails here instead of leaving a claim of coverage behind.
 */
test("v0.5 invariant matrix: every quoted test title exists, and no invariant is MISSING", async () => {
  const dir = join(process.cwd(), "test");
  const titles = new Set<string>();
  for (const name of (await readdir(dir)).filter(n => /^v05-.*\.test\.ts$/u.test(n)))
    for (const match of (await readFile(join(dir, name), "utf8")).matchAll(/^test\("([^"]+)"/gmu)) titles.add(match[1]!);
  const matrix = await readFile(join(process.cwd(), "docs", "v0.5-invariant-matrix.md"), "utf8");
  const quoted = [...matrix.matchAll(/"(v0\.5 [^"]+)"/gu)].map(m => m[1]!);
  assert.ok(quoted.length >= 70, `the matrix quotes its tests (${quoted.length})`);
  assert.deepEqual(quoted.filter(title => !titles.has(title)), [], "every quoted title is a real test");
  const rows = matrix.split("\n").filter(line => line.startsWith("| ") && !line.startsWith("| ---"));
  assert.deepEqual(rows.filter(row => /\|\s*(MISSING|PARTIAL)\b/u.test(row)), [], "nothing is MISSING or PARTIAL");
});
