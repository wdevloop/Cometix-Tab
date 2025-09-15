# Requirements Document

## Introduction

This feature addresses critical issues in the completion system where file
upload timing causes 404 errors and performance problems affect user experience.
The system currently has misaligned request ordering where completion requests
are sent before referenced files are uploaded, causing server-side failures.
Additionally, excessive debouncing and context collection overhead significantly
delays completion display.

## Terminology and Modes

- **Content Mode**: Completion requests that include file contents directly in
  the request body
- **File Reference Mode**: Completion requests that reference files by path,
  requiring prior file sync
- **additionalFiles**: Array of file references beyond the current file
- **FS Upload/Sync**: File system upload/synchronization operations before
  completion requests
- **TTFT/TTFD**: Time To First Token / Time To First Display
- **MIN_REQUEST_INTERVAL**: Minimum 200ms interval between completion requests

## Non-Goals and Compatibility

- No protocol structure changes
- No new business logic branches
- Only reorder sequence and converge parameters
- Maintain backward compatibility
- Preserve existing authentication mechanisms

**Cancellation and Preemption:**
- WHEN new input arrives or cursor jumps THEN the system SHALL immediately cancel in-flight FS and streamCpp operations (soft cancellation, close SSE)
- WHEN processing requests for same document and cursor position THEN the system SHALL NOT allow concurrent completion requests (deduplicate by docId+pos)

## Observability and Rollback

- Mandatory telemetry points for monitoring
- Gradual rollout switches
- Clear rollback procedures

**Configuration and Feature Flags:**
- completion.MAX_CTX_FILES=3 (hot-reloadable configuration)
- completion.debugOutput=false (enable only for gradual rollout)
- completion.enableSmartGating=false (read-only flag for observation, SHALL NOT change behavior)

**Metrics and Logging Architecture:**
- Events: fs_upload_started/finished, completion_triggered, completion_stream_started/ended, completion_cancelled
- Fields: fs_batch_id, fs_completed/total, mode, ttft_ms, ttfd_ms, ctx_collect_ms, fs_wait_ms, dedup_hits, sse_start_ts
- PII Minimization: SHALL NOT log source code content or full paths, only hashes and relative path segments

## Requirements

### Requirement 1

**User Story:** As a developer using the completion system, I want file
references to be properly uploaded before completion requests are sent, so that
I don't encounter 404 errors when using multi-file completions.

#### Acceptance Criteria

**Preconditions:**

1. WHEN additionalFiles.length > 0 THEN the system SHALL enter file reference
   mode
2. WHEN in file reference mode THEN contents field SHALL NOT appear in request
   body
3. WHEN additionalFiles exist THEN the system SHALL complete upload/sync for
   (currentFile ∪ additionalFiles) before proceeding

**Postconditions:** 4. WHEN all FS operations return 2xx responses THEN the
system SHALL send streamCpp request 5. WHEN sending streamCpp THEN request body
SHALL contain rely_on_filesync=true and additional_files

**Timeout and Retry:** 
6. WHEN uploading single file THEN timeout threshold SHALL be 5 seconds
7. WHEN timeout or retryable error occurs THEN the system SHALL retry 2 times with backoff delays of 0.5s and 1.5s
8. WHEN determining retry eligibility THEN only 5xx errors and network timeouts SHALL be retried, 4xx errors SHALL NOT be retried

**Failure Handling:** 
8. WHEN FS upload fails THEN the system SHALL short-circuit completion request and return diagnostic error code
9. WHEN handling failures THEN the system SHALL NOT send incomplete requests
10. WHEN providing diagnostics THEN the system SHALL use diagnostic codes: FS_TIMEOUT, FS_4XX, FS_5XX, FS_CANCELLED
11. WHEN reporting to UI THEN the interface SHALL receive diagnostic.code and fs_batch_id for troubleshooting
12. WHEN handling failures THEN the system SHALL NOT degrade to content mode with implicit retry

