import { QUOTE_BUGGY, QUOTE_TEST } from "../../src/app/route-fixture.js";

/**
 * The O5.5B7 "quotes" rehearsal project. Its committed files, confined plan, task and packet live in
 * src/app/route-fixture.ts (the O5.5B12 live rehearsal harness carries them); this test fixture keeps what only tests
 * need: a correct and a plausible-but-wrong fix, the Worker's regression test, and the fake dependency tree.
 */
export { QUOTE_BUGGY, QUOTE_TEST, REHEARSAL_FILES, REHEARSAL_LOCKFILE, REHEARSAL_PACKAGE_JSON, REHEARSAL_PLAN,
  REHEARSAL_TEST_FILES } from "../../src/app/route-fixture.js";

/** The correct fix a Worker proposes. */
export const QUOTE_FIXED = QUOTE_BUGGY.replace("const tax = basisPoints(subtotal, quote.taxBasisPoints);",
  "const tax = basisPoints(subtotal - discount, quote.taxBasisPoints);");
/** A plausible but wrong "fix" (it drops the discount from the total instead of the taxable amount): tests still fail. */
export const QUOTE_WRONG = QUOTE_BUGGY.replace("return { subtotal, discount, tax, total: subtotal - discount + tax };",
  "return { subtotal, discount, tax, total: subtotal + tax };");

/** The Worker's regression test, appended in the same ChangeSet. */
export const QUOTE_TEST_WITH_REGRESSION = `${QUOTE_TEST}test("a full discount leaves nothing to tax", () => {
  assert.deepEqual(totals({ id: "Q-0003", items: [{ sku: "a", quantity: 3, unitCents: 700 }], discountBasisPoints: 10000,
    taxBasisPoints: 2000 }), { subtotal: 2100, discount: 2100, tax: 0, total: 0 });
});
`;

/** The eight packages of the lockfile, as a tiny stand-in tree for the in-memory Docker fake (the real lane installs them). */
export const FAKE_DEPENDENCY_TREE: Readonly<Record<string, Buffer>> = Object.freeze(Object.fromEntries(
  ["zod", "semver", "ms", "typescript", "@types/node", "@types/ms", "@types/semver", "undici-types"].flatMap(name => [
    [`${name}/package.json`, Buffer.from(JSON.stringify({ name, version: "0.0.0-fake" }))],
    [`${name}/index.js`, Buffer.from("module.exports = {};\n")]])));
