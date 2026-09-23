import { open } from "node:fs/promises";

export class BoundedReadError extends Error {
  constructor(readonly reason: "notRegularFile" | "tooLarge") {
    super(reason === "tooLarge" ? "file exceeds its read limit" : "path is not a regular file");
    this.name = "BoundedReadError";
  }
}

/**
 * Reads at most `maxBytes` from an opened regular file. The limit is enforced on the bytes actually read,
 * so a file that grows between the size check and the read cannot force an unbounded allocation.
 * Filesystem errors such as ENOENT propagate unchanged for the caller to classify.
 */
export async function readBoundedFile(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError("maxBytes must be a non-negative safe integer");
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new BoundedReadError("notRegularFile");
    if (info.size > maxBytes) throw new BoundedReadError("tooLarge");
    const bytes = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset > maxBytes) throw new BoundedReadError("tooLarge");
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
