/** Provider output is untrusted: duplicate keys and unbounded nesting are rejected, never resolved last-wins. */
export type StrictJsonFailure = "invalidJson" | "tooDeep" | "duplicateKey";

export class StrictJsonError extends Error {
  constructor(readonly reason: StrictJsonFailure) {
    super(`JSON rejected: ${reason}`);
    this.name = "StrictJsonError";
  }
}

export const DEFAULT_MAX_JSON_DEPTH = 64;

interface Frame { readonly object: boolean; readonly keys: Set<string> | null; expectKey: boolean }

/** Iterative scan of already-valid JSON text; never recurses, so hostile nesting cannot exhaust the stack. */
function scanStructure(text: string, maxDepth: number): void {
  const stack: Frame[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === 0x22) { // string
      const start = i + 1;
      let escaped = false;
      i = start;
      while (i < text.length) {
        const d = text.charCodeAt(i);
        if (d === 0x5c) { escaped = true; i += 2; continue; }
        if (d === 0x22) break;
        i += 1;
      }
      const frame = stack[stack.length - 1];
      if (frame?.object && frame.expectKey) {
        const raw = text.slice(start, i);
        const key = escaped ? JSON.parse(`"${raw}"`) as string : raw;
        if (frame.keys!.has(key)) throw new StrictJsonError("duplicateKey");
        frame.keys!.add(key);
        frame.expectKey = false;
      }
      i += 1;
      continue;
    }
    if (c === 0x7b || c === 0x5b) { // { [
      if (stack.length >= maxDepth) throw new StrictJsonError("tooDeep");
      const object = c === 0x7b;
      stack.push({ object, keys: object ? new Set() : null, expectKey: object });
    } else if (c === 0x7d || c === 0x5d) { // } ]
      stack.pop();
    } else if (c === 0x2c) { // ,
      const frame = stack[stack.length - 1];
      if (frame?.object) frame.expectKey = true;
    }
    i += 1;
  }
}

/** JSON.parse plus duplicate-key and nesting-depth rejection. */
export function parseStrictJson(text: string, maxDepth = DEFAULT_MAX_JSON_DEPTH): unknown {
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) throw new RangeError("maxDepth must be a positive safe integer");
  let value: unknown;
  try { value = JSON.parse(text) as unknown; }
  catch { throw new StrictJsonError("invalidJson"); }
  scanStructure(text, maxDepth);
  return value;
}
