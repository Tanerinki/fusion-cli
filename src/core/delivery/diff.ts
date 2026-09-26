/**
 * O5.5C2 — a bounded, line-based unified diff (Myers) for `fusion inspect-delivery`: what a human reads before approving.
 * Pure: it only compares two texts. Bounds keep it cheap and never partial without saying so: more than `MAX_DIFF_LINES`
 * lines on a side or more than `MAX_DIFF_EDITS` edits yields `tooLarge`; the rendered output stops at `MAX_RENDERED_LINES`.
 */
export const MAX_DIFF_LINES = 5_000;
export const MAX_DIFF_EDITS = 2_000;
export const MAX_RENDERED_LINES = 400;
type Edit = Readonly<{ op: " " | "-" | "+"; line: string }>;

/** Splits a text into lines; a final newline ends the last line rather than starting an empty one. */
export function textLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines.map(line => line.endsWith("\r") ? line.slice(0, -1) : line);
}

/** The shortest edit script from `a` to `b`, or `undefined` beyond the edit bound. */
export function lineEdits(a: readonly string[], b: readonly string[], maxEdits = MAX_DIFF_EDITS): Edit[] | undefined {
  const n = a.length, m = b.length, max = n + m, offset = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    if (d > maxEdits) return undefined;
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? v[offset + k + 1]! : v[offset + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) { x++; y++; }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, a, b, offset);
    }
  }
  return undefined;
}
function backtrack(trace: readonly Int32Array[], a: readonly string[], b: readonly string[], offset: number): Edit[] {
  const edits: Edit[] = [];
  let x = a.length, y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d]!, k = x - y;
    const prevK = k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!) ? k + 1 : k - 1;
    const prevX = v[offset + prevK]!, prevY = prevX - prevK;
    while (x > prevX && y > prevY) { edits.push({ op: " ", line: a[x - 1]! }); x--; y--; }
    if (d > 0) {
      if (x === prevX) edits.push({ op: "+", line: b[y - 1]! }); else edits.push({ op: "-", line: a[x - 1]! });
      x = prevX; y = prevY;
    }
  }
  return edits.reverse();
}

export type RenderedDiff = Readonly<{ status: "rendered"; lines: readonly string[]; truncated: boolean }> | Readonly<{ status: "tooLarge" }>;
/**
 * A unified diff of `before` → `after` (`null`: the file is absent on that side) with `context` lines around each change,
 * headed by `--- a/<path>` / `+++ b/<path>` (or `/dev/null`).
 */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): RenderedDiff {
  const a = before === null ? [] : textLines(before), b = after === null ? [] : textLines(after);
  if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return { status: "tooLarge" };
  const edits = lineEdits(a, b);
  if (edits === undefined) return { status: "tooLarge" };
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ ${after === null ? "/dev/null" : `b/${path}`}`];
  // Positions (1-based) of each edit in a and b, then hunks of changes merged when their contexts touch.
  const positions: Array<{ edit: Edit; ai: number; bi: number }> = [];
  let ai = 0, bi = 0;
  for (const edit of edits) {
    positions.push({ edit, ai, bi });
    if (edit.op !== "+") ai++;
    if (edit.op !== "-") bi++;
  }
  const changed = positions.flatMap((p, index) => p.edit.op === " " ? [] : [index]);
  let i = 0;
  while (i < changed.length) {
    const start = Math.max(0, changed[i]! - context);
    let end = changed[i]!;
    while (i + 1 < changed.length && changed[i + 1]! - end <= 2 * context) end = changed[++i]!;
    const stop = Math.min(positions.length - 1, end + context);
    const slice = positions.slice(start, stop + 1);
    const aLen = slice.filter(p => p.edit.op !== "+").length, bLen = slice.filter(p => p.edit.op !== "-").length;
    const aStart = aLen === 0 ? slice[0]!.ai : slice[0]!.ai + 1, bStart = bLen === 0 ? slice[0]!.bi : slice[0]!.bi + 1;
    out.push(`@@ -${aStart},${aLen} +${bStart},${bLen} @@`);
    for (const p of slice) out.push(`${p.edit.op}${p.edit.line}`);
    i++;
  }
  const truncated = out.length > MAX_RENDERED_LINES;
  return { status: "rendered", lines: Object.freeze(truncated ? out.slice(0, MAX_RENDERED_LINES) : out), truncated };
}
