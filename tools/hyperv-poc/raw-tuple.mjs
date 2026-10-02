// Fusion v0.6 Hyper-V PoC - the raw-socket canary TUPLE CONTRACT (pure, unit-tested). The producer (pipe-poc.ps1) emits
// tuples as [host, port, key]; the consumer (pipe-canary.mjs) MUST read them in that exact order. This module is the one
// place that defines + validates the contract, so producer/consumer can never drift again and no invalid (string/out-of-
// range) port can ever reach net.connect.

/** True only for an integer TCP port in 1..65535 (a numeric string like "443" is accepted and coerced). */
export function isValidPort(port) {
  const n = typeof port === "number" ? port : (/^\d{1,5}$/u.test(String(port)) ? Number(port) : NaN);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/**
 * Parses a raw-socket canary tuple [host, port, key] into { host, port, key }. Throws a TypeError (FAIL CLOSED) on a
 * malformed tuple (wrong arity, empty host/key, or an invalid/out-of-range port) so a bad spec becomes a harness error -
 * recorded as an error outcome, never a misleading DENIED/PASS security verdict.
 */
export function parseRawTcpTuple(tuple) {
  if (!Array.isArray(tuple) || tuple.length !== 3) throw new TypeError(`raw tcp tuple must be [host, port, key], got ${JSON.stringify(tuple)}`);
  const [host, port, key] = tuple;
  if (typeof host !== "string" || host.length === 0) throw new TypeError(`raw tcp tuple host must be a non-empty string, got ${JSON.stringify(host)}`);
  if (typeof key !== "string" || key.length === 0) throw new TypeError(`raw tcp tuple key must be a non-empty string, got ${JSON.stringify(key)}`);
  if (!isValidPort(port)) throw new TypeError(`raw tcp tuple port must be an integer 1..65535, got ${JSON.stringify(port)}`);
  return { host, port: Number(port), key };
}
