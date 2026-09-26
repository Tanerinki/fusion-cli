#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { defaultRegistry } from "../providers/registry.js";
import { EXIT_CODES } from "./failure-presentation.js";
import { createInterruptHandler, runCli } from "./run.js";

/** One line from the human at the terminal; `null` on Ctrl+C or end of input. Nothing is answered by default. */
async function promptLine(question: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const cancel = new AbortController();
  rl.on("SIGINT", () => { cancel.abort(); });
  const closed = new Promise<null>(resolve => { rl.once("close", () => { resolve(null); }); });
  try { return await Promise.race([rl.question(question, { signal: cancel.signal }), closed]); }
  catch { return null; }
  finally { rl.close(); }
}

/** Executable entry point: wires the process to the CLI function and the real provider registry. */
const interrupts = createInterruptHandler(text => { process.stderr.write(text); }, () => process.exit(EXIT_CODES.cancelled));
process.on("SIGINT", interrupts.interrupt);
process.exitCode = await runCli(process.argv.slice(2),
  { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true, prompt: promptLine },
  { env: process.env, cwd: process.cwd(), signal: interrupts.signal, registry: defaultRegistry() });
