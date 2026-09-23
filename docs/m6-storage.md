# M6 local run storage

M6 provides persistence primitives for later workflows. It does not connect provider adapters automatically, run verification, or retain full conversations. Callers create a `RunStore`, append typed evidence to its `EventStore`, store explicit artifacts, and write optional local metrics. Ordinary tests use temporary repositories and fake process data; they never call Claude or Muse.

## Layout and ownership

```text
<repo>/.fusion/runs/<run-id>/
  run.json
  events.jsonl
  metrics.json                 (only after an explicit metrics write)
  artifacts/
    index.jsonl               (created when ArtifactStore opens)
    text|json|jsonl|binary|copiedFile/<artifact-id>.<extension>
  providers/
  verification/
  findings/
```

`.fusion/` is ignored by Git: since M7, `RunStore.create` writes `.fusion/.gitignore` (`*`) when absent, so any repository ignores Fusion storage without Fusion editing a user-owned ignore file. No retention or automatic deletion runs in M6. IDs consist of a sortable millisecond timestamp prefix plus 128 random bits. The run ID remains opaque to workflows. `run.json` carries version 1, a hash of the resolved repository path, runtime identity, status, and optional workflow, binding, capability, termination, verification, and artifact references. Optional facts are omitted until known.

## Write and read contracts

`EventStore.append` serializes calls in one Fusion process, including calls through separately opened store instances. It appends exactly one UTF-8 JSON object and newline, then fsyncs the file. Events have a schema version, ID, run ID, sequence, timestamp, stable provider-neutral type, source, and discriminated payload. `readEvents()` streams records; `listEvents(limit)` is bounded. Complete lines before a crash remain readable. An incomplete final line is returned as a `TruncatedFinalLine` diagnostic, while malformed complete lines and invalid sequence or payloads fail. Reopening for append rejects a truncated log. M6 does not repair a log.

`RunStore.updateManifest` serializes writes in one process and uses a temporary file, fsync/close, and rename over `run.json`. The old manifest is never removed first. Run initialization creates the run directory and manifest before the other paths; a crash during initialization can leave an incomplete run that requires inspection. Windows rename may fail if another process holds the destination open, in which case the previous manifest remains and the error is reported.

`ArtifactStore` creates Fusion-owned destination names and rejects absolute, traversal, alternate-separator, control, trailing-dot/space, and Windows device-name paths. It supports bounded text, JSON, JSONL, byte buffers, and streamed file copying with SHA-256 and byte-size metadata in `artifacts/index.jsonl`. A copied source must initially be a regular file; the destination and category are checked as real files/directories. An ordinary index failure removes a newly written blob. A crash between blob rename and index append can leave an unindexed orphan; a partial index line is treated as corruption. No automatic cleanup or repair runs in M6. `getArtifactPath` returns a validated path; callers should read it promptly because the filesystem could change after the check.

M6.1 maps artifact serialization and filesystem failures to typed `ArtifactError` outcomes while retaining the original cause. JSON and JSONL reject circular and BigInt values instead of exposing raw JavaScript exceptions. A streamed copy checks its byte limit during transfer, including when the source grows after the initial size check, and removes its partial destination on failure.

All top-level records use `schemaVersion: 1`. Readers reject future versions with `UnsupportedSchema`. M6 has no migration logic. Within-process queues provide serialization, but there is no cross-process lock or transaction spanning manifest, events, metrics, and artifact index. A separate process or actor changing paths concurrently can still create a filesystem race, particularly on Windows where Node cannot open a source with a no-follow reparse-point flag. The symlink regression test skips on Windows accounts without symlink creation permission; runtime `lstat` checks still execute.

## Persistence safety

Provider and process events use explicit evidence DTOs. Projection before append copies only approved fields and applies the existing `DiagnosticRedactor` to relevant strings. It drops raw auth responses, account identity, headers, environment maps, argv values, stdout/stderr, and full paths. Process evidence retains executable basename and path hash, option names and positional count, cwd hash, timing, exit/cancellation/cleanup data, truncation flags, and optional artifact references. Requested and observed models remain separate. Provider usage and `estimatedListCostUsd` are optional; the latter is a list-price estimate, never actual subscription billing.

Text and JSON artifacts redact known secrets; JSON and JSONL reject raw environment, auth, header, cookie, message, conversation, and transcript keys. Binary buffers and copied files are explicit caller inputs and cannot be meaningfully text-redacted. Callers must pass only approved non-secret binary material or separately redact a stream before asking the store to copy it. The default path does not capture provider streams or full transcripts.

The provider evidence projection also preserves normalized generic subscription quota telemetry when supplied: tier, observation time, rolling-window percentage/reset/duration, and weekly percentage/reset. It never copies raw account identity or provider-specific quota payloads. Missing subscription data remains missing. Redaction covers known secrets and token assignments embedded in free text or URL query strings, as well as Bearer values.

`LocalRunMetrics` supports observed outcome, workflow/risk, wall time, provider counts, retries, takeovers, verification failures, human interventions, findings, context transfer, tokens, and list-price estimate. Aggregation sums only observed numeric samples; absent values remain absent. `metricsFromEvents` derives only fields supported by current event types and assumes one `ProviderObserved` event per provider run when counting runs. Metrics are evidence for later analysis, never routing authority. NaN and infinite samples are rejected.

In-process write queues for manifests, events, and artifact indexes release their bookkeeping after the last queued operation settles. Reopening an intact event log after a transient append failure rescans its sequence before writing again.

M7 may consume these APIs to record workspace leases and verification, but those behaviors are outside M6.
