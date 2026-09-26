#!/usr/bin/env node
import { defaultRegistry } from "../providers/registry.js";
import { EXIT_CODES } from "./failure-presentation.js";
import { createInterruptHandler, runCli } from "./run.js";
import { interactiveTerminal, promptLine } from "./terminal-prompt.js";

/** Executable entry point: wires the process to the CLI function and the real provider registry. */
const interrupts = createInterruptHandler(text => { process.stderr.write(text); }, () => process.exit(EXIT_CODES.cancelled));
process.on("SIGINT", interrupts.interrupt);
process.exitCode = await runCli(process.argv.slice(2),
  { stdout: text => { process.stdout.write(text); }, stderr: text => { process.stderr.write(text); },
    interactive: interactiveTerminal(), prompt: promptLine },
  { env: process.env, cwd: process.cwd(), signal: interrupts.signal, registry: defaultRegistry() });