**Concurrency and Deduplication:** 
10. WHEN uploading files THEN concurrent FS uploads SHALL be limited to ≤6 per batch (not global limit)
11. WHEN deduplicating THEN the system SHALL use "workspaceId:path:sha256" key and reuse in-flight requests for same key without starting duplicate requests

**Logging:** 12. WHEN processing requests THEN the system SHALL log fs_batch_id,
fs_completed_count/total, cmode, refmode, sse_start_ts

### Requirement 2

**User Story:** As a developer, I want completion suggestions to appear quickly
after typing, so that my coding flow is not interrupted by long delays.

#### Acceptance Criteria

1. WHEN a completion is triggered THEN the system SHALL remove adaptive
   debouncing delays
2. WHEN collecting context THEN the system SHALL limit multi-file context to
   maximum 3 files instead of 8
3. WHEN making completion requests THEN the system SHALL disable debug output to
   reduce overhead
4. WHEN determining trigger conditions THEN the system SHALL use only basic
   position checks without additional smart gating
5. WHEN rate limiting THEN MIN_REQUEST_INTERVAL SHALL apply per editor instance, not shared across tabs

**Performance Budget:**
6. WHEN measuring Time To First Token (TTFT) THEN p95 SHALL be ≤ 150ms in same project with good local network
7. WHEN measuring Time To First Display (TTFD) THEN p95 SHALL be ≤ 250ms in same project with good local network
8. WHEN comparing before/after A/B testing THEN TTFD p95 SHALL decrease by ≥ 20%

### Requirement 3

**User Story:** As a developer, I want the completion system to trigger as
frequently as Cursor Tab, so that I have consistent completion availability
across different scenarios.

#### Acceptance Criteria

1. WHEN typing in the editor THEN the system SHALL trigger completions using
   basic shouldTriggerCompletionBasic checks only
2. WHEN evaluating trigger conditions THEN the system SHALL skip additional
   smart edit gating logic
3. WHEN comparing to Cursor Tab behavior THEN the system SHALL achieve similar
   trigger frequency
4. WHEN maintaining existing safeguards THEN shouldTriggerCompletionBasic SHALL preserve minimum character count and line-end boundary checks, prohibiting any additional gating

### Requirement 4

**User Story:** As a developer, I want the system to maintain proper
authentication and protocol compliance, so that security and compatibility are
preserved during the fixes.

#### Acceptance Criteria

1. WHEN uploading files THEN the system SHALL maintain existing x-fs-client-key
   and FilesyncCookie authentication
2. WHEN making requests THEN the system SHALL not modify existing protocol
   structures
3. WHEN implementing fixes THEN the system SHALL reuse existing pendingUploads
   deduplication logic
4. WHEN handling file sync THEN the system SHALL preserve current FS
   transmission layer settings

### Requirement 5

**User Story:** As a developer, I want to verify that the fixes work correctly,
so that I can confirm the issues are resolved.

#### Acceptance Criteria

1. WHEN using multi-file references THEN the system SHALL not produce 404 errors
2. WHEN monitoring logs THEN successful FS 2xx responses SHALL be visible before
   completion stream initiation
3. WHEN measuring performance THEN first display time SHALL be reduced compared
   to current implementation
4. WHEN counting triggers THEN trigger frequency SHALL increase to match Cursor
   Tab levels
5. WHEN testing the system THEN all existing functionality SHALL continue to
   work without regression

**Quantified Acceptance Thresholds:**
6. WHEN measuring 404 error rate THEN it SHALL equal 0 with sample size ≥200 multi-file scenarios, 95% confidence upper bound < 1.5%
7. WHEN comparing trigger rates THEN SHALL achieve ≥ 0.9× Cursor Tab baseline (same dataset, same editing mode)
8. WHEN running regression tests THEN content mode, reference mode, and failure short-circuit end-to-end test suites SHALL pass
