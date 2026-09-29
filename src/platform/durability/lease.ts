import { randomBytes } from "node:crypto";
import { open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { canonicalJson } from "../../core/delivery/canonical.js";
import { FusionFailure } from "../../core/errors.js";
import type { RecoveryState } from "../../core/durability/states.js";

/**
 * v0.6 — the SINGLE-WRITER LEASE (§29, §30). Two Fusion processes must not mutate the same run at once. Ownership is
 * bound to a random per-execution-instance NONCE, never a bare PID (PIDs are reused). The lease file records the nonce, a
 * PID (diagnostic only) and a heartbeat the owner renews. A second writer that finds a FRESH lease is refused with
 * `RUN_ALREADY_CLAIMED`. A STALE lease (heartbeat older than the TTL) may be taken over — but only by compare-and-swap on
 * the on-disk nonce, and a revived old owner detects on its next renew that the on-disk nonce is no longer its own and
 * must stop (FENCING): this is what prevents two live writers after a takeover. Read-only inspection never claims.
 *
 * This is a single-machine mechanism. It does not defend against a wall clock moved backwards, or an owner frozen past
 * the TTL and then resumed mid-write (the fence stops it before its NEXT journal step, not mid-syscall). Documented, not
 * hidden.
 */
export const LEASE_SCHEMA_VERSION = 1 as const;
export const DEFAULT_LEASE_TTL_MS = 30_000;
const NONCE = /^[0-9a-f]{32}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export interface LeaseRecord {
  readonly schemaVersion: typeof LEASE_SCHEMA_VERSION;
  readonly nonce: string;
  readonly pid: number;
  readonly acquiredAt: string;
  readonly heartbeatAt: string;
}

export class RunAlreadyClaimedError extends FusionFailure {
  constructor(readonly recoveryState: Extract<RecoveryState, "RUN_ALREADY_CLAIMED">, readonly owner: LeaseRecord) {
    super({ kind: "WorkspaceConflict", retryable: false, safeMessage: "This run is already claimed by another writer; nothing was changed." });
    this.name = "RunAlreadyClaimedError";
  }
}
/** The owner lost its lease to a takeover (its fence check failed). It must stop before any further mutation. */
export class LeaseLostError extends FusionFailure {
  constructor() {
    super({ kind: "WorkspaceConflict", retryable: false, safeMessage: "This writer's run lease was taken over; it must stop." });
    this.name = "LeaseLostError";
  }
}

const LEASE_KEYS = ["schemaVersion", "nonce", "pid", "acquiredAt", "heartbeatAt"];
function parseLease(text: string): LeaseRecord | null {
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  const r = value as Record<string, unknown> | null;
  if (r === null || typeof r !== "object" || Array.isArray(r) || Object.keys(r).length !== LEASE_KEYS.length ||
      !LEASE_KEYS.every(k => Object.hasOwn(r, k)) || r.schemaVersion !== LEASE_SCHEMA_VERSION ||
      typeof r.nonce !== "string" || !NONCE.test(r.nonce) || !Number.isSafeInteger(r.pid) ||
      typeof r.acquiredAt !== "string" || !ISO.test(r.acquiredAt) || typeof r.heartbeatAt !== "string" || !ISO.test(r.heartbeatAt))
    return null;
  return Object.freeze({ schemaVersion: LEASE_SCHEMA_VERSION, nonce: r.nonce, pid: r.pid as number, acquiredAt: r.acquiredAt, heartbeatAt: r.heartbeatAt });
}

/** Reads the current lease owner (or `null` when unclaimed / unreadable-as-lease). Never claims. */
export async function inspectLease(path: string): Promise<LeaseRecord | null> {
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text === undefined ? null : parseLease(text);
}

const isStale = (lease: LeaseRecord, ttlMs: number, now: number): boolean => now - Date.parse(lease.heartbeatAt) > ttlMs;

/**
 * A held single-writer lease. `acquire` takes it (exclusive create, or a stale takeover by CAS). `renew` refreshes the
 * heartbeat AND fences: if the on-disk nonce is no longer ours, we lost the lease and must stop (`LeaseLostError`).
 * `release` removes the lease only if we still own it.
 */
export class RunLease {
  #heartbeatAt: string;
  private constructor(readonly path: string, readonly nonce: string, readonly ttlMs: number, acquiredAt: string) {
    this.#heartbeatAt = acquiredAt;
  }

  static async acquire(path: string, options: Readonly<{ ttlMs?: number; now?: () => number }> = {}): Promise<RunLease> {
    const ttlMs = options.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    const now = options.now ?? Date.now;
    const nonce = randomBytes(16).toString("hex");
    const at = new Date(now()).toISOString();
    const record: LeaseRecord = { schemaVersion: LEASE_SCHEMA_VERSION, nonce, pid: process.pid, acquiredAt: at, heartbeatAt: at };
    const body = canonicalJson({ ...record });
    // Fast path: no lease exists — exclusive create.
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(body, "utf8"); await handle.sync(); } finally { await handle.close(); }
      return new RunLease(path, nonce, ttlMs, at);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    // A lease exists. Refuse if fresh; take over by CAS if stale.
    const existing = await inspectLease(path);
    if (existing !== null && !isStale(existing, ttlMs, now()))
      throw new RunAlreadyClaimedError("RUN_ALREADY_CLAIMED", existing);
    // Stale (or unreadable) lease: overwrite, then re-read to confirm WE won the race (CAS on nonce).
    await writeFile(path, body, { encoding: "utf8", mode: 0o600 });
    const confirmed = await inspectLease(path);
    if (confirmed === null || confirmed.nonce !== nonce) {
      // Another writer took it in the same window; do not steal an active run.
      throw new RunAlreadyClaimedError("RUN_ALREADY_CLAIMED", confirmed ?? existing ?? record);
    }
    return new RunLease(path, nonce, ttlMs, at);
  }

  /** Refreshes the heartbeat and FENCES: throws `LeaseLostError` if the on-disk nonce is no longer ours. */
  async renew(now: () => number = Date.now): Promise<void> {
    const current = await inspectLease(this.path);
    if (current === null || current.nonce !== this.nonce) throw new LeaseLostError();
    const at = new Date(now()).toISOString();
    const record: LeaseRecord = { schemaVersion: LEASE_SCHEMA_VERSION, nonce: this.nonce, pid: process.pid, acquiredAt: current.acquiredAt, heartbeatAt: at };
    await writeFile(this.path, canonicalJson({ ...record }), { encoding: "utf8", mode: 0o600 });
    this.#heartbeatAt = at;
  }

  /** Whether this instance still owns the on-disk lease (a read-only fence check). */
  async stillOwns(): Promise<boolean> {
    const current = await inspectLease(this.path);
    return current !== null && current.nonce === this.nonce;
  }

  get heartbeatAt(): string { return this.#heartbeatAt; }

  /** Releases the lease only if we still own it (never deletes another writer's lease). */
  async release(): Promise<void> {
    if (await this.stillOwns()) await rm(this.path, { force: true }).catch(() => undefined);
  }
}

/** Whether a lease file currently names a fresh (still-owned) writer. */
export async function isRunClaimed(path: string, options: Readonly<{ ttlMs?: number; now?: () => number }> = {}): Promise<boolean> {
  const lease = await inspectLease(path);
  if (lease === null) return false;
  await stat(path).catch(() => undefined);
  return !isStale(lease, options.ttlMs ?? DEFAULT_LEASE_TTL_MS, (options.now ?? Date.now)());
}
