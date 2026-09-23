export class JsonlError extends Error {
  constructor(
    readonly lineNumber: number,
    readonly reason: "invalidUtf8" | "invalidJson" | "lineTooLong",
  ) {
    super(`JSONL ${reason} at line ${lineNumber}`);
    this.name = "JsonlError";
  }
}

/** Incremental UTF-8 JSONL framing. Consumers validate provider event schemas separately. */
export class JsonlDecoder {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  private pending = "";
  private lineNumber = 0;
  private finished = false;

  constructor(
    private readonly onValue: (value: unknown) => void,
    private readonly maxLineBytes = 1_048_576,
    private readonly onObserverFailure?: () => void,
  ) {
    if (!Number.isSafeInteger(maxLineBytes) || maxLineBytes < 1) {
      throw new RangeError("maxLineBytes must be a positive safe integer");
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
    if (this.pending.length > 0) this.emitLine(this.pending);
    this.pending = "";
  }

  private accept(text: string): void {
    this.pending += text;
    let newline: number;
    while ((newline = this.pending.indexOf("\n")) !== -1) {
      const line = this.pending.slice(0, newline);
      this.pending = this.pending.slice(newline + 1);
      this.emitLine(line);
    }
    if (Buffer.byteLength(this.pending, "utf8") > this.maxLineBytes) {
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
      value = JSON.parse(line) as unknown;
    } catch {
      throw new JsonlError(this.lineNumber, "invalidJson");
    }
    try { this.onValue(value); }
    catch (error) {
      if (this.onObserverFailure === undefined) throw error;
      this.onObserverFailure();
    }
  }
}
