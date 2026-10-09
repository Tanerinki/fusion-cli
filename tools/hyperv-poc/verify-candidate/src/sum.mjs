// Untrusted "writer output" candidate module under verification. The approved verifier checks sum() is correct.
export function sum(xs) { return xs.reduce((a, b) => a + b, 0); }
