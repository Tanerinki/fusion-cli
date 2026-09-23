# O5.5B3 verification confinement proof contract

## Purpose

Verification currently runs a native process without OS confinement (see [o5-5b-writer-isolation.md](o5-5b-writer-isolation.md)). A future isolation backend will run a small helper that probes its own confinement and reports what it observed. This milestone defines only the Fusion side: the result the helper must produce, how Fusion validates it, and what "complete" means. No backend, helper, native code or OS sandbox exists yet. The code lives in `src/platform/verification/confinement-proof.ts`, and no production module imports it.

## Proof states

Each fact has exactly one state:

| State | Meaning |
| --- | --- |
| `observedPass` | The helper probed the fact and it held. |
| `observedFail` | The helper probed the fact and it did not hold. |
| `notObserved` | The helper did not probe the fact. This is never a pass. |

Protocol version 1 requires all ten facts: `grantedReadWorks`, `grantedWriteWorks`, `ungrantedReadDenied`, `ungrantedWriteDenied`, `profileIsolation`, `registryIsolation`, `networkIsolation`, `descendantContainment`, `timeoutEnforced` and `cleanupComplete`. The two granted-access facts are positive controls: a sandbox that denies everything passes the denial facts trivially, so it must also prove that granted access works.

## Protocol contract

The helper writes one JSON object:

```json
{
  "protocolVersion": 1,
  "backend": "example-backend",
  "helperSha256": "<64 lowercase hex>",
  "platform": "win32-x64",
  "observedAt": "2026-09-23T12:00:00.000Z",
  "observations": [
    { "fact": "grantedReadWorks", "state": "observedPass", "attempts": 2, "failures": 0 }
  ]
}
```

- **Closed.** No extra properties are allowed at any level. No field can hold free text, so the result cannot carry an environment dump, source code, paths or credentials.
- **Bounded.** The whole output is at most 4096 UTF-8 bytes and at most 3 levels of nesting. `backend` is at most 32 characters in lowercase-hyphen form. `attempts` is from 0 to 64 and `failures` is from 0 to `attempts`. There are exactly ten observations, one per fact.
- **Strict enums.** `fact`, `state` and `platform` are closed sets. `helperSha256` is lowercase hex. `observedAt` must be in the exact `toISOString` UTC form and must be a real calendar date.
- **Versioned.** The protocol version is checked first. Any other integer version is refused as unsupported (`ProtocolError`) before its shape is judged. Any other defect is `MalformedOutput`.
- **Strict JSON.** A duplicate key is rejected as a contradiction, not resolved last-wins. Input is detached with `structuredClone` before validation, so getters and proxies cannot reach the validator.
- **Consistent.** `notObserved` requires 0 attempts. `observedPass` requires at least one attempt and no failure. `observedFail` requires a failure. A fact reported twice is rejected, even when both reports agree. A contradiction is `MalformedOutput`.

`decodeConfinementProof(text)` applies the byte and depth limits and strict JSON parsing, then calls `validateConfinementProof(value)`. Validated proofs are frozen and list their observations in canonical fact order.

## What complete means

`evaluateConfinementProof(proof, expectation)` validates the proof again and compares it with what the host pinned before it launched the helper: backend, helper SHA-256, platform, and a host-clock window for the run. The host must hash the helper executable itself. The hash in the result only binds the result to that helper. An `observedAt` outside the window is treated as stale, replayed or future. The evaluator does not read the clock.

A proof is **complete** only when all ten facts are `observedPass` and none of the identity fields mismatch. The evaluation lists passed, failed and not-observed facts and identity mismatches separately, so one defect cannot hide another.

A complete proof is not production readiness. `productionEligible` is the constant `false`. `writerReadiness()` and `REAL_WRITER_MODE_PREREQUISITES`, including `verificationIsolation`, are unchanged. No proof can open verification isolation or the real Writer gate in this release.

## Fake backend is test-only

`test/fixtures/fake-confinement-backend.ts` generates results for any scenario without observing anything. A complete fake proof shows that the contract works. It does not show confinement. The fixture is compiled only as a test file. A test asserts that no file under `src/` imports it or names it, and that no production module imports the proof contract yet.

## No real confinement backend exists yet

This milestone adds no native code, AppContainer or other sandbox API, ACL change, registry, credential or network access, provider call or Writer wiring. Verification isolation, real Writer mode and O5.5B readiness remain **NO**. Remaining work:

- build a real helper and backend that produce this contract
- decide how Fusion pins and launches the helper
- prove the facts under the actual verifier launch posture
- decide deliberately whether a complete proof from a reviewed backend may ever satisfy the `verificationIsolation` prerequisite
