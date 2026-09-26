// The task of the v0.1 live `create` acceptance (scripts/v01-live-acceptance.mjs), FULLY specified so the Lead has nothing
// left to ask: a disposable library with an exact input contract, output format and examples. Only this acceptance uses it;
// `fusion create` itself is unchanged and still stops for a decision whenever a description leaves one open.
// One line (the text becomes the project description and the build task).

export const LIVE_CREATE_NAME = "live-durations";

/** Every example the specification requires, as [seconds, exact output]. */
export const LIVE_CREATE_EXAMPLES = Object.freeze([
  [0, "0s"], [5, "5s"], [60, "1m"], [65, "1m 5s"], [3600, "1h"], [3900, "1h 5m"], [3930, "1h 5m 30s"], [7205, "2h 5s"], [90061, "25h 1m 1s"],
].map(entry => Object.freeze(entry)));

export const LIVE_CREATE_DESCRIPTION = [
  "a small dependency-free TypeScript library that exports formatDuration(seconds: number): string.",
  "Input contract: seconds must be a finite, non-negative integer; negative, fractional, NaN, Infinity and -Infinity input must throw a RangeError.",
  "Format with the units h, m and s only; hours may exceed 24 and days are never introduced.",
  "Omit zero-valued units, except that zero seconds returns exactly \"0s\"; separate the emitted units with exactly one ASCII space.",
  `Required examples: ${LIVE_CREATE_EXAMPLES.map(([seconds, text]) => `${seconds} -> "${text}"`).join(", ")}.`,
  "Keep Node.js 22.18+ with native TypeScript type stripping and the stock node:test runner; add tests under test/ for every behavior above,",
  "including each example and each invalid input; add no dependencies.",
].join(" ");
