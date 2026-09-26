import { createInterface } from "node:readline/promises";

/** Whether a human is at an interactive terminal: stdin and stdout are both TTYs. */
export const interactiveTerminal = (): boolean => process.stdin.isTTY === true && process.stdout.isTTY === true;

/** One line typed by the human at the terminal; `null` on Ctrl+C or end of input. Nothing is ever answered by default. */
export async function promptLine(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const cancel = new AbortController();
  rl.on("SIGINT", () => { cancel.abort(); });
  const closed = new Promise<null>(resolve => { rl.once("close", () => { resolve(null); }); });
  try { return await Promise.race([rl.question(question, { signal: cancel.signal }), closed]); }
  catch { return null; }
  finally { rl.close(); }
}
