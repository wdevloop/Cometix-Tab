## Design: Completion System Fix (FS-before-completion, performance, triggers)

### Goals
- Ensure file reference mode never sends completion requests before all referenced files are synchronized (eliminate 404s).
- Reduce TTFT/TTFD via fixed 200ms per-editor request rate limiting, lean context collection, and streaming JSON.
- Increase trigger frequency by using only basic trigger checks while preserving safeguards.
- Maintain protocol/auth compatibility, privacy constraints, and provide observability for rollout and rollback.

### Non-Goals
- No protocol structure changes or server-side logic changes.
- No new auth mechanisms.
- No automatic fallback from reference mode to content mode on FS failures.

### Glossary
- Content Mode: No `additionalFiles`; `contents` in body, skip FS sync.
- File Reference Mode: `additionalFiles.length > 0`; no `contents`, requires prior FS sync.
- Completion Stream: SSE from `streamCpp`.
- FS Service: File synchronization service; reuses existing transport/auth.
- `pendingUploads`: Dedup registry for in-flight file uploads.

## Architecture Overview
- Editor → Completion Controller → (optional) FS Upload Batch → `streamCpp` SSE → UI render
- Cross-cutting: Cancellation, Deduplication, Telemetry, Configuration, Security/Privacy

### Components
- Completion Controller (orchestrator)
  - Decides mode (content/reference) based on `additionalFiles`.
  - Manages per-editor `MIN_REQUEST_INTERVAL` gating (200ms) and dedup by `docId+position`.
  - Sequences FS upload batch before `streamCpp` in reference mode.
  - Cancels in-flight FS/SSE on input change or cursor jump.
- FS Upload Manager
  - Accepts a batch: `(currentFile ∪ additionalFiles)`.
  - Enforces per-file timeout (5s), retries (up to 2) with backoff `[0.5s, 1.5s]`, follows ≤3 redirects.
  - Concurrency limit ≤6 per batch.
  - Uses `pendingUploads` registry keyed by `workspaceId:relativePath:sha256` with TTL 30s to reuse in-flight uploads.
  - Atomic batch cancellation.
- Telemetry/Logging
  - Mandatory events, shared `request_id`, PII-minimized structured logs, 1:100 sampling where high-frequency.
- Config/Flags
  - Hot-reloadable limits, timeouts, concurrency, and rollout controls.

## Request Lifecycles

### Content Mode (no additional files)
1. Trigger: `completion_triggered` with `request_id`, `mode=content`.
2. Dedup check: `docId+position` key prevents concurrent duplicate requests.
3. Rate limit: ensure ≥200ms since last request for this editor.
4. Collect context (cap 50KB; see below), include `contents` in body.
5. Start SSE: `completion_stream_started` with `sse_start_ts`.
6. Stream tokens; compute `ttft_ms` at first byte.
7. End SSE: `completion_stream_ended` with `ttfd_ms` computed by UI and attached.
8. Cancellation at any step emits `completion_cancelled`.

### File Reference Mode (`additionalFiles.length > 0`)
1. Trigger: `completion_triggered` with `request_id`, `mode=reference`.
2. Dedup + per-editor 200ms gating as above.
3. Build FS batch: `(currentFile ∪ additionalFiles)` unique set.
4. Emit `fs_upload_started` with `fs_batch_id`, `fs_total_count`.
5. For each file in batch (concurrency ≤6):
   - Dedup via `pendingUploads` key `workspaceId:relativePath:sha256` (reuse in-flight; do not start duplicate).
   - Upload with 5s timeout; retry up to 2 on timeout/5xx using delays `[0.5s, 1.5s]`; follow ≤3 redirects.
   - Do not retry 4xx; map errors to diagnostic codes.
6. On success for all files, emit `fs_upload_finished` with `fs_completed_count`, `fs_wait_ms`.
7. Send `streamCpp` request with body containing `rely_on_filesync=true` and `additional_files` array; do not include `contents`.
8. Start SSE and proceed as in content mode.
9. If any upload fails after retries: cancel entire request; surface diagnostic with `code` and `fs_batch_id`; emit `completion_cancelled`.

## Detailed Algorithms

### Mode Determination and Triggering
- Mode: `reference` if `additionalFiles.length > 0`; else `content`.
- Triggering: use only `shouldTriggerCompletionBasic` (preserve ≥2 chars after whitespace, line-end boundary, post-operator triggers: `.`, `->`, `::`).
- Remove adaptive debounce; enforce `MIN_REQUEST_INTERVAL = 200ms` per editor instance (tab).
- Deduplicate by `docId+position` hash to avoid concurrent duplicate requests.

