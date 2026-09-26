import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FUSION_VERSION } from "../src/platform/events/shared.js";

/**
 * v0.1 Block 6 — packaging invariants, deterministic (the full install smoke is `npm run smoke:pack`): the package can
 * never be published by accident, ships only the compiled CLI, its entry point is executable through a shebang, the
 * reported version is the package version, and production code carries no developer-machine path.
 */
const REPO = fileURLToPath(new URL("../../", import.meta.url));

async function sources(directory: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await sources(path)); else if (entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("v0.1 packaging: private, the compiled CLI only, a shebang entry point, one version, no developer paths in production code", async () => {
  const pkg = JSON.parse(await readFile(join(REPO, "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(pkg.private, true, "never published by accident");
  assert.deepEqual(pkg.bin, { fusion: "dist/src/cli/main.js" });
  assert.deepEqual(pkg.files, ["dist/src/", "README.md", "SECURITY.md", "CHANGELOG.md"]);
  assert.equal(pkg.dependencies, undefined, "no runtime dependencies: installing needs no registry");
  assert.equal((pkg.scripts as Record<string, string>).prepack, "npm run build");
  assert.equal(pkg.version, FUSION_VERSION);
  assert.match(String((pkg.engines as Record<string, string>).node), /^>=22/u);
  assert.ok((await readFile(join(REPO, "src", "cli", "main.ts"), "utf8")).startsWith("#!/usr/bin/env node\n"));
  for (const file of await sources(join(REPO, "src"))) {
    const text = await readFile(file, "utf8");
    // (Container paths such as /home/node inside the verification image are legitimate; developer-machine paths are not.)
    assert.doesNotMatch(text, /[A-Za-z]:\\\\?(Users|apps backup)\\|apps backup|fusion-cli[\\/]src/u, file);
  }
});
