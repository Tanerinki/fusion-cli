// Fusion v0.6 Hyper-V PoC - BOM-tolerant JSON reading (defense in depth). Producers MUST write BOM-free UTF-8, but a
// stray leading U+FEFF (e.g. from a PowerShell 5.1 `Out-File -Encoding utf8`) must never crash a consumer with
// "Unexpected token '﻿'". stripBom removes exactly ONE leading BOM; readJsonFile parses a file after stripping it.
import { readFileSync } from "node:fs";

/** Removes exactly one leading UTF-8 BOM (U+FEFF) from a string, if present. */
export function stripBom(text) {
  return (typeof text === "string" && text.charCodeAt(0) === 0xfeff) ? text.slice(1) : text;
}

/** Reads a UTF-8 JSON file, tolerating one leading BOM, and parses it (throws on malformed JSON - fail closed). */
export function readJsonFile(path) {
  return JSON.parse(stripBom(readFileSync(path, "utf8")));
}
