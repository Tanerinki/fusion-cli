import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  inspectLease, isRunClaimed, LeaseLostError, RunAlreadyClaimedError, RunLease,
} from "../src/platform/durability/lease.js";

async function withTemp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "fusion-lease-"));
  try { return await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("v0.6 lease: a first writer acquires; a second concurrent writer is refused RUN_ALREADY_CLAIMED", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    const first = await RunLease.acquire(path);
    await assert.rejects(() => RunLease.acquire(path), (e: unknown) => e instanceof RunAlreadyClaimedError && e.recoveryState === "RUN_ALREADY_CLAIMED");
    assert.equal(await isRunClaimed(path), true);
    await first.release();
    assert.equal(await isRunClaimed(path), false);
  });
});

test("v0.6 lease: ownership is bound to a nonce, not a PID (a same-PID re-acquire while fresh is refused)", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    const a = await RunLease.acquire(path);
    const owner = await inspectLease(path);
    assert.equal(owner!.pid, process.pid);
    // Same process (same PID) must still be refused while the lease is fresh — identity is the nonce.
    await assert.rejects(() => RunLease.acquire(path), (e: unknown) => e instanceof RunAlreadyClaimedError);
    await a.release();
  });
});

test("v0.6 lease: a stale lease may be taken over; a fresh one may not", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    let clock = 1_000_000;
    const now = () => clock;
    await RunLease.acquire(path, { ttlMs: 1_000, now });
    // Still fresh: refused.
    await assert.rejects(() => RunLease.acquire(path, { ttlMs: 1_000, now }), (e: unknown) => e instanceof RunAlreadyClaimedError);
    // Advance past the TTL: the owner is presumed gone, takeover succeeds.
    clock += 5_000;
    const taker = await RunLease.acquire(path, { ttlMs: 1_000, now });
    assert.ok(await taker.stillOwns());
  });
});

test("v0.6 lease: FENCING — a revived old owner detects it lost the lease and must stop", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    let clock = 2_000_000;
    const now = () => clock;
    const old = await RunLease.acquire(path, { ttlMs: 1_000, now });
    clock += 5_000;
    const taker = await RunLease.acquire(path, { ttlMs: 1_000, now }); // stale takeover
    assert.ok(await taker.stillOwns());
    assert.equal(await old.stillOwns(), false);
    // The old owner, if it wakes and tries to renew (i.e. proceed), must be fenced off — never a second writer.
    await assert.rejects(() => old.renew(now), (e: unknown) => e instanceof LeaseLostError);
  });
});

test("v0.6 lease: renew refreshes the heartbeat and keeps ownership while held", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    let clock = 3_000_000;
    const now = () => clock;
    const lease = await RunLease.acquire(path, { ttlMs: 1_000, now });
    clock += 800;
    await lease.renew(now);
    assert.ok(await lease.stillOwns());
    assert.equal(await isRunClaimed(path, { ttlMs: 1_000, now }), true); // renewed, still fresh
  });
});

test("v0.6 lease: release only removes a lease we still own (never steals)", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    let clock = 4_000_000;
    const now = () => clock;
    const old = await RunLease.acquire(path, { ttlMs: 1_000, now });
    clock += 5_000;
    const taker = await RunLease.acquire(path, { ttlMs: 1_000, now });
    await old.release(); // old no longer owns it; must NOT delete the taker's lease
    assert.ok(await taker.stillOwns(), "the taker's lease survives the old owner's release");
  });
});

test("v0.6 lease: inspectLease never claims and returns null when unclaimed", async () => {
  await withTemp(async dir => {
    const path = join(dir, "run.lock");
    assert.equal(await inspectLease(path), null);
    assert.equal(await isRunClaimed(path), false);
  });
});
