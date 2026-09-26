/**
 * A tiny, real npm project (generated once with npm 10.9.3 `install --package-lock-only --ignore-scripts` inside the
 * pinned image): two registry packages with a nested dependency (`is-odd` → `is-number@6` under its own node_modules).
 * No package declares an install script. Used by deterministic tests and by the opt-in live dependency-lane test.
 */
export const FIXTURE_PACKAGE_JSON = `${JSON.stringify({ name: "fusion-deps-fixture", version: "0.0.0", private: true, type: "module",
  dependencies: { "is-number": "7.0.0", "is-odd": "3.0.1" } }, null, 2)}\n`;

export const FIXTURE_LOCKFILE = `${JSON.stringify({
  name: "fusion-deps-fixture", version: "0.0.0", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "fusion-deps-fixture", version: "0.0.0", dependencies: { "is-number": "7.0.0", "is-odd": "3.0.1" } },
    "node_modules/is-number": { version: "7.0.0", resolved: "https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz",
      integrity: "sha512-41Cifkg6e8TylSpdtTpeLVMqvSBEVzTttHvERD741+pnZ8ANv0004MRL43QKPDlK9cGvNp6NZWZUBlbGXYxxng==", license: "MIT",
      engines: { node: ">=0.12.0" } },
    "node_modules/is-odd": { version: "3.0.1", resolved: "https://registry.npmjs.org/is-odd/-/is-odd-3.0.1.tgz",
      integrity: "sha512-CQpnWPrDwmP1+SMHXZhtLtJv90yiyVfluGsX5iNCVkrhQtU3TQHsUWPG9wkdk9Lgd5yNpAg9jQEo90CBaXgWMA==", license: "MIT",
      dependencies: { "is-number": "^6.0.0" }, engines: { node: ">=4" } },
    "node_modules/is-odd/node_modules/is-number": { version: "6.0.0",
      resolved: "https://registry.npmjs.org/is-number/-/is-number-6.0.0.tgz",
      integrity: "sha512-Wu1VHeILBK8KAWJUAiSZQX94GmOE45Rg6/538fKwiloUu21KncEkYGPqob2oSZ5mUT73vLGrHQjKw3KMPwfDzg==", license: "MIT",
      engines: { node: ">=0.10.0" } },
  },
}, null, 2)}\n`;

/** A test file that needs both dependencies (run with stock `node --test`). */
export const FIXTURE_DEPENDENCY_TEST = [
  'import { test } from "node:test";',
  'import assert from "node:assert/strict";',
  'import isOdd from "is-odd";',
  'import isNumber from "is-number";',
  'test("dependencies resolve from the prepared artifact", () => { assert.equal(isOdd(3), true); assert.equal(isNumber(5), true); });',
].join("\n");
