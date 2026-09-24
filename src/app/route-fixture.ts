import type { DelegationPacket, VerificationCommand, VerificationPlan } from "../core/domain.js";
import type { TaskRequest } from "../core/policy/task-inspector.js";

/**
 * The throw-away full-route fixture (O5.5B7 "quotes", moved here in O5.5B12 so the live rehearsal harness carries it):
 * a small TypeScript/Node project with several registry dependencies (zod, semver, ms; TypeScript and three @types
 * packages for the type check), four source and four test files, run with the pinned image's stock Node (type stripping)
 * and TypeScript's own `tsc --noEmit`. No package declares an install script, so it fits the restricted npm lane. The
 * committed baseline has one real bug and one failing test: tax is computed on the undiscounted subtotal.
 *
 * The lockfile was generated once with npm 10.9.3 (the pinned image's npm) as
 * `npm install --package-lock-only --ignore-scripts --registry=https://registry.npmjs.org/` with no user or global npmrc.
 */

export const REHEARSAL_PACKAGE_JSON = `${JSON.stringify({ name: "fusion-rehearsal-quotes", version: "1.0.0", private: true,
  type: "module", dependencies: { ms: "2.1.3", semver: "7.6.3", zod: "3.23.8" },
  devDependencies: { "@types/ms": "0.7.34", "@types/node": "22.20.1", "@types/semver": "7.5.8", typescript: "5.9.3" } }, null, 2)}\n`;

export const REHEARSAL_LOCKFILE = `${JSON.stringify({
  name: "fusion-rehearsal-quotes", version: "1.0.0", lockfileVersion: 3, requires: true,
  packages: {
    "": { name: "fusion-rehearsal-quotes", version: "1.0.0", dependencies: { ms: "2.1.3", semver: "7.6.3", zod: "3.23.8" },
      devDependencies: { "@types/ms": "0.7.34", "@types/node": "22.20.1", "@types/semver": "7.5.8", typescript: "5.9.3" } },
    "node_modules/@types/ms": { version: "0.7.34", resolved: "https://registry.npmjs.org/@types/ms/-/ms-0.7.34.tgz",
      integrity: "sha512-nG96G3Wp6acyAgJqGasjODb+acrI7KltPiRxzHPXnP3NgI28bpQDRv53olbqGXbfcgF5aiiHmO3xpwEpS5Ld9g==", dev: true, license: "MIT" },
    "node_modules/@types/node": { version: "22.20.1", resolved: "https://registry.npmjs.org/@types/node/-/node-22.20.1.tgz",
      integrity: "sha512-EANqOCF9QFyra+4pfxUcX9STKJpCLjMbObVzljIJomAWSnuSIEAvyzEU53GaajbXJEgdh0iEcPL+DGvpUd4k1Q==", dev: true, license: "MIT",
      dependencies: { "undici-types": "~6.21.0" } },
    "node_modules/@types/semver": { version: "7.5.8", resolved: "https://registry.npmjs.org/@types/semver/-/semver-7.5.8.tgz",
      integrity: "sha512-I8EUhyrgfLrcTkzV3TSsGyl1tSuPrEDzr0yd5m90UgNxQkyDXULk3b6MlQqTCpZpNtWe1K0hzclnZkTcLBe2UQ==", dev: true, license: "MIT" },
    "node_modules/ms": { version: "2.1.3", resolved: "https://registry.npmjs.org/ms/-/ms-2.1.3.tgz",
      integrity: "sha512-6FlzubTLZG3J2a/NVCAleEhjzq5oxgHyaCU9yYXvcLsvoVaHJq/s5xXI6/XXP6tz7R9xAOtHnSO/tXtF3WRTlA==", license: "MIT" },
    "node_modules/semver": { version: "7.6.3", resolved: "https://registry.npmjs.org/semver/-/semver-7.6.3.tgz",
      integrity: "sha512-oVekP1cKtI+CTDvHWYFUcMtsK/00wmAEfyqKfNdARm8u1wNVhSgaX7A8d4UuIlUI5e84iEwOhs7ZPYRmzU9U6A==", license: "ISC",
      bin: { semver: "bin/semver.js" }, engines: { node: ">=10" } },
    "node_modules/typescript": { version: "5.9.3", resolved: "https://registry.npmjs.org/typescript/-/typescript-5.9.3.tgz",
      integrity: "sha512-jl1vZzPDinLr9eUt3J/t7V6FgNEw9QjvBPdysz9KfQDD41fQrC2Y4vKQdiaUpFT4bXlb1RHhLpp8wtm6M5TgSw==", dev: true,
      license: "Apache-2.0", bin: { tsc: "bin/tsc", tsserver: "bin/tsserver" }, engines: { node: ">=14.17" } },
    "node_modules/undici-types": { version: "6.21.0", resolved: "https://registry.npmjs.org/undici-types/-/undici-types-6.21.0.tgz",
      integrity: "sha512-iwDZqg0QAGrg9Rav5H4n0M64c3mkR59cJ6wQp+7C4nI0gsmExaedaYLNO44eT4AtBBwjbTiGPMlt2Md0T9H9JQ==", dev: true, license: "MIT" },
    "node_modules/zod": { version: "3.23.8", resolved: "https://registry.npmjs.org/zod/-/zod-3.23.8.tgz",
      integrity: "sha512-XBx9AXhXktjUqnepgTiE5flcKIYWi/rme0Eaj+5Y0lftuGBq+jyRu/md4WnuxqgP1ubdpNCsYEYPxrzVHD8d6g==", license: "MIT",
      funding: { url: "https://github.com/sponsors/colinhacks" } },
  },
}, null, 2)}\n`;