### Context Collection (Performance)
- Limit multi-file context to max 3 files.
- Prioritize files: current imports > recent edits > same directory.
- Cap total serialized context size at 50KB across all snippets.
- Disable debug output in production builds.
- Use streaming JSON parsing for SSE.

### FS Upload Batch
- Concurrency per batch: ≤6.
- Per-file timeout: 5000ms.
- Retry policy:
  - Eligible: timeouts, 5xx → up to 2 retries, backoff `[500ms, 1500ms]`.
  - Ineligible: 4xx → do not retry.
  - Redirects: follow up to 3 (3xx).
- Deduplication:
  - Key format: `workspaceId:relativePath:sha256`.
  - `pendingUploads` registry stores in-flight promise/task with expiry TTL 30s.
  - Reuse in-flight request; do not re-start; increment watcher count.
- Cancellation:
  - On input change/cursor jump: abort SSE and all uploads in current `fs_batch_id` atomically.
- Failure mapping (diagnostic.code):
  - FS_TIMEOUT (deadline exceeded), FS_4XX, FS_5XX, FS_CANCELLED, FS_NETWORK (explicit network error).
- On failure after retries: do not fall back to content mode; bubble diagnostic to UI and log with `fs_batch_id`.

### Telemetry and Logging
- Mandatory events (all include `request_id`):
  - `fs_upload_started`: `fs_batch_id`, `fs_total_count`, `mode`.
  - `fs_upload_finished`: `fs_batch_id`, `fs_completed_count`, `fs_total_count`, `fs_wait_ms`.
  - `completion_triggered`: `mode`, `ctx_collect_ms`.
  - `completion_stream_started`: `sse_start_ts`.
  - `completion_stream_ended`: `ttft_ms`, `ttfd_ms`.
  - `completion_cancelled`: `reason` (e.g., input-change, cursor-jump, fs-failure), `error_code` if applicable.
- Required fields (where applicable): `fs_batch_id`, `fs_completed_count`, `fs_total_count`, `mode`, `ttft_ms`, `ttfd_ms`, `ctx_collect_ms`, `fs_wait_ms`, `dedup_hits`, `sse_start_ts`, `error_code`.
- PII minimization: do not log code contents, full paths, or user identifiers. Sanitize paths; prefer hashes and relative segments.
- Sampling: high-frequency events sampled 1:100 in production.
- Retention: performance metrics 30d; error logs 90d.

### Configuration (hot-reloadable)
```ini
completion.MAX_CTX_FILES=3
completion.debugOutput=false
completion.enableSmartGating=false
completion.fsUploadTimeout=5000
completion.fsMaxRetries=2
completion.fsMaxConcurrent=6
```

- Scope: per-editor `MIN_REQUEST_INTERVAL = 200ms` (code constant; not shared across tabs).
- Feature flags govern rollout; no behavior change for `enableSmartGating` (read-only observation only).

### Protocol & Security Compliance
- Do not modify request structures.
- Reference mode request body:
  - Must include `rely_on_filesync=true`.
  - Must include `additional_files` array (relative paths; sanitized in logs).
  - Must not include `contents`.
- Content mode request body:
  - Must include `contents`.
  - Must not include `additional_files`.
- Authentication: include existing `x-fs-client-key` header and preserve `FilesyncCookie`; respect workspace isolation.
- Encryption in transit; no additional plaintext logging.

## Rollout Plan
- Phase 1 (Week 1–2): FS-before-completion sequencing
  - Implement batch upload sequencing, retries/backoff, dedup, cancellation, diagnostics.
  - Release behind feature flag at 5% traffic; monitor 404 and error codes; ensure no fallback to content mode.
- Phase 2 (Week 2–3): Performance optimization
  - Fixed 200ms per-editor rate limit; cap context (3 files, 50KB), disable debug, streaming JSON.
  - Gradual rollout to 25%; validate TTFT/TTFD improvements.
- Phase 3 (Week 3–4): Trigger enhancement
  - Use only basic trigger checks; preserve safeguards; A/B vs baseline.
  - Full rollout upon positive metrics; instant rollback via flag if error rate spikes > 2%.

## Testing Strategy
- Unit tests
  - Mode selection (content vs reference) based on `additionalFiles`.
  - Dedup by `docId+position`; per-editor rate limit enforcement at 200ms.
  - FS retry matrix (timeouts, 5xx retried; 4xx not retried; redirect follow ≤3).
  - Concurrency limit ≤6 verified.
  - `pendingUploads` reuse and TTL expiry behavior.
  - Failure mapping to diagnostic codes.
- Integration tests
  - Content mode E2E; reference mode E2E with multiple files.
  - Ensure `rely_on_filesync=true` and `additional_files` present in reference mode; no `contents`.
  - Ensure `contents` present in content mode; no `additional_files`.
  - Cancellation mid-upload and mid-SSE closes all resources and emits `completion_cancelled`.
