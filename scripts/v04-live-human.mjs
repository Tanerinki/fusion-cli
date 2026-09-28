// v0.4 live acceptance — the maintainer's answer to a [y/N] question, read from their own terminal. Used by
// scripts/v04-live-acceptance.mjs; pinned by test/v04-live-verdicts.test.ts. It reads one EXPLICIT answer and never makes one up.
//
// The third real run (2026-09-28) stopped L5 at the build's own gate with an empty answer ("[maintainer answered: ]"): the
// shell correctly read it as No. An empty line cannot say whether the maintainer declined or a stray Enter — typed during a
// long model turn and buffered by the terminal — was taken as the answer. So a question now needs an explicit answer.
import { createInterface } from "node:readline";

const EXPLICIT = /^(?:y|yes|n|no)$/iu;

/**
 * Asks `question` on `output` and resolves with the maintainer's explicit answer, exactly as typed (trimmed): y, yes, n or no.
 * - Lines already waiting when the question opens (typed before it was shown) are discarded: after `settleMs`, anything
 *   buffered is dropped and said so, then the question is shown.
 * - An empty or any other line is asked again, `maxAsks` times in all; then the answer is "" — the shell reads that as No.
 * - A closed input is "" (No).
 */
export async function askHuman(input, output, question, { settleMs = 300, maxAsks = 5 } = {}) {
  const reader = createInterface({ input, output });
  const lines = [];
  let waiting, ended = false;
  reader.on("line", line => { if (waiting !== undefined) { const deliver = waiting; waiting = undefined; deliver(line); } else lines.push(line); });
  reader.on("close", () => { ended = true; if (waiting !== undefined) { const deliver = waiting; waiting = undefined; deliver(null); } });
  const next = () => lines.length > 0 ? Promise.resolve(lines.shift()) : ended ? Promise.resolve(null) : new Promise(resolve => { waiting = resolve; });
  try {
    await new Promise(resolve => setTimeout(resolve, settleMs));
    const stale = lines.splice(0).length;
    if (stale > 0) output.write(`\n  (ignored ${stale} line(s) typed before this question)`);
    for (let ask = 0; ask < maxAsks; ask++) {
      output.write(ask === 0 ? question : "\n  >>> Please type y or n and press Enter (an empty line is not an answer): ");
      const line = await next();
      if (line === null) return "";
      const answer = line.trim();
      if (EXPLICIT.test(answer)) return answer;
    }
    return "";
  } finally { reader.close(); }
}