const TSCONFIG = `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true,
  noEmit: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true, types: ["node"],
  skipLibCheck: true }, include: ["src/**/*.ts", "test/**/*.ts"] }, null, 2)}\n`;

const MONEY = `/** Money is integer cents; rates are basis points (1 bp = 0.01 %). */
export function formatCents(cents: number, currency = "EUR"): string {
  if (!Number.isSafeInteger(cents)) throw new RangeError("cents must be a safe integer");
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return \`\${sign}\${Math.trunc(abs / 100)}.\${String(abs % 100).padStart(2, "0")} \${currency}\`;
}

export function basisPoints(cents: number, points: number): number {
  return Math.round((cents * points) / 10_000);
}
`;

/** The baseline bug: tax is computed on the undiscounted subtotal. */
export const QUOTE_BUGGY = `import { z } from "zod";
import { basisPoints } from "./money.ts";

export const LineItem = z.object({ sku: z.string().min(1), quantity: z.number().int().positive(), unitCents: z.number().int().nonnegative() });
export const Quote = z.object({
  id: z.string().regex(/^Q-\\d{4,}$/u),
  items: z.array(LineItem).min(1),
  discountBasisPoints: z.number().int().min(0).max(10_000).default(0),
  taxBasisPoints: z.number().int().min(0).max(10_000),
});

export interface Totals { readonly subtotal: number; readonly discount: number; readonly tax: number; readonly total: number }

/** Discounts reduce the taxable amount. */
export function totals(input: unknown): Totals {
  const quote = Quote.parse(input);
  const subtotal = quote.items.reduce((sum, item) => sum + item.quantity * item.unitCents, 0);
  const discount = basisPoints(subtotal, quote.discountBasisPoints);
  const tax = basisPoints(subtotal, quote.taxBasisPoints);
  return { subtotal, discount, tax, total: subtotal - discount + tax };
}
`;
const DUE = `import ms from "ms";

/** Due date for payment terms such as "30d" or "2w". */
export function dueDate(issued: Date, terms: string): Date {
  if (!/^\\d+[dw]$/u.test(terms)) throw new RangeError("payment terms must look like 30d or 2w");
  const span = ms(terms);
  if (!(span > 0)) throw new RangeError("payment terms must be positive");
  return new Date(issued.getTime() + span);
}
`;

const VERSION = `import semver from "semver";

export const API_VERSION = "2.3.0";

/** A client range is compatible when the API version satisfies it. */
export function compatible(clientRange: string): boolean {
  return semver.validRange(clientRange) !== null && semver.satisfies(API_VERSION, clientRange);
}
`;

const MONEY_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { basisPoints, formatCents } from "../src/money.ts";

test("formats integer cents", () => {
  assert.equal(formatCents(123456), "1234.56 EUR");
  assert.equal(formatCents(-5, "USD"), "-0.05 USD");
});
test("refuses fractional cents", () => assert.throws(() => formatCents(1.5), RangeError));
test("rounds basis points", () => assert.equal(basisPoints(999, 1250), 125));
`;

/** The committed test file: the second test fails on the baseline. */
export const QUOTE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { totals } from "../src/quote.ts";

test("sums line items and taxes them", () => {
  assert.deepEqual(totals({ id: "Q-0001", items: [{ sku: "a", quantity: 2, unitCents: 500 }, { sku: "b", quantity: 1, unitCents: 250 }],
    taxBasisPoints: 2000 }), { subtotal: 1250, discount: 0, tax: 250, total: 1500 });
});
test("applies the discount before tax", () => {
  assert.deepEqual(totals({ id: "Q-0002", items: [{ sku: "a", quantity: 1, unitCents: 10000 }], discountBasisPoints: 1000,
    taxBasisPoints: 2000 }), { subtotal: 10000, discount: 1000, tax: 1800, total: 10800 });
});
test("rejects malformed quotes", () => assert.throws(() => totals({ id: "bad", items: [] })));
`;
const DUE_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { dueDate } from "../src/due.ts";