- Performance tests
  - Measure TTFT p50/p95/p99 ≤ 100/150/300ms; TTFD p50/p95/p99 ≤ 150/250/500ms (good local network, same project).
  - A/B shows ≥15% TTFT p95 and ≥20% TTFD p95 improvements.
- Verification
  - 404 rate 0% for multi-file (n≥200; 95% CI upper bound < 1.5%).
  - Trigger frequency ≥ 0.9× Cursor Tab baseline; false positive rate < 5%.
  - Content/reference/failure short-circuit/edge tests all pass.

## Risks & Mitigations
- Increased server load: limit concurrency per batch; maintain 200ms per-editor gating; staged rollout.
- Regression in edge cases: comprehensive unit/integration/e2e coverage; fast rollback.
- Network latency variability: retries with capped backoff; observability on FS wait and stream timings.

## Implementation Notes & Integration Points
- Orchestrator integration: hook into existing completion pipeline within `src/core` (controller layer) without changing protocol or server APIs.
- Reuse existing FS transport/auth; wrap with timeout, retry, redirect handling, and dedup registry.
- Ensure correlation: generate `request_id` at trigger; `fs_batch_id` per batch; propagate to all events.
- Sanitize and hash paths in logs; never include source contents.

## Appendix A: Pseudocode (high-level)
```typescript
function requestCompletion(params: {
  editorId: string;
  docId: string;
  position: number;
  currentFile: FileRef;
  additionalFiles: FileRef[];
  contents?: string; // only for content mode
}): CancellationHandle {
  const requestId = generateRequestId();
  emit('completion_triggered', { request_id: requestId, mode: modeOf(params) });

  if (!shouldTriggerCompletionBasic(params)) return cancel('gating');
  if (!perEditorRateLimit(editorId, 200)) return cancel('rate_limit');
  if (dedupeInFlight(docId, position)) return cancel('dedup');

  const controller = new AbortController();

  if (isReferenceMode(params)) {
    const fsBatchId = generateBatchId();
    emit('fs_upload_started', { request_id: requestId, fs_batch_id: fsBatchId, fs_total_count: batchSize });

    const result = await uploadBatch({
      files: union(currentFile, additionalFiles),
      fsBatchId,
      signal: controller.signal,
    });

    if (!result.ok) {
      emit('completion_cancelled', { request_id: requestId, error_code: result.diagnosticCode });
      return cancel('fs-failure');
    }

    emit('fs_upload_finished', { request_id: requestId, fs_batch_id: fsBatchId, fs_completed_count, fs_total_count, fs_wait_ms });

    return startStream({
      body: { rely_on_filesync: true, additional_files: additionalFiles },
      headers: authHeaders(),
      requestId,
      controller,
    });
  } else {
    return startStream({
      body: { contents: params.contents },
      headers: authHeaders(),
      requestId,
      controller,
    });
  }
}
```

```typescript
async function uploadBatch({ files, fsBatchId, signal }): Promise<{ ok: boolean; diagnosticCode?: string }> {
  const queue = new PQueue({ concurrency: 6 });
  let failed: { code: string } | null = null;

  await Promise.all(files.map(file => queue.add(() => uploadOne(file, fsBatchId, signal).catch(err => {
    failed = { code: mapToDiagnostic(err) };
    throw err;
  })))).catch(() => {});

  if (failed) return { ok: false, diagnosticCode: failed.code };
  return { ok: true };
}
```

```typescript
async function uploadOne(file, fsBatchId, signal) {
  const key = `${workspaceId}:${file.relativePath}:${file.sha256}`;
  return pendingUploads.use(key, 30_000, async () => {
    return retry(2, [500, 1500], async (attempt) => {
      const response = await fetchWithTimeout(fileUploadUrl(file), { timeout: 5000, redirect: 'follow-3', headers: authHeaders(), signal });
      if (response.ok) return;
      if (response.status >= 500) throw new RetryableError('FS_5XX');
      if (response.status >= 400) throw new NonRetryableError('FS_4XX');
      throw new RetryableError('FS_NETWORK');
    });
  });
}
```

## Appendix B: Sequence Diagrams (text)

### Reference Mode
- Editor types → Controller triggers (request_id R) → FS batch (fs_batch_id B) started → uploads (≤6 concurrent, dedup via `pendingUploads`) → all 2xx → FS finished → `streamCpp` with `rely_on_filesync=true` and `additional_files` → SSE started (`sse_start_ts`) → tokens → SSE ended.
- On input change: controller aborts both FS batch B and SSE; emit `completion_cancelled`.

### Content Mode
- Editor types → Controller triggers (request_id R) → `streamCpp` with `contents` → SSE started → tokens → SSE ended. 