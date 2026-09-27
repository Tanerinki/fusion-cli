// Test-only helpers of the scripted fake provider binaries (claude-fake.mjs, muse-fake.mjs). Never used in production.
import { closeSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

/**
 * v0.3: claims the scripted turn this process serves — atomically, with an exclusive-create marker per turn — so concurrent
 * processes of one role (parallel investigations) never take the same turn. A turn with `when` is taken only by a prompt that
 * contains that text, so parallel turns take their own scripted replies in any order; turns without `when` are taken in order
 * (the O5.5B12 behaviour). Returns -1 when no turn is left for this prompt.
 */
export async function claimTurn(scriptPath, turns, prompt) {
  for (let index = 0; index < turns.length; index++) {
    if (typeof turns[index].when === "string" && !prompt.includes(turns[index].when)) continue;
    try { closeSync(openSync(`${scriptPath}.claim-${index}`, "wx")); return index; }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  return -1;
}

/**
 * v0.3: a mechanical proof of concurrency. The turn waits until `count` turns of its barrier `name` have arrived — which only
 * happens when that many provider processes run at the same time — and exits with 44 when its timeout passes first.
 */
export async function barrier(scriptPath, { name, count, timeoutMs = 15_000 }, n) {
  const directory = dirname(scriptPath), prefix = `${basename(scriptPath)}.barrier-${name}-`;
  writeFileSync(`${scriptPath}.barrier-${name}-${n}`, String(process.pid));
  const deadline = Date.now() + timeoutMs;
  while (readdirSync(directory).filter(file => file.startsWith(prefix)).length < count) {
    if (Date.now() > deadline) process.exit(44);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}