test("adds payment terms", () => {
  assert.equal(dueDate(new Date("2026-01-01T00:00:00Z"), "30d").toISOString(), "2026-01-31T00:00:00.000Z");
  assert.equal(dueDate(new Date("2026-01-01T00:00:00Z"), "2w").toISOString(), "2026-01-15T00:00:00.000Z");
});
test("refuses unknown terms", () => assert.throws(() => dueDate(new Date(0), "soon"), RangeError));
`;

const VERSION_TEST = `import { test } from "node:test";
import assert from "node:assert/strict";
import { compatible } from "../src/version.ts";

test("accepts compatible client ranges", () => { assert.equal(compatible("^2.1.0"), true); assert.equal(compatible("~2.3.0"), true); });
test("refuses incompatible or invalid ranges", () => { assert.equal(compatible("^3.0.0"), false); assert.equal(compatible("not a range"), false); });
`;

const CHANGELOG = "# Changelog\n\n## 1.0.0\n\n- Initial quote totals.\n";

/** Every committed file of the fixture repository, by repository-relative path. */
export const REHEARSAL_FILES: Readonly<Record<string, string>> = Object.freeze({
  ".gitignore": "node_modules/\n*.local\n.env\n",
  "CHANGELOG.md": CHANGELOG,
  "package.json": REHEARSAL_PACKAGE_JSON,
  "package-lock.json": REHEARSAL_LOCKFILE,
  "tsconfig.json": TSCONFIG,
  "src/money.ts": MONEY,
  "src/quote.ts": QUOTE_BUGGY,
  "src/due.ts": DUE,
  "src/version.ts": VERSION,
  "test/money.test.ts": MONEY_TEST,
  "test/quote.test.ts": QUOTE_TEST,
  "test/due.test.ts": DUE_TEST,
  "test/version.test.ts": VERSION_TEST,
});
export const REHEARSAL_TEST_FILES = Object.freeze(["test/money.test.ts", "test/quote.test.ts", "test/due.test.ts", "test/version.test.ts"]);

const NODE = "/usr/local/bin/node";
const step = (id: string, args: string[], timeoutMs = 180_000): VerificationCommand =>
  ({ id, executable: NODE, args, cwd: ".", timeoutMs, mutationPolicy: "readOnly" });
/** The confined plan: TypeScript's own type check, then the stock Node test runner (type stripping) over every test file. */
export const REHEARSAL_PLAN: VerificationPlan = Object.freeze({ commands: Object.freeze([
  step("typecheck", ["node_modules/typescript/bin/tsc", "-p", "tsconfig.json"]),
  step("unit", ["--test", ...REHEARSAL_TEST_FILES]),
]) });

const ACCEPTANCE = ["Every unit test passes.", "The TypeScript type check passes.", "A regression test covers a full discount."];
/**
 * The representative task: fix the bug and add a regression test. Two files (MEDIUM), one of them a test the
 * verification plan runs, so the existing policy requires a fresh Reviewer and Lead adjudication even at MEDIUM.
 */
export const ROUTE_TASK: TaskRequest = Object.freeze({ operation: "implement",
  summary: "Fix quote totals: tax applies to the discounted subtotal. Add a regression test.",
  paths: Object.freeze(["src/quote.ts", "test/quote.test.ts"]), scopeKnown: true, expectedMutation: "multiFile",
  requestedCapabilities: Object.freeze({ write: true }), verification: Object.freeze({ required: true, planProvided: true }) }) as TaskRequest;
export const ROUTE_PACKET: DelegationPacket = {
  task: { goal: ROUTE_TASK.summary, constraints: ["Keep the public API of src/quote.ts."], acceptanceCriteria: ACCEPTANCE },
  scope: { relevantFiles: ["src/quote.ts", "src/money.ts", "test/quote.test.ts"], allowedFiles: ["src/quote.ts", "test/quote.test.ts"],
    forbiddenFiles: ["package.json", "package-lock.json"] },
  architecture: { decisions: ["Money stays integer cents."], invariants: ["Rates are basis points.", "No new dependencies."] },
  verification: { requiredTests: ["typecheck", "unit"] }, openQuestions: [] };
