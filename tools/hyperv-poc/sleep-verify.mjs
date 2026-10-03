// Fusion v0.6 PoC - a verifier that hangs, used ONLY to prove the isolated-verification timeout gate works live. The
// canary launches it with a short timeoutMs; the worker must terminate it and report ran.timedOut=true with no exit
// code - a hung verifier can never stall the host harness or masquerade as a pass.
const until = Date.now() + 10 * 60 * 1000;
while (Date.now() < until) { /* busy-ish wait, but mostly blocked */ Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); }
console.log("should-never-print");
