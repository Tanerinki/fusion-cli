import { DEFAULT_MAX_JSON_DEPTH, parseStrictJson, StrictJsonError } from "./strict-json.js";

export class JsonlError extends Error {
  constructor(
    readonly lineNumber: number,
    readonly reason: "invalidUtf8" | "invalidJson" | "lineTooLong" | "tooDeep" | "duplicateKey",
  ) {
    super(`JSONL ${reason} at line ${lineNumber}`);
    this.name = "JsonlError";
  }
}

/** Incremental UTF-8 JSONL framing. Consumers validate provider event schemas separately. */
export class JsonlDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private pending = "";
  private pendingBytes = 0;
  private lineNumber = 0;
  private finished = false;

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly maxLineBytes = 1_048_576,
    private readonly onObserverFailure?: () => void,
    private readonly maxDepth = DEFAULT_MAX_JSON_DEPTH,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
    }
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError("maxDepth must be a positive safe integer");
    }
  }

  push(chunk: Uint8Array): void {
    if (this.finished) throw new Error("JSONL decoder is finished");
    let text: string;
    try {
      text = this.decoder.decode(chunk, { stream: true });
    } catch {
      throw new JsonlError(this.lineNumber + 1, "invalidUtf8");
    }
    this.accept(text);
  }

  finish(): void {
    if (this.finished) return;
    this.finished = true;
    let text: string;
    try {
      text = this.decoder.decode();
    } catch {
      throw new JsonlError(this.lineNumber + 1, "invalidUtf8");
    }
    this.accept(text);
    const last = this.pending;
    this.pending = "";
    this.pendingBytes = 0;
    if (last.length > 0) this.emitLine(last);
  }

  /** Linear in input size: only new text is scanned and pending bytes are counted incrementally. */
  private accept(text: string): void {
    let start = 0;
    let newline: number;
    while ((newline = text.indexOf("\n", start)) !== -1) {
      const line = this.pending + text.slice(start, newline);
      this.pending = "";
      this.pendingBytes = 0;
      start = newline + 1;
      this.emitLine(line);
    }
    if (start < text.length) {
      const rest = text.slice(start);
      this.pending += rest;
      this.pendingBytes += Buffer.byteLength(rest, "utf8");
    }
    if (this.pendingBytes > this.maxLineBytes) {
      throw new JsonlError(this.lineNumber + 1, "lineTooLong");
    }
  }

  private emitLine(raw: string): void {
    this.lineNumber += 1;
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (Buffer.byteLength(line, "utf8") > this.maxLineBytes) {
      throw new JsonlError(this.lineNumber, "lineTooLong");
    }
    if (line.length === 0) return;
    let value: unknown;
    try {
      value = parseStrictJson(line, this.maxDepth);
    } catch (error) {
      throw new JsonlError(this.lineNumber, error instanceof StrictJsonError ? error.reason : "invalidJson");
    }
    try { this.onValue(value); }
    catch (error) {
      if (this.onObserverFailure === undefined) throw error;
      this.onObserverFailure();
    }
  }
}
