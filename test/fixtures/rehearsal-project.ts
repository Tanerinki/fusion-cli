import { QUOTE_BUGGY } from "../../src/app/route-fixture.js";

/**
 * The O5.5B7 "quotes" rehearsal project. Its committed files, confined plan, task and packet live in
 * src/app/route-fixture.ts (the O5.5B12 live rehearsal harness carries them), and since O5.5B23 so do the correct fix and
 * the regression test (the Reviewer-only probe's Fusion-authored candidate). This test fixture keeps what only tests
 * need: a plausible-but-wrong fix and the fake dependency tree.
 */
export { QUOTE_BUGGY, QUOTE_FIXED, QUOTE_TEST, QUOTE_TEST_WITH_REGRESSION, REHEARSAL_FILES, REHEARSAL_LOCKFILE, REHEARSAL_PACKAGE_JSON,
  REHEARSAL_PLAN, REHEARSAL_TEST_FILES } from "../../src/app/route-fixture.js";

/** A plausible but wrong "fix" (it drops the discount from the total instead of the taxable amount): tests still fail. */
export const QUOTE_WRONG = QUOTE_BUGGY.replace("return { subtotal, discount, tax, total: subtotal - discount + tax };",
  "return { subtotal, discount, tax, total: subtotal + tax };");

/** The eight packages of the lockfile, as a tiny stand-in tree for the in-memory Docker fake (the real lane installs them). */
export const FAKE_DEPENDENCY_TREE: Readonly<Record<string, Buffer>> = Object.freeze(Object.fromEntries(
  ["zod", "semver", "ms", "typescript", "@types/node", "@types/ms", "@types/semver", "undici-types"].flatMap(name => [
    [`${name}/package.json`, Buffer.from(JSON.stringify({ name, version: "0.0.0-fake" }))],
    [`${name}/index.js`, Buffer.from("module.exports = {};\n")]])));
